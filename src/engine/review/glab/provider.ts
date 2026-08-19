// The GitLab review strip's provider: the queue, one row's detail, and the only
// command in Agent Flow that writes to someone else's merge request.
import * as os from "os";
import { ReviewDetail, ReviewRequest, ReviewVerb } from "../../../types";
import { countUnresolvedDiscussions, mapJobs } from "../../pr/glab/mr";
import { GLAB_FIELD_FLAG, GLAB_TIMEOUT_MS } from "../../pr/glab/provider";
import { execRunner } from "../../pr/provider";
import type { Locate, Runner } from "../../pr/provider";
import { resolveBin } from "../../pr/which";
// `import type`, load-bearing: `test/unit/deckView.test.ts` mocks this module with
// a non-spreading factory returning only `GhReviewProvider`, so a VALUE import of
// `ReviewProvider` from here would resolve to `undefined` under that mock.
import type { ReviewProvider } from "../provider";
import { mapPipelineStatus, parseMrSearch, REVIEW_MR_PATH } from "./search";

const locateGlab: Locate = () => resolveBin("glab");

/** A project path as one url path segment. GitLab's project-scoped routes take the
 * full nested path url-encoded, so `group/sub/proj` becomes `group%2Fsub%2Fproj`. */
const enc = (repo: string): string => encodeURIComponent(repo);

/** Every call here is project-independent in the same sense the GitHub provider's
 * are: an MR requesting your review may live in a project you have never cloned,
 * so the path carries the target and the home directory is only somewhere that
 * exists for `glab` to run in. */
export class GlabReviewProvider implements ReviewProvider {
  constructor(
    private readonly run: Runner = execRunner,
    private readonly locate: Locate = locateGlab,
  ) {}

  private exec(args: string[]): Promise<string> {
    return this.run(this.locate() ?? "glab", args, { cwd: os.homedir(), timeoutMs: GLAB_TIMEOUT_MS });
  }

  private get(path: string): Promise<string> {
    return this.exec(["api", path]);
  }

  private post(path: string, field?: string): Promise<string> {
    const args = ["api", path, "--method", "POST"];
    if (field !== undefined) args.push(GLAB_FIELD_FLAG, field);
    return this.exec(args);
  }

  /** Null means the attempt failed — never "you owe nobody a review". The caller
   * keeps its cached list and flags it stale rather than emptying the strip. */
  async search(): Promise<{ issueCount: number; requests: ReviewRequest[] } | null> {
    try {
      return parseMrSearch(JSON.parse(await this.get(REVIEW_MR_PATH)) as unknown);
    } catch {
      return null;
    }
  }

  /** The four things the queue call cannot return: which jobs failed, the pipeline
   * verdict itself, how many discussions are still open, and the diff size. A
   * failure in either of the last two degrades to `null` rather than discarding
   * what we did get.
   *
   * The verdict is filled here rather than in `search` because `head_pipeline`
   * exists ONLY on this single-MR route — GitLab's MR list carries no pipeline field
   * at all — and making this GET per queue row would be 50 extra calls per refresh.
   * So the chip reads "none" until the row is expanded, exactly as the size chip
   * does. `status` is `unknown` for the same reason `changes_count` is: only
   * `mapPipelineStatus` decides what a status string means. */
  async detail(repo: string, number: number): Promise<ReviewDetail | null> {
    // `changes_count` is `unknown` because only `readSize` knows what to make of
    // it: GitLab sends a STRING there, and caps it ("20+") past twenty.
    let mr: { head_pipeline?: { id?: number; status?: unknown } | null; changes_count?: unknown };
    try {
      mr = JSON.parse(await this.get(`projects/${enc(repo)}/merge_requests/${number}`)) as typeof mr;
    } catch {
      return null;
    }

    let failing: ReviewDetail["failing"] = [];
    const pipelineId = mr.head_pipeline?.id;
    if (typeof pipelineId === "number") {
      try {
        const jobs = JSON.parse(await this.get(`projects/${enc(repo)}/pipelines/${pipelineId}/jobs?per_page=100`));
        failing = mapJobs(Array.isArray(jobs) ? jobs : null).failing;
      } catch {
        failing = [];
      }
    }

    let unresolved: number | null = null;
    try {
      const path = `projects/${enc(repo)}/merge_requests/${number}/discussions?per_page=100`;
      unresolved = countUnresolvedDiscussions(JSON.parse(await this.get(path)));
    } catch {
      unresolved = null;
    }

    return {
      failing,
      unresolved,
      size: readSize(mr.changes_count),
      ci: mapPipelineStatus(typeof mr.head_pipeline?.status === "string" ? mr.head_pipeline.status : null),
    };
  }

