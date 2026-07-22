import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { exec } from "child_process";
import { parse as jsoncParse, modify, applyEdits, type ParseError } from "jsonc-parser";
import { Run, ServiceRef, WorkspaceMode } from "../types";
import { extractFileHints, resolveFilesInRepo, mention } from "./files";
import { renderPrompt } from "./prompt";
import { writeRun, defaultRunsDir } from "./runs";
import { gitState } from "./git";
import { ensureGitExcluded } from "./gitExclude";
import { windowIdentity } from "./presence";

const BRIEF_DIR = ".pick-task";
const BRIEF_FILE = "TASK.md";
const PLAN_DIR = path.join(os.homedir(), ".agentflow", "plans");
const PLAN_TTL_MS = 15 * 60 * 1000; // seed handshake valid for 15 min

// The Claude Code extension command that opens the panel with a pre-filled prompt.
// Verified against anthropic.claude-code 2.1.x — its URI /open handler calls exactly this.
const CLAUDE_OPEN_CMD = "claude-vscode.primaryEditor.open";

export interface TicketRef {
  key: string;
  summary: string;
  url: string;
}

export interface OpenRequest {
  ticket: TicketRef;
  planMd: string;
  descriptionText: string;
  services: ServiceRef[];
  mode: WorkspaceMode;
  promptTemplate: string;
  workspaceDir: string;
  seedAgent: boolean;
  openIn?: "new" | "current"; // "current" reuses the running window; default "new"
  existingWorkspaceFile?: string; // when set: open the task into this .code-workspace
  existingFolder?: string; // when set: focus this already-open folder window + seed it
}

export interface OpenResult {
  mode: WorkspaceMode;
  workspaceFile?: string;
  briefs: { repo: string; path: string; gitExcluded: boolean; files: number }[];
  opened: string[];
  mergedRepos?: string[]; // repos appended to an existing workspace
  mergeFailed?: boolean;  // existing workspace could not be parsed; opened as-is
  unaddedRepos?: string[]; // repos that couldn't be added as roots to a folder window
}

interface PlanFile {
  key: string;
  createdAt: number;
  seedAgent: boolean;
  matches: { matchPath: string; prompt: string }[];
}

export interface WorkspaceListItem {
  file: string;
  folders: number;
  mtimeMs: number;
}

/** List `*.code-workspace` files under `dir`, newest first. Best-effort: an
 * unreadable dir yields []; an unparseable file yields a 0 folder count. */
export function listWorkspaceFiles(dir: string): WorkspaceListItem[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const items: WorkspaceListItem[] = [];
  for (const n of names) {
    if (!n.endsWith(".code-workspace")) continue;
    const file = path.join(dir, n);
    let mtimeMs = 0;
    let folders = 0;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      /* keep 0 */
    }
    try {
      const doc = jsoncParse(fs.readFileSync(file, "utf8")) as { folders?: unknown[] } | undefined;
      folders = Array.isArray(doc?.folders) ? doc!.folders.length : 0;
    } catch {
      /* keep 0 */
    }
    items.push({ file, folders, mtimeMs });
  }
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// ── Brief + prompt ────────────────────────────────────────────────────────────
function briefMarkdown(
  t: TicketRef, planMd: string, services: ServiceRef[], thisRepo: string, files: string[],
): string {
  const svcLines = services
    .map((s) => `- \`${s.name}\` — ${s.path}${s.name === thisRepo ? "  ← you are here" : ""}`)
    .join("\n");
  const names = services.map((s) => s.name).join(", ");
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const jiraLine = t.url ? `- **Jira:** ${t.url}\n` : "";
  const filesSection = files.length
    ? `\n## Relevant files (from the ticket description)\n${files.map((f) => `- \`${f}\``).join("\n")}\n`
    : "";
  return `# ${t.key} — ${t.summary}

${jiraLine}- **Repos in scope:** ${names}
- **This repo:** \`${thisRepo}\`
- _Seeded by Agent Flow at ${stamp}. This file is git-excluded — delete it any time._

---

${planMd.trim()}
${filesSection}
---

## Repos in scope
${svcLines}
`;
}

function agentPrompt(t: TicketRef, mentions: string[], template: string): string {
  return renderPrompt(template, { key: t.key, summary: t.summary, url: t.url, brief: `${BRIEF_DIR}/${BRIEF_FILE}` }, mentions);
}

