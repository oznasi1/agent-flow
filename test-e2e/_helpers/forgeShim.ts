import * as fs from "fs";
import * as path from "path";
import type { Sandbox } from "./sandbox";

/** The three CLIs the product shells for forge facts. `atlassian-cli`, never
 *  `bb`: `bb` is a subcommand alias inside that binary (`src/engine/pr/bb/provider.ts:25-30`),
 *  and `resolveBin(BB_BIN)` looks for the executable by this exact name. */
export type ForgeCli = "gh" | "glab" | "atlassian-cli";

/** One canned answer. `body` is what the shim prints on stdout — a string
 *  verbatim, anything else `JSON.stringify`d, `undefined` as nothing at all.
 *  `stderr` and a non-zero `exit` drive the product's failure paths: `execRunner`
 *  (`src/engine/pr/provider.ts:36-53`) rejects on any non-zero exit and attaches
 *  the shim's stderr to the error, which is the text `submit()`/`merge()` surface
 *  to the user and which `probeGh`/`probeGlab`/`probeBb` read as `signed-out`.
 *
 *  Recognised structurally: a plain object whose keys are all drawn from
 *  `body`/`exit`/`stderr`. A RAW body that happens to look like that (a
 *  `{ body: "…" }` comment object, say) must be wrapped — `{ body: { body: "…" } }`. */
export interface ShimAnswer {
  body?: unknown;
  exit?: number;
  stderr?: string;
}

/** signature → answer. The signature is the leading argv words the shim keys
 *  on — see `signatureOf` for the exact rule per CLI. A string answer is printed
 *  verbatim (every pre-existing caller passes `JSON.stringify(...)`); any other
 *  non-`ShimAnswer` value is serialised as JSON. */
export type ForgeAnswerMap = Record<string, ShimAnswer | unknown>;

export interface ForgeAnswers {
  gh?: ForgeAnswerMap;
  glab?: ForgeAnswerMap;
  "atlassian-cli"?: ForgeAnswerMap;
}

const CLIS: readonly ForgeCli[] = ["gh", "glab", "atlassian-cli"];

const ANSWER_KEYS = new Set(["body", "exit", "stderr"]);

function isShimAnswer(v: unknown): v is ShimAnswer {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => ANSWER_KEYS.has(k));
}

function stdoutOf(body: unknown): string {
  if (body === undefined) return "";
  return typeof body === "string" ? body : JSON.stringify(body);
}

/** How many leading argv words form a signature. `gh`/`glab` verbs are two words
 *  deep (`pr list`, `api graphql`, `api <path>`). `atlassian-cli` needs three:
 *  `bb api --help`, `bb pr list`, `bb pr merge` and `bb pipeline list` all share
 *  `bb_pr`/`bb_api` at two words, and a merge answered with the list's body is
 *  exactly the collision that would let a journey pass against a wrong argv. */
const SIG_WORDS: Record<ForgeCli, number> = { gh: 2, glab: 2, "atlassian-cli": 3 };

/** The mangled signature the `/bin/sh` shim computes for an argv — implemented
 *  once here and mirrored byte-for-byte in the script `installForgeShims` writes.
 *
 *  Rule, per CLI:
 *  - `gh`, `glab`: `"$1_$2"`, then every non-`[A-Za-z0-9]` byte → `_`.
 *  - `atlassian-cli`: first drop every LEADING `--flag value` pair — the product
 *    puts its global options first (`--workspace ws bb pr list …`,
 *    `--workspace ws --repo slug bb pipeline list …`; `src/engine/pr/bb/provider.ts:98-107,382-385`
 *    and `src/engine/review/bb/provider.ts:152-162`), and without the skip every
 *    projected-mode verb would key on `__workspace_ws_bb`. Then `"$1_$2_$3"` of
 *    what remains, mangled the same way. So `bb api --help` → `bb_api___help`,
 *    `--workspace ws bb pr list slug …` → `bb_pr_list`, `bb api /2.0/…` →
 *    `bb_api__2_0_…` (one signature per REST path, as `glab api` already has).
 *
 *  Keys are split on whitespace, so write them as the argv reads: `"bb pr list"`,
 *  not `"bb_pr_list"`. A trailing ` @<dir>` names a PER-CHECKOUT answer — see
 *  `splitCwdKey` — and is stripped before this runs. A key with MORE words than the rule can see is refused —
 *  the shim would never match it, and the journey would discover that only as an
 *  unexplained empty answer.
 *
 *  Mangling is per character, ASCII assumed: the shim's `tr -c` works on bytes,
 *  so a non-ASCII key would produce a different file name than the script looks
 *  for. Nothing the product shells has one. */