  /** The only command here that writes to GitLab. The caller confirms first; this
   * only refuses what GitLab would refuse anyway, and reports the rejection —
   * GitLab's own wording is more useful than ours.
   *
   * `verb` is not to be trusted just because the type says `ReviewVerb`:
   * `Object.hasOwn` — not a truthiness check, which a prototype key like
   * `"constructor"` would sail through — fails closed before a single argv is
   * built. `body` likewise arrives from a webview message, untyped at runtime:
   * a plain `typeof` guard, not `String(body ?? "")`, because `String({})` is
   * `"[object Object]"` — a truthy, postable string that would land on someone
   * else's MR instead of being refused as empty.
   *
   * `request-changes` is the one verb whose meaning differs by forge: GitLab has
   * no stable REST equivalent, so it becomes a note plus a withdrawal of any
   * standing approval. `deckView` discloses that in the confirmation dialog. */
  async submit(
    repo: string, number: number, verb: ReviewVerb, body: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const VERBS: Record<ReviewVerb, true> = { approve: true, comment: true, "request-changes": true };
    if (!Object.hasOwn(VERBS, verb)) return { ok: false, message: `Unknown review verb: ${String(verb)}` };
    const text = typeof body === "string" ? body.trim() : "";
    if (verb !== "approve" && !text) {
      return { ok: false, message: "GitLab requires a message for this kind of review." };
    }

    const base = `projects/${enc(repo)}/merge_requests/${number}`;
    // Tracked so a later failure can say the words already made it out, rather
    // than reading as "nothing happened" and inviting a retry that posts the
    // same note twice.
    let noteLanded = false;
    try {
      // The note goes first for every verb that has words: if the state change
      // then fails, the reviewer's text is already on the MR rather than lost.
      if (text) {
        await this.post(`${base}/notes`, `body=${text}`);
        noteLanded = true;
      }
      if (verb === "approve") await this.post(`${base}/approve`);
      if (verb === "request-changes") {
        try {
          await this.post(`${base}/unapprove`);
        } catch (e) {
          // There may be no approval to withdraw, which GitLab answers with an
          // error — that is not a failed review. A killed-by-timeout rejection
          // is different: `glab` may have reached GitLab anyway, so it must
          // surface rather than be read as "nothing to withdraw" — swallowing
          // it would tell the user "changes requested" while their approval
          // silently stands.
          //
          // Admittedly BROADER than that stated reason: this swallows every
          // non-timeout error, so a 403 (no permission to unapprove on this
          // project) is reported to the user as a review that succeeded, with
          // their note posted and no approval withdrawn. Not narrowed because
          // there is nothing reliable to narrow ON — GitLab's wording for
          // "nothing to withdraw" varies by instance version and locale, and
          // matching it by substring would fail closed on the common case the
          // moment an instance rephrased it. The note, which is the substance of
          // the review, has landed either way.
          const err = e as { killed?: boolean; code?: unknown };
          if (err.killed || err.code === "ETIMEDOUT") throw e;
        }
      }
      return { ok: true };
    } catch (e) {
      const err = e as { killed?: boolean; code?: unknown; stderr?: string };
      // A killed-by-timeout rejection has the same shape as any other execFile
      // failure but means something different: `glab` may well have reached GitLab
      // before the clock ran out, so "GitLab refused" would be a flat lie about a
      // write that could have succeeded server-side.
      const reason = err.killed || err.code === "ETIMEDOUT"
        ? `Timed out after ${GLAB_TIMEOUT_MS / 1000}s — the review may already have gone through. Open the merge request to check.`
        // `stderr` is GitLab's actual wording. Never `.message`: execFile's own
        // message is `Command failed: <file> <full argv joined>`, and for a
        // submit that argv carries `-f body=<the whole review text>` — including
        // every line after the body's OWN first newline, because Node appends
        // stderr's text after the message's first newline too, so a real
        // multi-paragraph body (these come from `.pick-task/REVIEW-<n>.md`
        // drafts) leaves everything past its first line looking exactly like
        // "the rest of stderr". There is no safe substring of `.message` to
        // salvage — a missing or blank `stderr` (a killed process typically has
        // none) falls back to a fixed, argv-free string rather than ever
        // touching `.message`.
        : err.stderr?.trim() || "glab failed without further detail — check the merge request directly.";
      if (noteLanded) return { ok: false, message: `Your note was posted, but the review update failed: ${reason}` };
      return { ok: false, message: reason };
    }
  }
}

/** `changes_count` is a string, and GitLab caps it ("20+"). Null when there is no
 * number in it at all: a zero would read as "no files changed", which is a claim,
 * where `null` is an absence. GitLab's REST API exposes no additions/deletions
 * aggregate, so those stay 0.
 *
 * A capped count reads as its FLOOR: "20+" becomes 20, and the strip then renders
 * it like any exact count, so an 80-file MR shows as 20 files. Deliberate — the
 * bucket it lands in is still the largest one, and the alternative (a `null` size
 * for every big MR) would hide the size chip on exactly the rows where it matters
 * most. Documented in docs/FORGES.md. */
function readSize(raw: unknown): ReviewDetail["size"] {
  if (typeof raw !== "string") return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? { additions: 0, deletions: 0, changedFiles: n } : null;
}
