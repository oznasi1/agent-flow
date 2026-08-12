import * as path from "path";
import * as vscode from "vscode";
import { ChangedFile, showFileAtRef, taskChangedFiles, taskDiffBase } from "./git";

/** The scheme the left-hand side of every task diff is served on. A file's content
 * at the merge-base exists in no working tree, so it cannot be a `file:` URI — and
 * a TextDocumentContentProvider is read-only by construction, which is exactly
 * right for the "before" side. */
export const BASE_SCHEME = "agent-flow-base";

type BaseRef = { repo: string; ref: string; file: string };

/** A URI naming one file as it stood at a task's base. The three facts the provider
 * needs ride in `query`; the file path is repeated in `path` so anything that
 * surfaces the URI shows a readable name rather than an opaque blob. */
export function baseUri(repoPath: string, ref: string, file: string): vscode.Uri {
  const payload: BaseRef = { repo: repoPath, ref, file };
  return vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${file}`, query: JSON.stringify(payload) });
}

export class TaskBaseContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    let ref: BaseRef;
    try {
      ref = JSON.parse(uri.query) as BaseRef;
    } catch {
      // A malformed URI is not worth a popup: an empty left side reads as "this
      // file is new", which is wrong but harmless, and a throw here would leave
      // the whole multi-file editor blank.
      return "";
    }
    return showFileAtRef(ref.repo, ref.ref, ref.file);
  }
}

/** What to call a multi-root task: the workspace file's own name, without the
 * extension every one of them shares. `undefined` for a task that has no
 * workspace file, which is every single-repo and per-window run. */
export function workspaceLabel(workspaceFile?: string): string | undefined {
  if (!workspaceFile) return undefined;
  const name = path.basename(workspaceFile, ".code-workspace");
  // `basename` refuses to strip a suffix that is the whole name, so a bare
  // `.code-workspace` comes back as itself — a label naming nothing.
  return name === ".code-workspace" ? undefined : name;
}

/**
 * The multi-diff editor's tab title. The repo belongs in it because that editor
 * shows nothing else that names one: files arrive flat, and a task can span repos
 * whose paths the tree abbreviates away.
 *
 * A single repo names itself; several name the workspace they were opened as, or
 * say "all repos" when the task has no workspace file. A run with nothing to name
 * gets the bare key rather than a dangling separator.
 */
export function diffTitle(key: string, repos: { name: string }[], workspaceFile?: string): string {
  const scope =
    repos.length === 1
      ? repos[0].name
      : repos.length > 1
        ? workspaceLabel(workspaceFile) ?? "all repos"
        : "";
  return scope ? `Changes in ${key} — ${scope}` : `Changes in ${key}`;
}

/** What came of trying to show a task's diff. The caller owns the messaging, so
 * this reports rather than toasts. */
export type DiffOutcome = "opened" | "empty" | "binary-only" | "unsupported";

/** A `[resource, left, right]` triple as `vscode.changes` wants it: `left` absent
 * means the file was added, `right` absent means it was deleted. */
type Resource = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

function resourceFor(repoPath: string, base: string, f: ChangedFile): Resource {
  // The right side is the real file in the worktree, not a snapshot — so the diff
  // shows uncommitted work, and a typo spotted while reading can be fixed in place.
  const right = vscode.Uri.file(path.join(repoPath, f.path));
  if (f.status === "A") return [right, undefined, right];
  const left = baseUri(repoPath, base, f.oldPath ?? f.path);
  if (f.status === "D") return [right, left, undefined];
  return [right, left, right];
}

/**
 * Show everything a task changed in VS Code's native multi-file diff editor.
 *
 * Repos are listed flat rather than grouped: the editor builds its own tree from
 * the absolute paths, so each repo root becomes a group for free.
 *
 * Binary files are dropped. Their left side would come through a *text* content
 * provider, which renders them as mojibake — worse than not showing them.
 */
export async function openTaskDiff(
  title: string,
  repos: { name: string; path: string }[],
): Promise<DiffOutcome> {
  const resources: Resource[] = [];
  let sawBinary = false;
  for (const repo of repos) {
    const base = taskDiffBase(repo.path);
    for (const f of taskChangedFiles(repo.path)) {
      if (f.binary) {
        sawBinary = true;
        continue;
      }
      resources.push(resourceFor(repo.path, base, f));
    }
  }
  if (resources.length === 0) return sawBinary ? "binary-only" : "empty";

  try {
    await vscode.commands.executeCommand("vscode.changes", title, resources);
    return "opened";
  } catch {
    // `vscode.changes` is a built-in command rather than a typed API, so an editor
    // that forked VS Code may simply not have it. Rejecting is how that shows up,
    // and the caller has a flat-patch fallback for exactly this.
    return "unsupported";
  }
}