function writePlanFile(plan: PlanFile): void {
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  fs.writeFileSync(path.join(PLAN_DIR, `${plan.key}-${plan.createdAt}.json`), JSON.stringify(plan, null, 2));
}

// ── opening ───────────────────────────────────────────────────────────────────
export function openInEditor(target: string, newWindow = true): Promise<boolean> {
  // Reuse the current window: replace its folder(s) in place. This reloads the window,
  // so the seed-on-activation handshake fires here. (`open -a` can't target this window.)
  if (!newWindow) {
    return Promise.resolve(
      vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(target), { forceNewWindow: false }),
    ).then(() => true, () => false);
  }
  const app = vscode.env.appName || "Cursor";
  return new Promise((resolve) => {
    exec(`open -a ${JSON.stringify(app)} ${JSON.stringify(target)}`, (err) => {
      if (!err) return resolve(true);
      vscode.commands
        .executeCommand("vscode.openFolder", vscode.Uri.file(target), { forceNewWindow: true })
        .then(() => resolve(true), () => resolve(false));
    });
  });
}

// ── Public: open + seed ────────────────────────────────────────────────────────
export async function openWorkspace(req: OpenRequest): Promise<OpenResult> {
  const { ticket, planMd, descriptionText, services, mode, promptTemplate, workspaceDir, seedAgent } = req;
  const newWindow = (req.openIn ?? "new") !== "current";
  const hints = extractFileHints(descriptionText);
  const filesByRepo = new Map(services.map((s) => [s.name, resolveFilesInRepo(s.path, hints)]));

  // 1 — briefs + git-exclude
  const briefs = services.map((s) => {
    const files = filesByRepo.get(s.name) ?? [];
    const dir = path.join(s.path, BRIEF_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const briefPath = path.join(dir, BRIEF_FILE);
    fs.writeFileSync(briefPath, briefMarkdown(ticket, planMd, services, s.name, files));
    return { repo: s.name, path: briefPath, gitExcluded: ensureGitExcluded(s.path, `${BRIEF_DIR}/`), files: files.length };
  });

  // 2 — build the workspace target + the seed matches
  let workspaceFile: string | undefined;
  let mergedRepos: string[] | undefined;
  let mergeFailed: boolean | undefined;
  let unaddedRepos: string[] | undefined;
  const matches: PlanFile["matches"] = [];
  const effMode: WorkspaceMode = req.existingWorkspaceFile ? "multiroot" : req.existingFolder ? "per-window" : mode;
  if (req.existingWorkspaceFile) {
    const merge = mergeReposIntoWorkspace(req.existingWorkspaceFile, services);
    mergedRepos = merge.added;
    mergeFailed = merge.ok ? undefined : true;
    workspaceFile = req.existingWorkspaceFile;
    const mentions = services.flatMap((s) =>
      (filesByRepo.get(s.name) ?? []).map((f) => mention("multiroot", s.name, f)),
    );
    matches.push({ matchPath: workspaceFile, prompt: agentPrompt(ticket, mentions, promptTemplate) });
  } else if (req.existingFolder) {
    const folder = req.existingFolder;
    // Focus an already-open folder window and seed there. VS Code offers no way to
    // inject roots into a folder window remotely, so its folder set is unchanged;
    // ensure a brief exists IN that folder so the seeded relative {brief} resolves.
    if (!services.some((s) => canon(s.path) === canon(folder))) {
      const dir = path.join(folder, BRIEF_DIR);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, BRIEF_FILE), briefMarkdown(ticket, planMd, services, path.basename(folder), []));
      ensureGitExcluded(folder, `${BRIEF_DIR}/`);
    }
    unaddedRepos = services.filter((s) => canon(s.path) !== canon(folder)).map((s) => s.name);
    const mentions = services.flatMap((s) => (filesByRepo.get(s.name) ?? []).map((f) => mention("per-window", s.name, f)));
    matches.push({ matchPath: folder, prompt: agentPrompt(ticket, mentions, promptTemplate) });
  } else if (mode === "multiroot") {
    fs.mkdirSync(workspaceDir, { recursive: true });
    workspaceFile = path.join(workspaceDir, `${ticket.key}.code-workspace`);
    fs.writeFileSync(
      workspaceFile,
      JSON.stringify({ folders: services.map((s) => ({ name: s.name, path: s.path })), settings: {} }, null, 2) + "\n",
    );
    const mentions = services.flatMap((s) => (filesByRepo.get(s.name) ?? []).map((f) => mention("multiroot", s.name, f)));
    matches.push({ matchPath: workspaceFile, prompt: agentPrompt(ticket, mentions, promptTemplate) });
  } else {
    for (const s of services) {
      const mentions = (filesByRepo.get(s.name) ?? []).map((f) => mention("per-window", s.name, f));
      matches.push({ matchPath: s.path, prompt: agentPrompt(ticket, mentions, promptTemplate) });
    }
  }

  // 3 — durable writes BEFORE opening: reusing the current window reloads this
  //     extension host, which would otherwise race these to disk.
  if (seedAgent) {
    writePlanFile({ key: ticket.key, createdAt: Date.now(), seedAgent: true, matches });
  }
  const run: Run = {
    key: ticket.key,
    summary: ticket.summary,
    url: ticket.url,
    createdAt: Date.now(),
    mode: effMode,
    workspaceFile,
    repos: services.map((s) => ({
      name: s.name,
      path: s.path,
      isGit: s.isGit,
      branch: gitState(s.name, s.path).branch ?? undefined,
    })),
    briefPaths: briefs.map((b) => b.path),
  };
  try {
    writeRun(defaultRunsDir(), run);
  } catch {
    /* the Deck record is best-effort — never fail a take over it */
  }

  // 4 — open (new window, or reuse the current one)
  const opened: string[] = [];
  if (effMode === "multiroot") {
    if (await openInEditor(workspaceFile!, newWindow)) opened.push(workspaceFile!);
  } else if (req.existingFolder) {
    if (await openInEditor(req.existingFolder, newWindow)) opened.push(req.existingFolder);
  } else {
    for (const s of services) {
      if (await openInEditor(s.path, newWindow)) opened.push(s.path);
    }
  }

  return { mode: effMode, workspaceFile, briefs, opened, mergedRepos, mergeFailed, unaddedRepos };
}

