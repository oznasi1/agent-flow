import { execFileSync } from "child_process";
import { RepoGit } from "../types";

/** Run a git command in a repo, returning trimmed stdout or "" on any failure
 * (non-git dir, missing upstream, etc.) — the deck must never break on git. */
function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      // A task diff is the one output here big enough to matter. Node's 1 MB
      // default throws ENOBUFS, which the catch below would turn into "", and a
      // caller cannot tell that apart from "this task changed nothing".
      maxBuffer: 32 * 1024 * 1024,
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

/** Like `git`, but untrimmed — for file *contents*, where the trailing newline is
 * part of the data and stripping it shows a phantom change on the last line. */
function gitRaw(repoPath: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repoPath, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    }).toString();
  } catch {
    return "";
  }
}

/**
 * The reliable backbone of a run's status: branch, working-tree diff vs HEAD
 * (uncommitted work the agent produced), commits ahead of upstream, and dirtiness.
 * Degrades to zeros/null for a non-git or missing path rather than throwing.
 *
 * `knownBranch` lets a caller that *just* read this repo's branch in the same
 * tick (a local card's roots, resolved moments earlier for ticket inference)
 * hand it back in rather than paying for a second `rev-parse` that can only
 * repeat the same answer. Omitted, this reads it fresh — every tracked run's
 * call, unchanged.
 */
export function gitState(name: string, repoPath: string, knownBranch?: string | null): RepoGit {
  const branch = knownBranch !== undefined ? knownBranch : currentBranch(repoPath);
  const dirty = git(repoPath, ["status", "--porcelain"]).length > 0;

  const aheadRaw = git(repoPath, ["rev-list", "--count", "@{u}..HEAD"]);
  const ahead = aheadRaw ? parseInt(aheadRaw, 10) || 0 : 0;

  let added = 0;
  let removed = 0;
  let files = 0;
  const numstat = git(repoPath, ["diff", "HEAD", "--numstat"]);
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, r] = line.split("\t");
    files++;
    added += parseInt(a, 10) || 0; // binary files show "-" → NaN → 0
    removed += parseInt(r, 10) || 0;
  }

  return { name, path: repoPath, branch, dirty, ahead, added, removed, files };
}

/** The remote default branch a task is measured against: whatever origin/HEAD
 * points at, else origin/main, else origin/master. "" when the repo has no origin
 * to compare with — a local-only checkout, or a fresh init. */
function defaultRemoteRef(repoPath: string): string {
  const head = git(repoPath, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  // origin/HEAD is only written by `git clone` and goes stale after a default-branch
  // rename, so a working clone very often has no such ref — or keeps one naming the
  // retired branch that the next `fetch --prune` deleted. Hence the verify before
  // trusting it and the fallback below: an unresolvable base is worse than no base,
  // because merge-base then fails, git() hands back "", and taskDiff degrades to
  // `diff HEAD` — silently reinstating the "committed work reads as no work" defect
  // this function exists to fix.
  if (head && git(repoPath, ["rev-parse", "--verify", "--quiet", head])) return head;
  for (const ref of ["origin/main", "origin/master"]) {
    if (git(repoPath, ["rev-parse", "--verify", "--quiet", ref])) return ref;
  }
  return "";
}

/** Everything a task changed in this repo: the diff from where its branch left the
 * default branch through to the current working tree, so committed work counts.
 * The moment an agent commits, a plain `diff HEAD` goes blank and reads as "no work
 * done" — which is what the Deck's Diff button used to report for every run that
 * got as far as opening a PR. Degrades to the uncommitted diff when there is no
 * base to find, and on a run still sitting on the default branch merge-base *is*
 * HEAD, so the two are the same command. */
export function taskDiff(repoPath: string): string {
  return git(repoPath, ["diff", taskDiffBase(repoPath)]);
}

/** The commit a task's work is measured from: where its branch left the default
 * branch. "HEAD" when there is no resolvable base — a local-only checkout, or a
 * run still sitting on the default branch, where merge-base *is* HEAD anyway. A
 * ref rather than "" so every caller has something it can hand to `git show`. */
export function taskDiffBase(repoPath: string): string {
  const base = defaultRemoteRef(repoPath);
  return (base && git(repoPath, ["merge-base", "HEAD", base])) || "HEAD";
}

/** One entry per file a task touched, with renames kept whole. */
export type ChangedFile = {
  status: "A" | "M" | "D" | "R";
  path: string;
  oldPath?: string;
  binary: boolean;
};

/** Every file this task changed since its base, for driving the multi-file diff
 * editor. `-z` is not optional: a path may contain a space, and without it a
 * rename's two paths cannot be told apart.
 *
 * Binary-ness comes from a second pass, read positionally. `--numstat` emits its
 * rows in the same order as `--name-status` and marks a binary with "-" in both
 * count columns, so matching by line index means never parsing numstat's paths —
 * which is what makes the awkward `{old => new}` rename form a non-problem. */
export function taskChangedFiles(repoPath: string): ChangedFile[] {
  const base = taskDiffBase(repoPath);
  const binary = git(repoPath, ["diff", "--numstat", "-M", base])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.startsWith("-\t-\t"));

  const records = git(repoPath, ["diff", "--name-status", "-M", "-z", base]).split("\0");
  const out: ChangedFile[] = [];
  for (let i = 0; i < records.length; ) {
    const raw = records[i];
    if (!raw) break;
    const code = raw[0];
    const isMove = code === "R" || code === "C";
    const oldPath = isMove ? records[i + 1] : undefined;
    const filePath = isMove ? records[i + 2] : records[i + 1];
    i += isMove ? 3 : 2;
    if (!filePath) break;
    // C (copy) shares the rename's three-record shape and shows up whenever a
    // contributor's gitconfig sets diff.renames=copies, so it has to be parsed or
    // the records fall out of step. It is then treated as the add it effectively is.
    const status: ChangedFile["status"] =
      code === "A" || code === "C" ? "A" : code === "D" ? "D" : code === "R" ? "R" : "M";
    out.push({
      status,
      path: filePath,
      ...(status === "R" ? { oldPath } : {}),
      binary: binary[out.length] ?? false,
    });
  }
  return out;
}

