// The Bitbucket write path. Reachable only through the review strip, which
// `caps.reviewSearch: false` currently hides — so nothing in this file runs in a
// Bitbucket install today.
//
// Implemented rather than stubbed anyway: the `Forge` interface requires a
// `ReviewProvider`, and a stub that threw would become a lie the day the strip is
// enabled. Its tests call it directly for the same reason.
import * as os from "os";
import { ReviewDetail, ReviewRequest, ReviewVerb } from "../../../types";
import { apiArgs, BB_BIN, BB_TIMEOUT_MS, probeBbApi } from "../../pr/bb/provider";
import { execRunner, stripCommandLine } from "../../pr/provider";
import type { Locate, Runner } from "../../pr/provider";
import { mapBbStatuses } from "../../pr/bb/rest";
import { resolveBin } from "../../pr/which";
// `import type`, matching `../glab/provider`'s own discipline: a VALUE import of
// an interface-only module would resolve to `undefined` under a non-spreading
// mock factory, and costs nothing here since `ReviewProvider` is a type.
import type { ReviewProvider } from "../provider";

const locateBb: Locate = () => resolveBin(BB_BIN);

/** `"workspace/slug"` split, or null. `ReviewRequest.repo` is `nameWithOwner`
 * across every forge; for Bitbucket that is exactly workspace and slug. */
function splitRepo(repo: string): { workspace: string; slug: string } | null {
  const parts = repo.split("/").filter(Boolean);
  return parts.length === 2 ? { workspace: parts[0], slug: parts[1] } : null;
}

const VERBS: Record<ReviewVerb, true> = { approve: true, comment: true, "request-changes": true };

/** A fixed, argv-free fallback for `stripCommandLine`, matching the one
 * `BbProvider.merge` passes at `src/engine/pr/bb/provider.ts:356` — this is that
 * function's second non-gh caller, and the default fallback names "gh". */
const BB_FALLBACK = `${BB_BIN} failed without further detail — check the pull request directly.`;