export function signatureOf(cli: ForgeCli, key: string): string {
  let words = key.trim().split(/\s+/).filter((w) => w !== "");
  if (cli === "atlassian-cli") {
    while (words.length >= 2 && words[0].startsWith("--")) words = words.slice(2);
  }
  const n = SIG_WORDS[cli];
  if (words.length > n) {
    throw new Error(
      `forgeShim: "${key}" has ${words.length} words but the ${cli} shim keys on the first ${n} ` +
        `(after any leading --flag value pairs for atlassian-cli) — trim the key to "${words.slice(0, n).join(" ")}"`,
    );
  }
  while (words.length < n) words.push("");
  return words.join("_").replace(/[^A-Za-z0-9]/g, "_");
}

/** Install `gh`/`glab`/`atlassian-cli` shims into the sandbox's PATH dir. Each
 *  shim logs its full argv to calls.jsonl, computes its signature (`signatureOf`),
 *  prints the matching `.json` file on stdout, the optional `.stderr` companion
 *  on stderr, and exits with the optional `.exit` companion (default 0).
 *
 *  Anything unmatched is SELF-DISCOVERING: the shim appends the full argv to
 *  unknown.jsonl and exits 0 with an empty JSON array — an empty answer shows
 *  up in the journey's assertions, a crash would not. resolveBin (which.ts)
 *  prefers PATH over its Homebrew fallbacks, so the shim always wins over a
 *  developer's real CLI.
 *
 *  Only `sb.root` is read, so a bare `{ root }` serves for a shell-level check of
 *  the shim itself. All three shims are written even when a CLI has no answers,
 *  so a forge the journey did not configure still lands in unknown.jsonl rather
 *  than reaching a real binary. */
/** `"pr list @telemetry"` → `{ key: "pr list", cwd: "telemetry" }`; a key with no
 *  suffix comes back with `cwd: null`.
 *
 *  Why the shim needs this at all: the signature is argv-only, and the product
 *  runs the SAME argv in every checkout of a run — `gh pr list --head <branch> …`
 *  with only `cwd` differing (`GhProvider.fetch`, `src/engine/pr/provider.ts:126-149`;
 *  `GlabProvider.api`, `src/engine/pr/glab/provider.ts:128-130`). A two-repo card
 *  whose repos must disagree (one PR ready, the sibling's still open) cannot be
 *  built out of argv alone. The `@<dir>` answer is keyed on the basename of the
 *  directory the CLI was spawned in — the run's `repos[].path`, which is what the
 *  product passes as `cwd` — and wins over the plain answer for that signature
 *  whenever it exists; a checkout with no per-dir answer falls through to the
 *  plain one exactly as before. Basename, not full path: the sandbox root is a
 *  fresh `mkdtemp` per test, and a journey names its checkouts (`rocket`,
 *  `telemetry`), so the basename is the stable part. */
export function splitCwdKey(rawKey: string): { key: string; cwd: string | null } {
  const m = /^(.*\S)\s+@([A-Za-z0-9_.-]+)$/.exec(rawKey.trim());
  return m ? { key: m[1], cwd: m[2] } : { key: rawKey, cwd: null };
}