/** A file's content at a ref, for the left-hand side of a diff. "" when the file
 * did not exist there, which the caller reads as "nothing to compare against". */
export function showFileAtRef(repoPath: string, ref: string, file: string): string {
  return gitRaw(repoPath, ["show", `${ref}:${file}`]);
}

// Memoized per path for the life of the extension host. A directory does not
// change repo, and origin/HEAD is written by `git clone` and effectively never
// moves — so a value good once is good until the window reloads. This is what
// keeps prEligible free to be called for every repo on every refresh.
const rootMemo = new Map<string, string>();
const defaultBranchMemo = new Map<string, string>();

/** The git repo root containing `cwd`, so a session started in `centaur/src`
 * resolves to the same place as one started in `centaur` — and so a place
 * compares equal to a run record's repo path, which is always a root. "" when
 * `cwd` is in no repo at all. */
export function repoRoot(cwd: string): string {
  const hit = rootMemo.get(cwd);
  if (hit !== undefined) return hit;
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  rootMemo.set(cwd, root);
  return root;
}

/** The checked-out branch, or null on a detached HEAD or a non-git path. Not
 * memoized: unlike a repo's root and its default branch, this is exactly the
 * thing that changes while the Deck is open. */
export function currentBranch(repoPath: string): string | null {
  const raw = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return raw && raw !== "HEAD" ? raw : null;
}

/** The repo's default branch, short — "main", "master", whatever origin/HEAD
 * names. "" when the repo has no origin, which also means it has no pull
 * requests to find. */
export function defaultBranch(repoPath: string): string {
  const hit = defaultBranchMemo.get(repoPath);
  if (hit !== undefined) return hit;
  const ref = defaultRemoteRef(repoPath); // "origin/main" | ""
  const short = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
  defaultBranchMemo.set(repoPath, short);
  return short;
}

/** Can this repo's branch own a pull request of its own? A branch that IS the
 * default branch cannot: `gh pr list --head main` matches every PR ever opened
 * from main, none of which belongs to this run — the Deck once rendered a
 * stranger's closed PR on an Explore card exactly that way. A repo with no
 * origin has no pull requests at all, and a non-git service has no branch. */
export function prEligible(repo: { path: string; isGit: boolean; branch?: string }): boolean {
  if (!repo.isGit || !repo.branch) return false;
  const def = defaultBranch(repo.path);
  return def !== "" && repo.branch !== def;
}
