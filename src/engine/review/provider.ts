import * as os from "os";
import { ReviewDetail, ReviewRequest, ReviewVerb } from "../../types";
import { countUnresolved, mapRollup } from "../pr/facts";
import { execRunner, GH_TIMEOUT_MS, Locate, Runner, THREADS_QUERY } from "../pr/provider";
import { resolveBin } from "../pr/which";
import { REVIEW_SEARCH_LIMIT, REVIEW_SEARCH_Q, REVIEW_SEARCH_QUERY, parseSearch } from "./search";

const locateGh: Locate = () => resolveBin("gh");

const VERB_FLAG: Record<ReviewVerb, string> = {
  approve: "--approve",
  comment: "--comment",
  "request-changes": "--request-changes",
};

/** Node's execFile error `.message` is always `Command failed: <file> <full
 * argv joined>`, optionally followed by a `\n` and stderr's own text — for a
 * review submission, that first line embeds the entire `--body <review
 * text>` verbatim. This is the last line of defense against ever returning
 * that: used only when a rejection carries no `stderr` of its own (a killed
 * process, or a `gh` failure that wrote nothing to stderr), it keeps
 * whatever follows the first newline and falls back to a fixed, argv-free
 * string when there is nothing there — never the reconstructed command. */
function stripCommandLine(message: string): string {
  const nl = message.indexOf("\n");
  const rest = nl === -1 ? "" : message.slice(nl + 1).trim();
  return rest || "gh failed without further detail — check the PR directly.";
}

export interface ReviewProvider {
  search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null>;
  detail(repo: string, number: number): Promise<ReviewDetail | null>;
  submit(repo: string, number: number, verb: ReviewVerb, body: string): Promise<{ ok: true } | { ok: false; message: string }>;
}

/** Every call here is repo-independent: a PR requesting your review may live in a
 * repository you have never cloned. `--repo owner/name` carries the target, and
 * the home directory is only somewhere that exists for `gh` to run in. */
export class GhReviewProvider implements ReviewProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateGh,
  ) {}

  private gh(): string {
    return this.locate() ?? "gh";
  }

  private exec(args: string[]): Promise<string> {
    return this.run(this.gh(), args, { cwd: os.homedir(), timeoutMs: GH_TIMEOUT_MS });
  }

  /** Null means the attempt failed — never "you owe nobody a review". The caller
   * keeps its cached list and flags it stale rather than emptying the strip. */
  async search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null> {
    try {
      const out = await this.exec([
        "api", "graphql",
        "-f", `query=${REVIEW_SEARCH_QUERY}`,
        "-f", `q=${REVIEW_SEARCH_Q}`,
        "-F", `n=${REVIEW_SEARCH_LIMIT}`,
      ]);
      return parseSearch(JSON.parse(out) as unknown);
    } catch {
      return null;
    }
  }

  /** The two things the search cannot return: which checks failed, and how many
   * review threads are still open. A thread-call failure degrades to `null`
   * rather than discarding the checks we did get. */
  async detail(repo: string, number: number): Promise<ReviewDetail | null> {
    let failing: ReviewDetail["failing"];
    try {
      const out = await this.exec(["pr", "view", String(number), "--repo", repo, "--json", "statusCheckRollup"]);
      const parsed = JSON.parse(out) as { statusCheckRollup?: Parameters<typeof mapRollup>[0] };
      failing = mapRollup(parsed.statusCheckRollup).failing;
    } catch {
      return null;
    }
    const [owner, name] = repo.split("/");
    let unresolved: number | null = null;
    if (owner && name) {
      try {
        const out = await this.exec([
          "api", "graphql", "-f", `query=${THREADS_QUERY}`,
          "-F", `o=${owner}`, "-F", `r=${name}`, "-F", `n=${number}`,
        ]);
        unresolved = countUnresolved(JSON.parse(out) as unknown);
      } catch {
        unresolved = null;
      }
    }
    return { failing, unresolved };
  }

  /** The only command in Agent Flow that writes to GitHub. The caller confirms
   * first; this only refuses what GitHub would refuse anyway, and reports the
   * rejection — GitHub's own wording is more useful than ours.
   *
   * `body` arrives from a webview message, untyped at runtime regardless of what
   * the TypeScript signature claims — `String(body ?? "")` before `.trim()`
   * keeps a stray `undefined`/`null` from throwing instead of returning the
   * discriminated result this function promises never to skip.
   *
   * `verb` is likewise not to be trusted just because the type says `ReviewVerb`:
   * `Object.hasOwn` (not `!VERB_FLAG[verb]`, which a prototype key like
   * `"constructor"` would sail through as truthy) fails closed on anything
   * outside the union before a single argv is built — the one command that
   * writes to someone else's pull request does not get to guess. */
  async submit(repo: string, number: number, verb: ReviewVerb, body: string): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!Object.hasOwn(VERB_FLAG, verb)) {
      return { ok: false, message: `Unknown review verb: ${String(verb)}` };
    }
    const text = String(body ?? "").trim();
    if (verb !== "approve" && !text) {
      return { ok: false, message: "GitHub requires a message for this kind of review." };
    }
    const args = ["pr", "review", String(number), "--repo", repo, VERB_FLAG[verb]];
    if (text) args.push("--body", text);
    try {
      await this.exec(args);
      return { ok: true };
    } catch (e) {
      // A killed-by-timeout rejection has the exact same shape as any other
      // execFile failure, but means something different: `gh` may well have
      // reached GitHub before the 10s clock ran out, so "GitHub refused" would
      // be a flat lie about a write that could have succeeded server-side.
      const err = e as { killed?: boolean; code?: unknown; stderr?: string };
      if (err.killed || err.code === "ETIMEDOUT") {
        return {
          ok: false,
          message: `Timed out after ${GH_TIMEOUT_MS / 1000}s — the review may already have gone through. Open the PR to check.`,
        };
      }
      // `stderr` — gh's own complaint, attached by execRunner separately from
      // `.message` — is GitHub's actual wording, with none of the reconstructed
      // argv `.message` carries. Prefer it; a killed process (or any other
      // shape) may carry none, so the fallback strips `.message`'s own
      // "Command failed: …" line rather than ever returning it whole — this
      // catch must never return the body, stderr present or not.
      const msg = err.stderr?.trim() || (e instanceof Error ? stripCommandLine(e.message) : String(e));
      return { ok: false, message: msg };
    }
  }
}