export function installForgeShims(sb: Pick<Sandbox, "root">, answers: ForgeAnswers): { unknownLog: string } {
  const bin = path.join(sb.root, "bin");
  const answersDir = path.join(sb.root, "forge-answers");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(answersDir, { recursive: true });
  const unknownLog = path.join(answersDir, "unknown.jsonl");
  const callsLog = path.join(answersDir, "calls.jsonl");

  for (const cli of CLIS) {
    const map = answers[cli] ?? {};
    for (const [rawKey, raw] of Object.entries(map)) {
      const answer: ShimAnswer = isShimAnswer(raw) ? raw : { body: raw };
      const { key, cwd } = splitCwdKey(rawKey);
      const base = path.join(answersDir, `${cli}.${signatureOf(cli, key)}${cwd ? `@${cwd}` : ""}`);
      fs.writeFileSync(`${base}.json`, stdoutOf(answer.body));
      // Companions are written only when set, and a stale one from an earlier
      // install into the same root is removed, so an answer means exactly what
      // its object says.
      if (answer.stderr !== undefined) fs.writeFileSync(`${base}.stderr`, answer.stderr);
      else fs.rmSync(`${base}.stderr`, { force: true });
      if (answer.exit !== undefined) fs.writeFileSync(`${base}.exit`, String(answer.exit));
      else fs.rmSync(`${base}.exit`, { force: true });
    }
    const sigLine =
      cli === "atlassian-cli"
        ? [
            // Drop leading `--flag value` pairs, then key on three words. The
            // `$# -ge 2` guard keeps `shift 2` from aborting the script on a
            // lone trailing flag.
            `while [ $# -ge 2 ] && [ "\${1#--}" != "$1" ]; do shift 2; done`,
            `sig=$(printf '%s_%s_%s' "$1" "$2" "$3" | tr -c 'A-Za-z0-9' '_')`,
          ]
        : [`sig=$(printf '%s_%s' "$1" "$2" | tr -c 'A-Za-z0-9' '_')`];
    fs.writeFileSync(
      path.join(bin, cli),
      [
        "#!/bin/sh",
        // Every argv word hex-encoded (`od` is POSIX; BSD and GNU agree on these
        // flags), so quotes, spaces and newlines inside a `--body` survive the
        // round trip and `forgeCalls` can hand back the exact argv. The raw
        // `$*` rides along, newlines flattened, for a human reading the log.
        `hex=""`,
        `for a in "$@"; do hex="$hex$(printf '%s' "$a" | od -An -v -tx1 | tr -d ' \\n') "; done`,
        // Captured BEFORE the atlassian-cli shift below, so unknown.jsonl names
        // the argv the product actually sent, leading --workspace included.
        `raw="$(printf '%s' "$*" | tr -d '\\n\\r')"`,
        `printf '{"cli":"${cli}","hex":"%s","argv":"%s"}\\n' "\${hex% }" "$raw" >> "${callsLog}"`,
        ...sigLine,
        `f="${answersDir}/${cli}.$sig"`,
        // A per-checkout answer (`splitCwdKey`) wins over the plain one. `pwd`,
        // not `$PWD`: execFile's `cwd` is what the product varies per repo, and
        // `pwd` reads it back regardless of how this sh initialises PWD.
        `d="$(basename "$(pwd)")"`,
        `[ -f "$f@$d.json" ] && f="$f@$d"`,
        `if [ -f "$f.json" ]; then`,
        `  cat "$f.json"`,
        `  [ -f "$f.stderr" ] && cat "$f.stderr" >&2`,
        `  [ -f "$f.exit" ] && exit "$(cat "$f.exit")"`,
        `  exit 0`,
        `fi`,
        `printf '{"cli":"${cli}","argv":"%s"}\\n' "$raw" >> "${unknownLog}"`,
        `echo "[]"`,
      ].join("\n") + "\n",
      { mode: 0o755 },
    );
  }
  return { unknownLog };
}

/** Every forge invocation so far, in order, with the exact argv each shim
 *  received. The assertion of record for a write verb: a merge journey proves
 *  `gh pr merge 41 --squash` reached the CLI by finding it here, not by trusting
 *  a toast. Empty when nothing has been called yet. */
export function forgeCalls(sb: Pick<Sandbox, "root">): { cli: string; argv: string[] }[] {
  const log = path.join(sb.root, "forge-answers", "calls.jsonl");
  if (!fs.existsSync(log)) return [];
  const out: { cli: string; argv: string[] }[] = [];
  for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    // The hex field precedes the raw one on purpose: whatever the raw argv
    // contains can never disturb this match.
    const m = /^\{"cli":"([^"]+)","hex":"([0-9a-f ]*)"/.exec(line);
    if (!m) continue;
    const argv = m[2] === "" ? [] : m[2].split(" ").map((h) => Buffer.from(h, "hex").toString("utf8"));
    out.push({ cli: m[1], argv });
  }
  return out;
}

const GH_REPO_URL = "https://github.invalid/oznasi1/rocket";

/** One open PR in gh's --json shape, for the branch the take's worktree is on. */
export function ghPrListAnswer(branch: string): string {
  return JSON.stringify([{
    number: 41, url: `${GH_REPO_URL}/pull/41`,
    title: "Fix the rocket telemetry panel", state: "OPEN", isDraft: false,
    headRefName: branch, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "ci" }],
  }]);
}

export type GhDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED";