/** Additively merge `repos` into an existing `.code-workspace` file, preserving
 * comments/formatting/settings via jsonc-parser. Returns ok:false WITHOUT writing
 * if the file can't be read or safely parsed (caller opens it as-is + warns). */
export function mergeReposIntoWorkspace(
  file: string,
  repos: ServiceRef[],
): { added: string[]; ok: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { added: [], ok: false };
  }
  const errors: ParseError[] = [];
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as
    | { folders?: { path?: string }[] }
    | undefined;
  if (
    errors.length ||
    !doc ||
    typeof doc !== "object" ||
    Array.isArray(doc) ||
    (doc.folders !== undefined && !Array.isArray(doc.folders))
  ) {
    return { added: [], ok: false };
  }

  const wsDir = path.dirname(file);
  const present = new Set(
    (Array.isArray(doc.folders) ? doc.folders : [])
      .map((f) => f?.path)
      .filter((p): p is string => typeof p === "string")
      .map((p) => canon(path.resolve(wsDir, p))),
  );
  const missing = repos.filter((r) => !present.has(canon(r.path)));
  if (!missing.length) return { added: [], ok: true };

  const startIdx = Array.isArray(doc.folders) ? doc.folders.length : 0;
  let updated = text;
  try {
    missing.forEach((r, i) => {
      const edits = modify(
        updated,
        ["folders", startIdx + i],
        { name: r.name, path: r.path },
        { isArrayInsertion: true, formattingOptions: { insertSpaces: true, tabSize: 2 } },
      );
      updated = applyEdits(updated, edits);
    });
    fs.writeFileSync(file, updated);
  } catch {
    return { added: [], ok: false };
  }
  return { added: missing.map((r) => r.name), ok: true };
}

/** Canonical absolute paths of the folders declared in a `.code-workspace` file,
 * resolved against the file's directory. `[]` if the file can't be read or safely
 * parsed. Mirrors the existing-folder resolution in mergeReposIntoWorkspace so the
 * "which repos does this workspace already have" check stays consistent with the merge. */
export function workspaceFolderPaths(file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const errors: ParseError[] = [];
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as
    | { folders?: { path?: string }[] }
    | undefined;
  if (errors.length || !doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.folders)) {
    return [];
  }
  const wsDir = path.dirname(file);
  return doc.folders
    .map((f) => f?.path)
    .filter((p): p is string => typeof p === "string")
    .map((p) => canon(path.resolve(wsDir, p)));
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve symlinks so the plan matchPath (written pre-open) and the window's
 * workspace path (read post-open) compare equal even across /var↔/private/var etc. */
