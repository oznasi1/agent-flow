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
import { windowIdentity, type CurrentWindow } from "./presence";
import { readAgentProvider, readAgentSurface, type AgentProvider } from "../config";

export const BRIEF_DIR = ".pick-task";
export const BRIEF_FILE = "TASK.md";
const PLAN_DIR = path.join(os.homedir(), ".agentflow", "plans");
const PLAN_TTL_MS = 15 * 60 * 1000; // seed handshake valid for 15 min

/** Pause between sessions when one window seeds a whole batch (see maybeSeedAgent). */
const SEED_STAGGER_MS = 400;

/** The CLI each provider's terminal surface runs, and how long its TUI needs before
 * it will accept typed input. Fixed commands on purpose — see the spec's "Out of
 * scope": a missing binary shows as `command not found` in the terminal, which is
 * self-explanatory and leaves the pre-typed prompt there to reuse. Typing sooner
 * than `bootMs` loses the prompt to a screen that isn't listening yet, and there is
 * no event to await, so both delays are verified by hand in the dev host. */
const CLI: Record<AgentProvider, { cmd: string; label: string; bootMs: number }> = {
  "claude-code": { cmd: "claude", label: "Claude", bootMs: 1500 },
  copilot: { cmd: "copilot", label: "Copilot", bootMs: 2000 }, // UNVERIFIED — measure in the dev host before release
};

/** Wrap text so the terminal delivers it as a *paste*. renderPrompt appends the
 * relevant-files block after a blank line, so most task prompts are multi-line,
 * and a bare newline sent to the CLI's TUI submits — the agent would start on a
 * truncated prompt. Pasted text keeps its newlines inline. Applied to every
 * prompt: harmless when single-line, and the only thing that saves a
 * user-customized multi-line template. */
const bracketedPaste = (text: string) => `\u001b[200~${text}\u001b[201~`;

// The Claude Code extension command that opens the panel with a pre-filled prompt.
// Verified against anthropic.claude-code 2.1.x — its URI /open handler calls exactly this.
const CLAUDE_OPEN_CMD = "claude-vscode.primaryEditor.open";
// Claude Code's "Open in New Tab". Unlike primaryEditor.open it joins the existing
// Claude tab group, so a batch's sessions stack in one column instead of one per launch.
const CLAUDE_NEW_TAB_CMD = "claude-vscode.editor.open";

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
  openIn?: "new" | "current"; // "current" seeds THIS window in place; default "new"
  /** This window's identity + roots, supplied by the caller so the engine stays free of
   *  ambient window state (the same reason presence.ts takes its clock as an argument).
   *  REQUIRED when `openIn` is "current": a window with no identity can't be named by a
   *  plan match, so it can't be seeded, and the call falls back to the normal open path. */
  currentWindow?: CurrentWindow;
  existingWorkspaceFile?: string; // when set: open the task into this .code-workspace
  /** Folders the user approved adding to `existingWorkspaceFile` — the ONLY thing
   *  merged. Absent or empty leaves that file byte-identical. Never derived from
   *  `services`: a saved workspace is the user's own artifact, and a taken ticket is
   *  not consent to rewrite it. */
  foldersToAdd?: { name: string; path: string }[];
  existingFolder?: string; // when set: focus this already-open folder window + seed it
  remoteControl?: boolean; // offer Claude Code's Remote Control in the opened session
  kind?: Run["kind"]; // what launched this run; omitted means a task
}

export interface OpenResult {
  mode: WorkspaceMode;
  workspaceFile?: string;
  briefs: { repo: string; path: string; gitExcluded: boolean; files: number }[];
  opened: string[];
  mergedRepos?: string[]; // repos appended to an existing workspace
  mergeFailed?: boolean;  // existing workspace could not be parsed; opened as-is
  unaddedRepos?: string[]; // repos that couldn't be added as roots to a folder window
  remoteControl: boolean; // whether Remote Control actually applies (see the single-window guard)
  seededInPlace?: boolean; // "current": this window was seeded as-is; nothing was opened
}

