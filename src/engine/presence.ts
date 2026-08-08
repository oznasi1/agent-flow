import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { canon, pidAlive } from "./paths";

export interface WindowIdentity {
  identity: string; // canonical path — a .code-workspace file or a single folder
  kind: "workspace" | "folder";
  label: string; // basename, for display
  folders: number; // folder count in the window
}

export interface PresenceRecord extends WindowIdentity {
  pid: number; // the window's extension-host process id
  updatedAt: number; // epoch ms, stamped by the caller
}

/** ~/.agentflow/windows — the presence registry directory. */
export function defaultWindowsDir(): string {
  return path.join(os.homedir(), ".agentflow", "windows");
}


/** This window's seed identity — the SAME value maybeSeedAgent matches on. A saved
 * .code-workspace file wins; else a lone folder; else undefined (empty windows and
 * untitled multi-root windows are neither trackable nor seedable). */
export function windowIdentity(): WindowIdentity | undefined {
  const wf = vscode.workspace.workspaceFile;
  if (wf && wf.scheme === "file") {
    const identity = canon(wf.fsPath);
    return { identity, kind: "workspace", label: path.basename(identity), folders: vscode.workspace.workspaceFolders?.length ?? 0 };
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders?.length === 1) {
    const identity = canon(folders[0].uri.fsPath);
    return { identity, kind: "folder", label: path.basename(identity), folders: 1 };
  }
  return undefined;
}

/** This window as a seed destination: its identity plus the roots it actually has.
 *  Everything the "This window" open path needs, resolved in one place so the picker,
 *  the target resolver and the open path can't disagree about what "here" is.
 *
 *  `undefined` whenever `windowIdentity` is — an empty or untitled multi-root window
 *  can't be named by a plan match, so it can't be seeded, so it must not be offered.
 *
 *  Roots are canonicalized to match `workspaceFolders()`, whose output feeds the same
 *  `mentionInWorkspace` / `containingRoot` comparisons. */
export interface CurrentWindow {
  identity: string;
  kind: "workspace" | "folder";
  roots: { name?: string; path: string }[];
}

export function currentWindow(): CurrentWindow | undefined {
  const id = windowIdentity();
  if (!id) return undefined;
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name,
    path: canon(f.uri.fsPath),
  }));
  return { identity: id.identity, kind: id.kind, roots };
}

/** Write (or refresh) this window's presence record. Best-effort — never throws. */
export function writePresence(dir: string, rec: PresenceRecord): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${rec.pid}.json`), JSON.stringify(rec, null, 2));
  } catch {
    /* presence is a convenience — never fail a caller over it */
  }
}

/** Delete this window's presence record (deactivate cleanup). Best-effort. */
export function removePresence(dir: string, pid: number): void {
  try {
    fs.rmSync(path.join(dir, `${pid}.json`), { force: true });
  } catch {
    /* best-effort */
  }
}


/** Best-effort unlink — pruning is a housekeeping side effect of reading, so a
 * failure here (e.g. EACCES/EBUSY) must never fail the read itself. */
function prune(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Read all presence records, pruning any whose process is dead and any that fail
 * to parse. Deduped by identity, newest first. */
export function readLiveWindows(dir: string): PresenceRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir) as unknown as string[];
  } catch {
    return [];
  }
  const valid: PresenceRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const file = path.join(dir, n);
    let rec: PresenceRecord;
    try {
      rec = JSON.parse(fs.readFileSync(file, "utf8")) as PresenceRecord;
    } catch {
      prune(file);
      continue;
    }
    if (typeof rec.pid !== "number" || rec.pid <= 0 || !rec.identity || !pidAlive(rec.pid)) {
      prune(file);
      continue;
    }
    valid.push(rec);
  }
  valid.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const seen = new Set<string>();
  const out: PresenceRecord[] = [];
  for (const rec of valid) {
    if (seen.has(rec.identity)) continue;
    seen.add(rec.identity);
    out.push(rec);
  }
  return out;
}