function canon(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// ── Public: seed-on-activation (runs in every window our extension activates in) ─
export async function maybeSeedAgent(context: vscode.ExtensionContext, log: (m: string) => void): Promise<void> {
  const identity = windowIdentity()?.identity;
  log(`activation: window identity = ${identity ?? "(no single workspace)"}`);
  if (!identity) return;

  let files: string[];
  try {
    files = fs.readdirSync(PLAN_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    log(`no plan dir (${PLAN_DIR}) — nothing to seed`);
    return;
  }

  const now = Date.now();
  for (const f of files) {
    const full = path.join(PLAN_DIR, f);
    let plan: PlanFile;
    try {
      plan = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    if (now - plan.createdAt > PLAN_TTL_MS) {
      fs.rmSync(full, { force: true });
      continue;
    }
    if (!plan.seedAgent) continue;
    const match = plan.matches.find((m) => canon(m.matchPath) === identity);
    log(`plan ${plan.key}: ${match ? "MATCHED this window" : "no match"}`);
    if (!match) continue;

    const consumedKey = `seeded:${plan.key}:${identity}`;
    if (context.globalState.get<boolean>(consumedKey)) {
      log(`plan ${plan.key}: already seeded this window — skipping`);
      continue;
    }
    await context.globalState.update(consumedKey, true);
    await seedClaudeCode(match.prompt, plan.key, log);
    return;
  }
}

/** Watch the plan dir so an ALREADY-OPEN window seeds itself when a matching task
 * is taken (activation-time seeding only covers windows that (re)open). Debounced;
 * dispose() closes the watcher. The per-window `seeded:` guard prevents re-seeding. */
export function watchPlansAndSeed(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watcher: fs.FSWatcher;
  try {
    fs.mkdirSync(PLAN_DIR, { recursive: true });
    watcher = fs.watch(PLAN_DIR, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void maybeSeedAgent(context, log), 300);
    });
  } catch (e) {
    // Live seeding is a convenience; a filesystem/permission problem (e.g. ~/.agentflow
    // not writable, an OS watch limit) must not break activation — this runs synchronously
    // from activate(). Degrade to no live watching instead of throwing.
    log(`live seeding disabled — couldn't watch ${PLAN_DIR}: ${e instanceof Error ? e.message : String(e)}`);
    return { dispose: () => { if (timer) clearTimeout(timer); } };
  }
  log(`watching plan dir ${PLAN_DIR} for live seeding`);
  return {
    dispose: () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

/** Open the Claude Code panel with the prompt pre-filled. Polls for the verified
 * command (handles the activation race), then the URI handler, then clipboard. */
async function seedClaudeCode(prompt: string, key: string, log: (m: string) => void): Promise<void> {
  // 1 — verified command claude-vscode.primaryEditor.open(session, prompt);
  //     poll because our extension and Claude Code both activate onStartupFinished.
  for (let attempt = 1; attempt <= 7; attempt++) {
    try {
      const cmds = await vscode.commands.getCommands(true);
      if (cmds.includes(CLAUDE_OPEN_CMD)) {
        await vscode.commands.executeCommand(CLAUDE_OPEN_CMD, undefined, prompt);
        log(`seed ${key}: opened Claude Code via command (attempt ${attempt})`);
        return;
      }
    } catch (e) {
      log(`seed ${key}: command attempt ${attempt} threw: ${e}`);
    }
    await delay(700);
  }
  log(`seed ${key}: '${CLAUDE_OPEN_CMD}' never registered — trying URI handler`);

  // 2 — URI handler
  try {
    const uri = `${vscode.env.uriScheme}://Anthropic.claude-code/open?prompt=${encodeURIComponent(prompt)}`;
    if (await vscode.env.openExternal(vscode.Uri.parse(uri))) {
      log(`seed ${key}: opened via URI`);
      return;
    }
  } catch (e) {
    log(`seed ${key}: URI failed: ${e}`);
  }

  // 3 — clipboard fallback
  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    `Agent Flow: opened workspace for ${key}. Claude Code prompt copied — paste it into the panel to start.`,
  );
  log(`seed ${key}: fell back to clipboard`);
}