export interface PlanFile {
  key: string;
  createdAt: number;
  seedAgent: boolean;
  remoteControl?: boolean;
  /** Position in a batch. Several plans written in one loop can share a
   * createdAt millisecond; this keeps the seeded tabs in selection order. */
  seq?: number;
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
export function briefMarkdown(
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
- _Seeded by Agent Flow Deck at ${stamp}. This file is git-excluded — delete it any time._

---

${planMd.trim()}
${filesSection}
---

## Repos in scope
${svcLines}
`;
}

export function agentPrompt(t: TicketRef, mentions: string[], template: string, briefPath?: string): string {
  return renderPrompt(
    template,
    { key: t.key, summary: t.summary, url: t.url, brief: briefPath ?? `${BRIEF_DIR}/${BRIEF_FILE}` },
    mentions,
  );
}

export function writePlanFile(plan: PlanFile): void {
  fs.mkdirSync(PLAN_DIR, { recursive: true });
  fs.writeFileSync(path.join(PLAN_DIR, `${plan.key}-${plan.createdAt}.json`), JSON.stringify(plan, null, 2));
}

// ── opening ───────────────────────────────────────────────────────────────────
/** Open `target` in a separate window, or focus the window that already holds it —
 *  `open -a` does both, and falls back to openFolder when the app can't be shelled to.
 *
 *  There is deliberately no same-window mode. Replacing the running window's folders
 *  reloads the extension host and destroys whatever was open in it; "this window" is a
 *  seed destination now (see the `currentWindow` path in openWorkspace), not a reload. */
export function openInEditor(target: string): Promise<boolean> {
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
  // "This window" only means anything if this window can be named by a plan match.
  // Without an identity there is nothing to seed, so the request degrades to the
  // normal open path rather than silently doing nothing.
  const here = req.openIn === "current" ? req.currentWindow : undefined;
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
  // For "this window" the mode DESCRIBES the window rather than choosing a layout for
  // one — nothing is being laid out, so the repo count has no say.
  const effMode: WorkspaceMode = here
    ? here.kind === "workspace"
      ? "multiroot"
      : "per-window"
    : req.existingWorkspaceFile
      ? "multiroot"
      : req.existingFolder
        ? "per-window"
        : mode;
  if (here) {
    // The window is left exactly as it is: no folder change, no reload, nothing opened.
    // One match named for this window's identity is enough — the plan watcher already
    // running in this extension host picks it up, the same handshake that seeds any
    // other live window.
    //
    // Mentions resolve against THIS window's roots and are dropped for anything outside
    // them: `@centaur/src/x.ts` when centaur isn't a root here would send the agent to a
    // different checkout, which is worse than no mention at all. `{brief}` is absolute
    // for the same reason its relative form can't be trusted off-root.
    const mentions = services.flatMap((s) =>
      (filesByRepo.get(s.name) ?? [])
        .map((f) => mentionInWorkspace(here.roots, s.path, f))
        .filter((m): m is string => !!m),
    );
    matches.push({
      matchPath: here.identity,
      prompt: agentPrompt(ticket, mentions, promptTemplate, briefs[0]?.path),
    });
  } else if (req.existingWorkspaceFile) {
    // Only the approved folders. An empty list still calls through, so an unparseable
    // file is still reported as mergeFailed — it changes the mention mode below.
    const merge = mergeReposIntoWorkspace(req.existingWorkspaceFile, req.foldersToAdd ?? []);
    mergedRepos = merge.added;
    mergeFailed = merge.ok ? undefined : true;
    workspaceFile = req.existingWorkspaceFile;
    // Roots read AFTER the merge: a repo that is not a root of this window has no valid
    // `@name/rel` form, and emitting one anyway resolves against a different checkout.
    const roots = workspaceFolders(workspaceFile) ?? [];
    const mentions = services.flatMap((s) =>
      (filesByRepo.get(s.name) ?? [])
        .map((f) => mentionInWorkspace(roots, s.path, f))
        .filter((m): m is string => !!m),
    );
    // Absolute: {brief}'s default relative form names nothing when the repo isn't a root
    // of the window (batchWorkspace does the same, for the same reason).
    matches.push({
      matchPath: workspaceFile,
      prompt: agentPrompt(ticket, mentions, promptTemplate, briefs[0]?.path),
    });
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

  // One clipboard, one window. A launch that opens several windows would leave every
  // window but the last pasting another task's brief, so withhold it entirely. Also
  // withhold it when seedAgent is off: nothing seeds without a plan file (below), so
  // "applies" must never be true when no plan file will carry it.
  const remoteControl = !!req.remoteControl && seedAgent && matches.length === 1;

  // 3 — durable writes BEFORE opening: a window that opens (or is focused) and seeds
  //     can otherwise race these to disk, so nothing may be opened before this lands.
  if (seedAgent) {
    writePlanFile({ key: ticket.key, createdAt: Date.now(), seedAgent: true, remoteControl, matches });
  }
  const run: Run = {
    key: ticket.key,
    summary: ticket.summary,
    url: ticket.url,
    createdAt: Date.now(),
    kind: req.kind,
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

  // 4 — open, unless the destination is the window we're already in
  const opened: string[] = [];
  if (here) {
    opened.push(here.identity); // nothing to open; report where the session lands
  } else if (effMode === "multiroot") {
    if (await openInEditor(workspaceFile!)) opened.push(workspaceFile!);
  } else if (req.existingFolder) {
    if (await openInEditor(req.existingFolder)) opened.push(req.existingFolder);
  } else {
    for (const s of services) {
      if (await openInEditor(s.path)) opened.push(s.path);
    }
  }

  return { mode: effMode, workspaceFile, briefs, opened, mergedRepos, mergeFailed, unaddedRepos, remoteControl, seededInPlace: !!here };
}

/** Additively merge `repos` into an existing `.code-workspace` file, preserving
 * comments/formatting/settings via jsonc-parser. Returns ok:false WITHOUT writing
 * if the file can't be read or safely parsed (caller opens it as-is + warns). */
export function mergeReposIntoWorkspace(
  file: string,
  repos: { name: string; path: string }[],
): { added: string[]; ok: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { added: [], ok: false };
  }
  const errors: ParseError[] = [];
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as
    | { folders?: { name?: string; path?: string }[] }
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
  // Resolved against the file's directory and canonicalized, exactly as workspaceFolders
  // does — a raw relative "centaur" would contain nothing. Only the path is needed here,
  // so the `name` field is not carried across.
  const roots: WorkspaceFolder[] = (Array.isArray(doc.folders) ? doc.folders : [])
    .map((f) => f?.path)
    .filter((p): p is string => typeof p === "string")
    .map((p) => ({ path: canon(path.resolve(wsDir, p)) }));
  // containingRoot covers path-equality too, so this subsumes the old exact-path check:
  // a folder already declared, or already inside something declared, is not written.
  const missing = repos.filter((r) => !containingRoot(roots, r.path));
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

/** A folder declared by a `.code-workspace`: its canonical absolute path, and its
 *  `name` field when the file sets one. */
export interface WorkspaceFolder {
  name?: string;
  path: string;
}

/** The folders `file` declares, canonical and resolved against the file's directory.
 *  `undefined` when the file can't be read or safely parsed — deliberately distinct
 *  from `[]` (a valid file declaring no folders), because planWorkspaceMerge has to
 *  tell "nothing can be added safely" from "empty, so add everything".
 *
 *  Single reader for "which folders does this workspace have", so the merge, the plan
 *  and prefillPathsForTarget can't drift apart on the answer. */
export function workspaceFolders(file: string): WorkspaceFolder[] | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const errors: ParseError[] = [];
  const doc = jsoncParse(text, errors, { allowTrailingComma: true }) as
    | { folders?: { name?: string; path?: string }[] }
    | undefined;
  if (
    errors.length ||
    !doc ||
    typeof doc !== "object" ||
    Array.isArray(doc) ||
    (doc.folders !== undefined && !Array.isArray(doc.folders))
  ) {
    return undefined;
  }
  const wsDir = path.dirname(file);
  return (doc.folders ?? [])
    .filter((f): f is { name?: string; path: string } => typeof f?.path === "string")
    .map((f) => ({
      ...(typeof f.name === "string" ? { name: f.name } : {}),
      path: canon(path.resolve(wsDir, f.path)),
    }));
}

/** Canonical absolute paths of the folders declared in a `.code-workspace` file.
 *  `[]` if the file can't be read or safely parsed. */
export function workspaceFolderPaths(file: string): string[] {
  return (workspaceFolders(file) ?? []).map((f) => f.path);
}

/** A folder that might be added to an existing workspace. `label` is the folder name
 *  written into the file; `repoName` is the bare repo name dedup compares on — batch
 *  labels are key-qualified (`ASM-1-api`) but must still dedup against a folder the
 *  workspace already calls `api`. */
export interface MergeCandidate {
  label: string;
  repoName: string;
  path: string;
}

export interface WorkspaceMergePlan {
  /** In the workspace by neither path nor name — safe to offer. */
  add: MergeCandidate[];
  /** A folder with this repo's name already exists at a DIFFERENT path. Skipped without
   *  asking: two roots by one name are indistinguishable in the explorer and make
   *  `@name/…` ambiguous, which is the harm this whole change exists to prevent. */
  duplicates: MergeCandidate[];
  /** Inside a declared root, so already reachable and visible beneath it. Skipped without
   *  asking — adding it would nest a root inside a root and buy nothing. Distinct from
   *  `duplicates` because the containing root's name may match nothing about this repo:
   *  a workspace rooted at the repos parent directory, or a root the user renamed. */
  redundant: MergeCandidate[];
  /** Already a declared folder by canonical path — nothing to do, nothing to report. */
  present: MergeCandidate[];
  /** false when the file can't be read or safely parsed; every bucket is empty. */
  ok: boolean;
}

/** Classify `candidates` against the folders `file` already declares. Read-only.
 *
 *  Name comparison is case-insensitive and covers BOTH a folder's `name` field and its
 *  path's basename: servicesFromExistingDestination derives an unmatched folder's
 *  service name from the basename, so comparing only `name` would let a custom `name`
 *  field defeat the rule against the service derived from that very folder.
 *  A candidate already inside one of the declared roots is `redundant` — reachable and
 *  visible there already, so a root of its own would nest a root inside a root. */
export function planWorkspaceMerge(file: string, candidates: MergeCandidate[]): WorkspaceMergePlan {
  const folders = workspaceFolders(file);
  if (!folders) return { add: [], duplicates: [], redundant: [], present: [], ok: false };

  const paths = new Set(folders.map((f) => f.path));
  const names = new Set(
    folders
      .flatMap((f) => [f.name, path.basename(f.path)])
      .filter((n): n is string => !!n)
      .map((n) => n.toLowerCase()),
  );

  const plan: WorkspaceMergePlan = { add: [], duplicates: [], redundant: [], present: [], ok: true };
  for (const c of candidates) {
    if (paths.has(canon(c.path))) plan.present.push(c);
    else if (names.has(c.repoName.toLowerCase())) plan.duplicates.push(c);
    else if (containingRoot(folders, c.path)) plan.redundant.push(c);
    else plan.add.push(c);
  }
  return plan;
}

/** The declared root that contains `target` — path-equal, or `target` nested beneath it.
 *  Deepest root wins, matching VS Code's most-specific-root resolution. The `+ path.sep`
 *  guard keeps /repos/api from swallowing the sibling /repos/api-gateway. `undefined` when
 *  `target` is inside no root.
 *
 *  Single reader for "is this path already reachable from a root this workspace has", so
 *  merge planning, the write layer and mention rendering cannot disagree on the answer —
 *  the same reasoning that makes `workspaceFolders` the single reader for the folder list.
 *  `roots` must carry canonical paths (`workspaceFolders` returns them); `target` is
 *  canonicalized here. */
export function containingRoot(
  roots: WorkspaceFolder[],
  target: string,
): WorkspaceFolder | undefined {
  const t = canon(target);
  return roots
    .filter((r) => r.path === t || t.startsWith(r.path + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** The `@mention` for `rel` (relative to the repo at `repoPath`) in a window whose roots
 *  are `roots`. The repo is a root → `@<root>/<rel>`. The repo is INSIDE a root →
 *  `@<root>/<repo's path from that root>/<rel>`, which is the worktree case, since
 *  worktrees live at `<repo>/.claude/worktrees/<KEY>`. Inside no root → undefined, and
 *  the caller drops the mention: `@centaur/src/x.ts` when the root named `centaur` is
 *  the MAIN checkout would send the agent to the wrong tree. */
export function mentionInWorkspace(
  roots: WorkspaceFolder[],
  repoPath: string,
  rel: string,
): string | undefined {
  const root = containingRoot(roots, repoPath);
  if (!root) return undefined;
  const inner = path.relative(root.path, canon(repoPath));
  return mention("multiroot", root.name ?? path.basename(root.path), inner ? `${inner}/${rel}` : rel);
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

/** The "this window already seeded that plan" guard. It carries the plan's createdAt
 * because nothing ever clears these keys and the workspace filename a launch picks is
 * deterministic (`<KEY>.code-workspace`, `<KEY1>+<N-1>.code-workspace`): keyed on
 * key+window alone, re-launching the same selection would find every plan already
 * consumed and open a window with briefs but no Claude session at all. Writing a plan
 * file IS the intent to seed, and each one gets its own createdAt, so a new plan can
 * never be mistaken for a spent one. Keys from older plans just go unreachable —
 * they're booleans, and PLAN_TTL_MS already bounds how long a plan can be seeded. */
function seededGuard(plan: PlanFile, identity: string): string {
  return `seeded:${plan.key}:${plan.createdAt}:${identity}`;
}

// Passes must not overlap: a pass holds plans whose `seeded:` guard isn't set
// until their turn, so a second concurrent pass would re-collect and re-seed
// them. Chain rather than drop — a pass triggered mid-batch still has to run.
let seedPass: Promise<void> = Promise.resolve();

// ── Public: seed-on-activation (runs in every window our extension activates in) ─
export function maybeSeedAgent(context: vscode.ExtensionContext, log: (m: string) => void): Promise<void> {
  const thisPass = seedPass.then(() => runSeedPass(context, log));
  // The stored chain must never reject — a failed pass would otherwise wedge
  // every later call (activation, the watcher, or the next test) forever.
  // The caller's own promise (`thisPass`) still carries the rejection.
  seedPass = thisPass.then(
    () => undefined,
    () => undefined,
  );
  return thisPass;
}

async function runSeedPass(context: vscode.ExtensionContext, log: (m: string) => void): Promise<void> {
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
  const due: PlanFile[] = [];
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
    if (context.globalState.get<boolean>(seededGuard(plan, identity))) {
      log(`plan ${plan.key}: already seeded this window — skipping`);
      continue;
    }
    due.push(plan);
  }
  if (!due.length) return;

  // A batch lands N plans on one window. Order them the way the user selected them:
  // plans written in one loop can share a createdAt millisecond, so seq breaks the tie.
  due.sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0));