/** A `gh pr view <n> --json …` body. Serves the review rail's row expansion
 *  (`src/engine/review/provider.ts:61-63`, which reads only `statusCheckRollup`
 *  and takes `mapRollup(...).failing`), and carries every field of `PR_JSON_FIELDS`
 *  (`src/engine/pr/provider.ts:12-13`) so it also stands in for a `pr list` row
 *  wherever a journey wants one PR with specific facts.
 *
 *  Field by field, against the parser in `src/engine/pr/facts.ts`:
 *  - `failing` → CheckRun entries with `conclusion: "FAILURE"` (`FAIL_CONCLUSIONS`,
 *    facts.ts:31; graded at facts.ts:57, name from `name`, url from `detailsUrl`).
 *  - `passing` → that many `conclusion: "SUCCESS"` CheckRuns (facts.ts:58).
 *  - `decision` → `reviewDecision` (`mapReview`, facts.ts:72-84).
 *  - `mergeable` → gh's REST pair: `CONFLICTING` also sets `mergeStateStatus:
 *    "DIRTY"`, `MERGEABLE` sets `"CLEAN"` (`mapMergeable`, facts.ts:64-70 reads both).
 *
 *  Deliberately NO `unresolved` knob: `pr view` cannot carry review threads. The
 *  product counts them from a separate `gh api graphql` call (`THREADS_QUERY`,
 *  `src/engine/pr/provider.ts:17-19`; `countUnresolved`, facts.ts:143-157) — answer
 *  that with `ghReviewThreadsAnswer`, or the `unresolved` option of
 *  `ghReviewRequestsAnswer` when the journey's `api graphql` signature already
 *  serves the review search. */
export function ghPrViewAnswer(o: {
  number: number;
  failing?: string[];
  passing?: number;
  decision?: GhDecision;
  mergeable?: "MERGEABLE" | "CONFLICTING";
  title?: string;
  branch?: string;
  isDraft?: boolean;
}): unknown {
  const failing = (o.failing ?? []).map((name) => ({
    __typename: "CheckRun", name, status: "COMPLETED", conclusion: "FAILURE",
    detailsUrl: `${GH_REPO_URL}/actions/runs/9${o.number}/job/${name}`, workflowName: "CI",
  }));
  const passing = Array.from({ length: o.passing ?? 0 }, (_, i) => ({
    __typename: "CheckRun", name: `check-${i + 1}`, status: "COMPLETED", conclusion: "SUCCESS",
    detailsUrl: `${GH_REPO_URL}/actions/runs/9${o.number}/job/check-${i + 1}`, workflowName: "CI",
  }));
  const mergeable = o.mergeable ?? "MERGEABLE";
  return {
    number: o.number,
    url: `${GH_REPO_URL}/pull/${o.number}`,
    title: o.title ?? "Fix the rocket telemetry panel",
    state: "OPEN",
    isDraft: o.isDraft ?? false,
    headRefName: o.branch ?? "E2E-1-fix-the-rocket-telemetry-panel",
    mergeable,
    mergeStateStatus: mergeable === "CONFLICTING" ? "DIRTY" : "CLEAN",
    reviewDecision: o.decision ?? "REVIEW_REQUIRED",
    statusCheckRollup: [...failing, ...passing],
  };
}

/** The `reviewThreads` GraphQL body `countUnresolved` tallies
 *  (`src/engine/pr/facts.ts:143-157`): `unresolved` open threads, plus one
 *  resolved and one outdated thread that must NOT be counted (facts.ts:154-156). */
export function ghReviewThreadsAnswer(unresolved: number): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              ...Array.from({ length: unresolved }, () => ({ isResolved: false, isOutdated: false })),
              { isResolved: true, isOutdated: false },
              { isResolved: false, isOutdated: true },
            ],
          },
        },
      },
    },
  };
}

/** The `gh auth status` answer, serving BOTH callers that share its two-word
 *  signature:
 *  - `probeGh` (`src/engine/pr/provider.ts:108-117`) shells `gh auth status` and
 *    reads only the exit code — non-zero is `signed-out`.
 *  - `accounts()` (`src/engine/forge/github.ts:27-38`) shells `gh auth status
 *    --json hosts` and parses stdout with `parseGhAccounts`
 *    (`src/engine/forge/accounts.ts:31-56`): `hosts["github.com"]` must be an
 *    array of `{ login, active, state: "success", scopes }` — any other shape is
 *    `[]`, which hides the footer's account slot without an error.
 *
 *  So stdout is the `--json hosts` document and the human-readable report goes to
 *  stderr, where gh itself used to print it (recent gh prints it on stdout; the
 *  probe never reads either stream, so the split costs nothing and keeps stdout
 *  parseable). Shape verified against gh 2.89.0's `--json hosts` output.
 *
 *  No logins → the signed-out answer: exit 1 with gh's own wording, and an empty
 *  `hosts` document, which is what `probeGh` maps to `{ kind: "signed-out" }`. */