export class BbReviewProvider implements ReviewProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateBb,
    private readonly apiMode: () => Promise<boolean> = () => probeBbApi(),
  ) {}

  /** Every call here is repo-independent: a PR requesting your review may live in
   * a repository you have never cloned. The home directory is only somewhere that
   * exists for the CLI to run in. */
  private exec(args: string[]): Promise<string> {
    return this.run(this.locate() ?? BB_BIN, args, { cwd: os.homedir(), timeoutMs: BB_TIMEOUT_MS });
  }

  /** `bb api <path>`, with `atlassian-cli`'s own flags for an HTTP method and a
   * JSON body (`-X`, `-d`). The argv itself is `apiArgs`, shared with
   * `BbProvider` in `src/engine/pr/bb/provider.ts` — only the `cwd` this runs in
   * differs between the two write paths, which is what `exec()` carries. */
  private api(path: string, method?: string, body?: string): Promise<string> {
    return this.exec(apiArgs(path, method, body));
  }

  /** Null, permanently.
   *
   * Bitbucket Cloud has no cross-repo "pull requests where I am a reviewer"
   * query: `GET /2.0/workspaces/{ws}/pullrequests/{user}` is AUTHORED-BY. This is
   * an API limit, so passthrough mode does not fix it — which is why the honest
   * answer is `caps.reviewSearch: false` hiding the strip, rather than this
   * method's null, which by convention means "the attempt failed". Nothing calls
   * this while that flag is false. */
  async search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null> {
    return null;
  }

  /** The two things a queue row cannot show unexpanded. Projected mode has
   * neither: `bb pr diff` is a stub that prints a web url, and there is no
   * failing-checks projection to read. */
  async detail(repo: string, number: number): Promise<ReviewDetail | null> {
    const r = splitRepo(repo);
    if (!r || !(await this.apiMode())) return null;
    const base = `/2.0/repositories/${r.workspace}/${r.slug}/pullrequests/${number}`;
    let failing: ReviewDetail["failing"];
    try {
      failing = mapBbStatuses(JSON.parse(await this.api(`${base}/statuses`)) as unknown).failing;
    } catch {
      return null;
    }
    // The failing-checks list is what this call is really for. `unresolved` is
    // null because Bitbucket has no thread-resolution count on a route this
    // cheap, and `size` is omitted entirely: diff size is a fact about a review
    // QUEUE ROW, and Bitbucket has no review queue in either mode, so there is
    // no row for a `/diffstat` call to fill. docs/FORGES.md's mode table says
    // n/a on that row for exactly this reason — do not add the call without the
    // queue that would show it.
    return { failing, unresolved: null };
  }

  /** The only command here that writes to Bitbucket, along with `BbProvider.merge`
   * — one of only two places Agent Flow writes to a forge. The caller confirms
   * first; this only refuses what Bitbucket would refuse anyway.
   *
   * `verb` is not to be trusted just because the type says `ReviewVerb`:
   * `Object.hasOwn` (not `!VERBS[verb]`, which a prototype key like
   * `"constructor"` would sail through as truthy) fails closed before a single
   * argv is built. `body` likewise arrives from a webview message, untyped at
   * runtime — `String(body ?? "")` keeps a stray null from throwing instead of
   * returning the discriminated result this promises never to skip. */
  async submit(
    repo: string, number: number, verb: ReviewVerb, body: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    if (!Object.hasOwn(VERBS, verb)) return { ok: false, message: `Unknown review verb: ${String(verb)}` };
    const r = splitRepo(repo);
    if (!r) return { ok: false, message: `Not a Bitbucket workspace/repository: ${repo}` };
    const text = String(body ?? "").trim();
    if (verb !== "approve" && !text) {
      return { ok: false, message: "Bitbucket requires a message for this kind of review." };
    }
    const passthrough = await this.apiMode();
    if (verb === "request-changes" && !passthrough) {
      return {
        ok: false,
        message:
          "This build of atlassian-cli has no way to request changes — upgrade to one with `bb api`, " +
          "or use the pull request in your browser.",
      };
    }
    try {
      await this.write(r, number, verb, text, passthrough);
      return { ok: true };
    } catch (e) {
      // A killed-by-timeout rejection has the same shape as any other execFile
      // failure but means something different: the CLI may well have reached
      // Bitbucket before the clock ran out, so "Bitbucket refused" would be a
      // flat lie about a write that could have succeeded server-side.
      const err = e as { killed?: boolean; code?: unknown; stderr?: string };
      if (err.killed || err.code === "ETIMEDOUT") {
        return {
          ok: false,
          message: `Timed out after ${BB_TIMEOUT_MS / 1000}s — the review may already have gone through. Open the pull request to check.`,
        };
      }
      // `stderr` is the CLI's own complaint, attached by `execRunner` separately
      // from `.message`, which is the reconstructed argv — for a comment, that
      // argv embeds the entire review text verbatim. Prefer `stderr`; a killed
      // process typically carries none, so the fallback strips `.message`'s own
      // "Command failed: …" line rather than ever returning it whole. This catch
      // must never return the body.
      const msg = err.stderr?.trim() || (e instanceof Error ? stripCommandLine(e.message, BB_FALLBACK) : String(e));
      return { ok: false, message: msg };
    }
  }

  private async write(
    r: { workspace: string; slug: string }, number: number, verb: ReviewVerb, text: string, passthrough: boolean,
  ): Promise<void> {
    if (!passthrough) {
      const head = ["--workspace", r.workspace, "bb", "pr"];
      const tail = ["--format", "json"];
      // The comment goes FIRST for anything carrying text, exactly as the
      // passthrough path below does — and for a second reason here. An approval
      // with a body used to take the `approve` branch and DROP the text, then
      // return `ok: true`, so the Deck toasted success over a review the user
      // wrote and Bitbucket never received. A user's words are the one thing a
      // success toast must never quietly discard; `bb pr comment` exists in this
      // mode, so there is nothing to degrade to.
      if (text) await this.exec([...head, "comment", r.slug, String(number), "--text", text, ...tail]);
      if (verb === "approve") await this.exec([...head, "approve", r.slug, String(number), ...tail]);
      return;
    }
    const base = `/2.0/repositories/${r.workspace}/${r.slug}/pullrequests/${number}`;
    // The comment goes FIRST for anything carrying reasoning: if the state change
    // then fails, a posted note with no state change is a better outcome than a
    // blocking state with no explanation attached to it.
    if (text) await this.api(`${base}/comments`, "POST", JSON.stringify({ content: { raw: text } }));
    if (verb === "approve") await this.api(`${base}/approve`, "POST");
    else if (verb === "request-changes") await this.api(`${base}/request-changes`, "POST");
  }
}
