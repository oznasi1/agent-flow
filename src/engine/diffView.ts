import * as vscode from "vscode";
import { showFileAtRef } from "./git";

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
