import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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

/** Resolve symlinks so identities compare equal across /var↔/private/var etc. */
function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
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

/** `kill(pid, 0)` sends no signal — it only probes: it throws ESRCH for a dead pid
 * and EPERM for a live process we don't own. Either "no error" or EPERM ⇒ alive. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
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