export function ghAuthStatusAnswer(logins: string[], active: string = logins[0]): ShimAnswer {
  if (logins.length === 0) {
    return {
      body: { hosts: {} },
      exit: 1,
      stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login\n",
    };
  }
  const entries = logins.map((login) => ({
    state: "success", active: login === active, host: "github.com", login,
    tokenSource: "keyring", scopes: "gist, read:org, repo, workflow", gitProtocol: "https",
  }));
  const report = ["github.com"];
  for (const e of entries) {
    report.push(
      `  ✓ Logged in to github.com account ${e.login} (keyring)`,
      `  - Active account: ${e.active}`,
      `  - Git operations protocol: https`,
      `  - Token: gho_************************************`,
      `  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'`,
      ``,
    );
  }
  return { body: { hosts: { "github.com": entries } }, stderr: report.join("\n") };
}

export interface ReviewReq {
  number: number;
  repo: string;   // "owner/name"
  title: string;
  author: string;
  branch?: string;
  createdAt?: string;      // ISO; `toRequest` parses it to epoch ms (search.ts:96)
  additions?: number;      // search.ts:98
  deletions?: number;      // search.ts:99
  changedFiles?: number;   // search.ts:100
  /** Lives in an archived repository — see the doc comment on `ghReviewRequestsAnswer`. */
  isArchived?: boolean;
  isDraft?: boolean;                                   // search.ts:95
  decision?: GhDecision | null;                        // `reviewDecision`, search.ts:102
  mergeable?: "MERGEABLE" | "CONFLICTING" | null;      // `mapGraphMergeable`, search.ts:46-50, 103
  /** The rollup's aggregate `state` (`mapRollupState`, search.ts:36-42). `null`
   *  means no CI at all — the commit carries no rollup. */
  ci?: "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED" | null;
}

/** The `gh api graphql` answer the review rail parses.
 *
 *  Shape matters more than content: `parseSearch` (`src/engine/review/search.ts:114-121`)
 *  returns NULL for anything that is not `data.search.{issueCount,nodes}`, and a
 *  null parse is indistinguishable from "no review requests" — which would make
 *  the journey pass against a broken product. Both members are mandatory here.
 *  Each node carries every field `REVIEW_SEARCH_QUERY` asks for (search.ts:8-12)
 *  in the shape `toRequest` reads (search.ts:82-108); the CI verdict sits at
 *  `commits.nodes[0].commit.statusCheckRollup.state` (search.ts:86).
 *
 *  `isArchived: true` rows are DROPPED from `nodes` and from `issueCount`. That is
 *  what GitHub does: the product excludes archived repositories SERVER-SIDE with the
 *  `archived:false` token in `REVIEW_SEARCH_Q` (search.ts:15-26), so such a row can
 *  never arrive and the parser has nothing to filter. A journey about archived
 *  repositories therefore proves the product by asserting on the argv — the `q=`
 *  word of `forgeCalls(sb)` must contain `archived:false` — never by the row's
 *  absence alone, which this builder guarantees regardless of the product.
 *
 *  `o.unresolved` folds a `ghReviewThreadsAnswer` body into the same document
 *  under `data.repository`, because the per-PR threads query
 *  (`GhReviewProvider.detail`, `src/engine/review/provider.ts:69-75`) shares the
 *  `api graphql` signature with this search and the shim can only answer one body
 *  per signature. `parseSearch` reads `data.search`, `countUnresolved` reads
 *  `data.repository`; neither sees the other's branch.
 *
 *  The shim keys on the first two argv words, so this registers under the
 *  signature "api graphql" (tr-mangled to `api_graphql`). */
