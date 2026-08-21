// The only module in this connector that spawns a process. Everything else is
// pure or takes an SfCli. Keeping `child_process` here is what lets the rest of
// the connector be tested without a process and keeps the dependency out of any
// module the webview could reach.
import { execFile } from "child_process";
import { resolveBin } from "../../engine/pr/which";
import { markTaskNetworkFailure } from "../provider";
import { classifySfFailure } from "./errors";

export const SF_TIMEOUT_MS = 60_000;

/** What one `sf` invocation produced. Unlike the forge seam's `Runner`, a
 *  non-zero exit is a RESOLVED result, not a rejection: `sf --json` prints its
 *  error envelope to stdout and still exits non-zero, and that envelope is the
 *  only place the Salesforce error code appears. Rejection is reserved for "the
 *  process never ran". */
export interface SfResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type SfRunner = (
  file: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
) => Promise<SfResult>;

export const execSfRunner: SfRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = { stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" };
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;

        // A timeout is not a complaint from `sf` — there is no envelope to read,
        // and the seam wants it marked as network-origin (spec §12). execFile
        // reports it with `killed: true`, so surface it as ETIMEDOUT for exec()
        // to mark. Checked FIRST: a killed process may also carry a numeric code.
        if (e?.killed) {
          reject(Object.assign(new Error("The Salesforce CLI timed out."), { code: "ETIMEDOUT" }));
          return;
        }

        // A spawn failure carries a STRING code ("ENOENT"); a non-zero exit
        // carries a NUMBER (the exit status). Only the former means the process
        // never ran, so only the former rejects — the latter's stdout is the
        // error envelope we need.
        if (e && typeof e.code === "string") {
          reject(e);
          return;
        }
        resolve({ ...out, code: err ? 1 : 0 });
      },
    );
  });

/** The `sf` CLI is not on this machine, or not where we can find it. Its own
 *  class so `probe()` can name the install step instead of showing a raw spawn
 *  error. `name` is a literal: esbuild minifies class identifiers. */
export class SfMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SfMissingError";
  }
}

/** One field, as `sf sobject describe` reports it. Only `name` is read — the
 *  connector asks "does this field exist", never "what type is it". */
export interface SfDescribeResult {
  name: string;
  fields: { name: string }[];
}

interface SfEnvelope<T> {
  status?: unknown;
  result?: T;
}

export class SfCli {
  constructor(
    private readonly targetOrg: string,
    private readonly run: SfRunner = execSfRunner,
    private readonly locate: () => string | null = () => resolveBin("sf"),
  ) {}

  /** Whether the binary is locatable. Deliberately uncached, like resolveBin
   *  itself: an `npm i -g @salesforce/cli` mid-session should start working. */
  installed(): boolean {
    return this.locate() !== null;
  }

  async query<T>(soql: string): Promise<T[]> {
    const res = await this.exec<{ records?: T[] }>(["data", "query", "--query", soql]);
    return res.records ?? [];
  }

  describe(object: string): Promise<SfDescribeResult> {
    return this.exec<SfDescribeResult>(["sobject", "describe", "--sobject", object]);
  }

  async userInfo(): Promise<{ username: string; id: string }> {
    const r = await this.exec<{ username?: unknown; id?: unknown }>(["org", "display", "user"]);
    return {
      username: typeof r.username === "string" ? r.username : "",
      id: typeof r.id === "string" ? r.id : "",
    };
  }

  /** Locate, spawn, unwrap. `--json` is appended here rather than by each caller
   *  so no call site can forget it and get human-formatted output. */
  private async exec<T>(base: string[]): Promise<T> {
    const bin = this.locate();
    if (!bin) {
      throw new SfMissingError("The Salesforce CLI (sf) was not found on your PATH.");
    }

    const args = [...base, "--json"];
    if (this.targetOrg) args.push("--target-org", this.targetOrg);

    let res: SfResult;
    try {
      res = await this.run(bin, args, { cwd: process.cwd(), timeoutMs: SF_TIMEOUT_MS });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new SfMissingError(`Could not run ${bin}. Is the Salesforce CLI installed?`);
      }
      throw markTaskNetworkFailure(
        err instanceof Error ? err : new Error(String(e)),
        err.code === "ETIMEDOUT" ? "ETIMEDOUT" : "ENOTFOUND",
      );
    }

    if (res.code !== 0) {
      throw classifySfFailure(res.stdout, res.stderr.trim() || `sf ${base[0]} failed.`);
    }

    let parsed: SfEnvelope<T>;
    try {
      parsed = JSON.parse(res.stdout) as SfEnvelope<T>;
    } catch {
      throw classifySfFailure(res.stdout, "The Salesforce CLI returned output we could not read.");
    }
    if (parsed.result === undefined) {
      throw classifySfFailure(res.stdout, "The Salesforce CLI returned no result.");
    }
    return parsed.result;
  }
}