  const multi = due.length > 1;
  for (let i = 0; i < due.length; i++) {
    const plan = due[i];
    const match = plan.matches.find((m) => canon(m.matchPath) === identity)!;
    await context.globalState.update(seededGuard(plan, identity), true);
    await seedAgentSession({
      prompt: match.prompt,
      key: plan.key,
      matchPath: match.matchPath,
      log,
      remoteControl: plan.remoteControl === true,
      multi,
    });
    // Claude Code picks a session's column by scanning the tab groups for an existing
    // Claude group, and that model doesn't update synchronously — without this pause
    // consecutive sessions each decide there is no group yet and land in separate columns.
    if (i < due.length - 1) await delay(SEED_STAGGER_MS);
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

/** Start the session in an integrated terminal: run the CLI, wait for its TUI,
 * then type the prompt without submitting it. Returns false if the terminal
 * could not be driven, so the caller can fall back to the clipboard. */
async function seedViaTerminal(
  provider: AgentProvider,
  seedText: string,
  key: string,
  matchPath: string,
  log: (m: string) => void,
): Promise<boolean> {
  try {
    // matchPath is whatever windowIdentity() produced: a repo directory in
    // per-window mode, but the .code-workspace FILE in multiroot mode. A file is
    // not a valid cwd, and no single directory is "the" repo for a multiroot
    // window — omitting cwd lets VS Code default to the window's first root.
    const cwd = matchPath.endsWith(".code-workspace") ? undefined : matchPath;
    const { cmd, label, bootMs } = CLI[provider];
    const terminal = vscode.window.createTerminal({ name: `${label} · ${key}`, cwd });
    terminal.show();
    terminal.sendText(cmd, true);
    await delay(bootMs);
    terminal.sendText(bracketedPaste(seedText), false);
    log(`seed ${key}: typed the prompt into a terminal${cwd ? ` in ${cwd}` : ""}`);
    return true;
  } catch (e) {
    log(`seed ${key}: terminal seeding failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Open the Claude Code panel with the prompt pre-filled. Polls for the verified
 * command (handles the activation race), then the URI handler, then clipboard.
 *
 * With `remoteControl`, the panel gets `/remote-control <key>` instead and the task
 * prompt travels on the clipboard — the slash command is `local-jsx`, so Claude Code
 * cannot stack it ahead of a prompt in one submission, and the panel takes a single
 * buffer with a single Enter. */
async function seedAgentSession(opts: {
  prompt: string;
  key: string;
  matchPath: string;
  log: (m: string) => void;
  remoteControl?: boolean;
  multi?: boolean;
}): Promise<void> {
  const { prompt, key, matchPath, log, remoteControl = false, multi = false } = opts;
  const seedText = remoteControl ? `/remote-control ${key}` : prompt;
  // Write it before the panel opens so it's already there to paste.
  if (remoteControl) await vscode.env.clipboard.writeText(prompt);

  const announceRemoteControl = () => {
    if (!remoteControl) return;
    const paste = process.platform === "darwin" ? "⌘V" : "Ctrl+V";
    vscode.window.showInformationMessage(
      `Agent Flow Deck: ${key} — press Enter to connect Remote Control, then ${paste} + Enter to start the task (it's on your clipboard).`,
    );
  };

  // Both settings are read here, in the target window, at seed time — never carried
  // in the plan file. Flipping either therefore also affects plans already on disk,
  // which is what a preference should do.
  const provider = readAgentProvider();

  if (readAgentSurface() === "terminal") {
    if (await seedViaTerminal(provider, seedText, key, matchPath, log)) {
      announceRemoteControl();
      return;
    }
    // Terminal seeding failed — skip the panel attempts (this user does not use the
    // panel) and land on the clipboard fallback at the end.
  } else if (provider === "claude-code") {
    // 1 — verified command claude-vscode.primaryEditor.open(session, prompt);
    //     poll because our extension and Claude Code both activate onStartupFinished.
    const preferred = multi ? [CLAUDE_NEW_TAB_CMD, CLAUDE_OPEN_CMD] : [CLAUDE_OPEN_CMD];
    for (let attempt = 1; attempt <= 7; attempt++) {
      try {
        const cmds = await vscode.commands.getCommands(true);
        const cmd = preferred.find((c) => cmds.includes(c));
        if (cmd) {
          await vscode.commands.executeCommand(cmd, undefined, seedText);
          log(`seed ${key}: opened Claude Code via ${cmd} (attempt ${attempt})${remoteControl ? " + Remote Control" : ""}`);
          announceRemoteControl();
          return;
        }
      } catch (e) {
        log(`seed ${key}: command attempt ${attempt} threw: ${e}`);
      }
      await delay(700);
    }
    log(`seed ${key}: no Claude Code open command registered — trying URI handler`);

    // 2 — URI handler
    try {
      const uri = `${vscode.env.uriScheme}://Anthropic.claude-code/open?prompt=${encodeURIComponent(seedText)}`;
      if (await vscode.env.openExternal(vscode.Uri.parse(uri))) {
        log(`seed ${key}: opened via URI${remoteControl ? " + Remote Control" : ""}`);
        announceRemoteControl();
        return;
      }
    } catch (e) {
      log(`seed ${key}: URI failed: ${e}`);
    }
  } else {
    // Copilot + panel is filled in by a later task; until then this falls through
    // to the clipboard fallback rather than opening the wrong agent's panel.
    log(`seed ${key}: copilot panel seeding is not wired up yet — using the clipboard`);
  }

  // 3 — fallback. One clipboard can't carry N prompts, so a batch gets a pointer to
  // the briefs instead — they hold the same context and sit in the window's roots.
  if (multi) {
    vscode.window.showInformationMessage(
      `Agent Flow Deck: couldn't start Claude Code for ${key}. Its brief is in ${BRIEF_DIR}/${BRIEF_FILE} — open it to start the task.`,
    );
    log(`seed ${key}: no Claude Code available — pointed at the brief (batch, clipboard withheld)`);
    return;
  }
  if (remoteControl) log(`seed ${key}: Remote Control dropped — the clipboard is needed for the prompt`);
  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    `Agent Flow Deck: opened workspace for ${key}. Claude Code prompt copied — paste it into the panel to start.`,
  );
  log(`seed ${key}: fell back to clipboard`);
}