export function ghReviewRequestsAnswer(reqs: ReviewReq[], o: { unresolved?: number } = {}): string {
  const live = reqs.filter((r) => r.isArchived !== true);
  const doc: Record<string, unknown> = {
    search: {
      issueCount: live.length,
      nodes: live.map((r) => ({
        __typename: "PullRequest",
        number: r.number,
        title: r.title,
        url: `https://github.invalid/${r.repo}/pull/${r.number}`,
        isDraft: r.isDraft ?? false,
        createdAt: r.createdAt ?? "2026-08-20T00:00:00Z",
        updatedAt: "2026-08-21T00:00:00Z",
        additions: r.additions ?? 0,
        deletions: r.deletions ?? 0,
        changedFiles: r.changedFiles ?? 0,
        author: { login: r.author },
        headRefName: r.branch ?? `fix/${r.number}`,
        baseRefName: "main",
        repository: { nameWithOwner: r.repo },
        reviewDecision: r.decision === undefined ? "REVIEW_REQUIRED" : r.decision,
        mergeable: r.mergeable === undefined ? "MERGEABLE" : r.mergeable,
        commits: {
          nodes: [{ commit: { statusCheckRollup: r.ci === null ? null : { state: r.ci ?? "SUCCESS" } } }],
        },
      })),
    },
  };
  if (o.unresolved !== undefined) {
    doc.repository = (ghReviewThreadsAnswer(o.unresolved) as { data: { repository: unknown } }).data.repository;
  }
  return JSON.stringify({ data: doc });
}

const GLAB_PROJECT = "oz/rocket";

/** The pipeline id `glabMrGetAnswer` gives MR `iid`, so a journey can register the
 *  jobs route the product follows it with:
 *  `api projects/:fullpath/pipelines/${glabPipelineId(iid)}/jobs?per_page=100`
 *  (`jobsPath`, `src/engine/pr/glab/provider.ts:54-55`). */
export function glabPipelineId(iid: number): number {
  return 1000 + iid;
}

function glabMrRow(iid: number, branch: string, project: string): Record<string, unknown> {
  return {
    iid,
    // Global `id`, distinct from `iid` on purpose: `GlabMr` (`src/engine/pr/glab/mr.ts:21-23`)
    // warns that a link or a project-scoped call built from `id` is a bug, and a
    // fixture where the two coincide could never catch one.
    id: 90000 + iid,
    web_url: `https://gitlab.invalid/${project}/-/merge_requests/${iid}`,
    title: "Fix the rocket telemetry panel",
    state: "opened",
    draft: false,
    source_branch: branch,
    target_branch: "main",
    has_conflicts: false,
    detailed_merge_status: "mergeable",
    // `true` lets `GlabProvider.unresolved` answer 0 without a discussions call
    // (`src/engine/pr/glab/provider.ts:192`); the review rail's `detail` still
    // makes one, so a journey on that path registers the discussions route.
    blocking_discussions_resolved: true,
    author: { username: "octo" },
    references: { full: `${project}!${iid}` },
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:00.000Z",
  };
}

/** GitLab's MR LIST answer — the `merge_requests?source_branch=…` route
 *  (`mrListPath`, `src/engine/pr/glab/provider.ts:47-48`) and the review queue's
 *  `merge_requests?scope=reviews_for_me…` sweep (`REVIEW_MR_PATH`,
 *  `src/engine/review/glab/search.ts:15`) both answer with rows of this shape.
 *
 *  Deliberately WITHOUT `head_pipeline`. The list route carries no pipeline
 *  data on real GitLab (`GlabMr.head_pipeline`, `src/engine/pr/glab/mr.ts:33-47`;
 *  `RawMr`, `src/engine/review/glab/search.ts:50-68`), and a fixture that adds it
 *  there re-hides the exact bug class the real shape once hid — an all-CI-blank
 *  Deck that doc-derived fixtures called green. Register `glabMrGetAnswer` for
 *  the single-MR route to give the card a pipeline.
 *
 *  Fields read: `iid`, `web_url`, `title`, `state`, `draft`, `has_conflicts`,
 *  `detailed_merge_status`, `blocking_discussions_resolved` by the Deck
 *  (mr.ts:21-31, 182-198); `author.username`, `references.full`, `created_at`,
 *  `updated_at` by the review queue (search.ts:50-62, 89-108).
 *
 *  `changesCount` is offered for parity with the GET, but GitLab omits
 *  `changes_count` from list rows and nothing reads it off one (`readSize` runs on
 *  the GET — `src/engine/review/glab/provider.ts:70-72,99`), so leave it unset
 *  unless a journey is deliberately probing that. */
export function glabMrListAnswer(
  branch: string,
  o: { changesCount?: string; iid?: number; project?: string } = {},
): unknown {
  const row = glabMrRow(o.iid ?? 7, branch, o.project ?? GLAB_PROJECT);
  if (o.changesCount !== undefined) row.changes_count = o.changesCount;
  return [row];
}

/** GitLab's SINGLE-MR answer — `merge_requests/${iid}` (`mrShowPath`,
 *  `src/engine/pr/glab/provider.ts:52-53`; the review rail's `detail`,
 *  `src/engine/review/glab/provider.ts:70-72`). The only route that carries
 *  `head_pipeline`, and therefore the only route that can give a GitLab card a CI
 *  status at all:
 *  - `head_pipeline.id` is what `GlabProvider.jobs` follows (glab/provider.ts:170);
 *    it is `glabPipelineId(iid)`.
 *  - `head_pipeline.status` is what the review rail's chip maps
 *    (`mapPipelineStatus`, review/glab/provider.ts:100; search.ts:35-43).
 *  - `pipelineStatus: null` → `head_pipeline: null`: an MR whose branch never ran
 *    a pipeline. `jobs` then returns null and the tally is zeros
 *    (glab/provider.ts:169-172).
 *  - `changes_count` is a STRING that GitLab caps at "20+" — `readSize`
 *    (review/glab/provider.ts:193-207) parses it with `parseInt`, so "20+" reads
 *    as 20 files. */
export function glabMrGetAnswer(
  iid: number,
  o: {
    pipelineStatus?: "success" | "failed" | "skipped" | "running" | null;
    changesCount?: string;
    branch?: string;
    project?: string;
  } = {},
): unknown {
  const row = glabMrRow(iid, o.branch ?? "E2E-1-fix-the-rocket-telemetry-panel", o.project ?? GLAB_PROJECT);
  const status = o.pipelineStatus === undefined ? "success" : o.pipelineStatus;
  row.head_pipeline = status === null ? null : { id: glabPipelineId(iid), status };
  if (o.changesCount !== undefined) row.changes_count = o.changesCount;
  return row;
}

/** The `atlassian-cli bb api --help` probe (`probeBbApi`,
 *  `src/engine/pr/bb/provider.ts:59-71`): exit 0 means the build has a raw `bb api`
 *  passthrough, any rejection means it does not (projected mode). Only the exit
 *  code is read; the text mirrors clap's for a trace that reads like the real
 *  thing. `--help` is answered by clap at parse time, so this is the one
 *  `atlassian-cli` call that needs no `--workspace` and no sign-in — which is why
 *  the probe is what the Doctor row and the mode-dependent caps hang off
 *  (`docs/FORGES.md:133-136`).
 *
 *  Projected: clap's usage-error exit code is 2, and "unrecognized subcommand" is
 *  its exact wording (`docs/FORGES.md:134`). Registers under `bb api --help`. */
export function bbHelpAnswer(mode: "passthrough" | "projected"): ShimAnswer {
  if (mode === "passthrough") {
    return {
      body:
        "Raw Bitbucket REST call\n\nUsage: atlassian-cli bb api [OPTIONS] <PATH>\n\n" +
        "Arguments:\n  <PATH>  API path, e.g. /2.0/repositories/{workspace}/{repo_slug}\n\n" +
        "Options:\n  -X, --method <METHOD>  HTTP method [default: GET]\n  -d, --data <DATA>      JSON body\n" +
        "      --format <FORMAT>  Output format\n  -h, --help             Print help\n",
    };
  }
  return {
    exit: 2,
    stderr: "error: unrecognized subcommand 'api'\n\nUsage: atlassian-cli bb <COMMAND>\n\nFor more information, try '--help'.\n",
  };
}

/** Fail when the product shelled a subcommand nobody faked.
 *
 *  Call this in the teardown of every forge journey. Without it the shim's
 *  empty-answer fallback silently absorbs a real behaviour change: the journey
 *  stays green while the product asks a question the test never answered. */
export function expectNoUnknownForgeCalls(sb: Pick<Sandbox, "root">): void {
  const log = path.join(sb.root, "forge-answers", "unknown.jsonl");
  if (!fs.existsSync(log)) return;
  const lines = fs.readFileSync(log, "utf8").trim();
  if (lines === "") return;
  throw new Error(
    `the product shelled forge subcommands with no canned answer — add them to the shim:\n${lines}`,
  );
}
