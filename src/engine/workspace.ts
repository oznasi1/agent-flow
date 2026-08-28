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
import { serviceFolderName } from "./worktree";
import { windowIdentity, type CurrentWindow } from "./presence";
import { hostProviders, providerLabel, readAgentProviderSetting, readAgentSurface, resolvedProvider, type AgentProvider } from "../config";

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
 * no event to await, so it can only be measured by hand in a dev host. Claude's
 * 1500ms has been verified — this is what's shipped and observed working. Copilot's
 * has NOT: see the UNVERIFIED tag below, still to be measured before release. */
const CLI: Record<AgentProvider, { cmd: string; label: string; bootMs: number }> = {
  "claude-code": { cmd: "claude", label: "Claude", bootMs: 1500 },
  copilot: { cmd: "copilot", label: "Copilot", bootMs: 2000 }, // UNVERIFIED — measure in the dev host before release
  // UNVERIFIED — and note `cursor-agent` is NOT installed alongside Cursor itself;
  // it is a separate install, so the `command not found` fallback is reached more
  // often here than for the other two.
  cursor: { cmd: "cursor-agent", label: "Cursor", bootMs: 2000 },
  // UNVERIFIED — like cursor-agent, `codex` is its own install (npm i -g
  // @openai/codex), so `command not found` is this entry's common failure too.
  codex: { cmd: "codex", label: "Codex", bootMs: 2000 },
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

// VS Code's built-in chat command, served by both GitHub Copilot Chat and Cursor.
// `isPartialQuery: true` fills the input without submitting, so Copilot honors the
// same "we pre-fill, you press Enter" contract as the Claude Code panel. Cursor
// ignores both `isPartialQuery` and `mode` — prefill-without-submit is already its
// default — and its handler was read from the shipped workbench bundle but not yet
// run. Copilot's shape is documented; neither has been confirmed in a dev host —
// that verification pass is still outstanding.
const CHAT_OPEN_CMD = "workbench.action.chat.open";

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
  /** Free text appended to every seeded prompt AFTER the template is rendered — the
   *  detail a notepad note carries, which the brief alone would leave to the agent to
   *  go and find. Appended rather than substituted into the template so a user's
   *  customized prompt keeps working untouched, and rendered-then-appended rather than
   *  inserted first so a `{summary}` or `{files}` the user typed into their note stays
   *  their own literal text instead of becoming a placeholder. Blank or absent leaves
   *  every prompt byte-identical to what it is without this field. */
  promptSuffix?: string;
  /** Files to place beside the brief — today, a notepad note's images. Copied into
   *  `<repo>/.pick-task/images/`, which `ensureGitExcluded` already excludes whole,
   *  so the agent opens a real file at a repo-relative path instead of being told
   *  about bytes it has no way to reach. Absent or empty copies nothing and creates
   *  no directory, leaving every existing launch byte-identical. */
  attachments?: { path: string; name: string }[];
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
  /** Name this launch's OWN brief absolutely in the seeded prompt, instead of writing a
   *  fallback copy into `existingFolder`. Set by **Review with agent**, whose brief
   *  belongs in the review worktree while the destination is a repo another agent is
   *  already working in — see the `existingFolder` arm below for why the fallback write
   *  is destructive there. No effect on any other destination: they all name the brief
   *  absolutely already. */
  absoluteBrief?: boolean;
  remoteControl?: boolean; // offer Claude Code's Remote Control in the opened session
  kind?: Run["kind"]; // what launched this run; omitted means a task
  /** Whether to record a Run for this open. Defaults to true. Set false when opening
   * into work that already has a record — seeding a second agent into an existing
   * place creates no new run, and writing one would not merge but overwrite: repos
   * come from `services`, `createdAt` resets, `kind` and `mode` and `workspaceFile`
   * are taken from this request. That silently rewrites the card the user is
   * looking at. */
  recordRun?: boolean;
  /** Stamped onto the run record verbatim; see `Run.parentKey`. */
  parentKey?: string;
  /** Stamped onto the run record verbatim; see `Run.children`. An empty array is
   *  stored as absent, so "no children" has exactly one representation. */
  children?: Run["children"];
  /** Pin the agent and suppress the `ask` picker. Set by the callers that must never
   *  prompt: a batch, which resolves once for the whole batch before its loop, and an
   *  Orchestrator rule, which runs unattended with nobody there to answer.
   *
   *  Read ONLY under `ask` — it replaces the prompt, it does not override a preference.
   *  A pin set under `claude-code`/`copilot`/`cursor` is ignored, and `OpenResult.provider`
   *  reports the setting. See the resolution at the top of `openWorkspace`. */
  provider?: AgentProvider;
  /** Never overwrite a brief that is already on disk. Defaults to false, which is what
   * every caller before it relied on: a Take rewrites the brief because the brief IS
   * the task it is starting.
   *
   * Set true when opening into work that is already under way. A seeded second agent
   * lands in a worktree whose `.pick-task/TASK.md` is the brief the RUNNING agent was
   * given, and the file the seeded prompt's own `{brief}` resolves to — rewriting it
   * destroys live, user-visible content, unattended, with nothing to undo it from.
   *
   * "Keep" means never destroy, not never create: a place with no brief yet still gets
   * one, because `{brief}` has to resolve to something. */
  keepExistingBrief?: boolean;
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
  /** The agent that was actually seeded. Post-launch copy reads this rather than the
   *  setting, so it names the real agent even under `ask`. */
  provider: AgentProvider;
  /** The `ask` picker was dismissed. Nothing was opened, written, or seeded — every
   *  other field is empty and the caller must return without reporting success. */
  cancelled?: true;
}

export interface PlanFile {
  key: string;
  createdAt: number;
  seedAgent: boolean;
  remoteControl?: boolean;
  /** Position in a batch. Several plans written in one loop can share a
   * createdAt millisecond; this keeps the seeded tabs in selection order. */
  seq?: number;
  /** Present only when `ask` resolved it in the source window; absent means read the
   * setting live. */
  provider?: AgentProvider;
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

These are the only repos checked out for this task. A repo named anywhere else in this
brief — the ticket description included — is a suggestion, not scope: do not go looking
for it or clone it. Work in the repos listed above, and say so if the task genuinely
cannot be done within them.
`;
}

/** Write `.pick-task/TASK.md` into each of `services` — worktrees that get a brief but
 *  deliberately no window, which is what a child worktree is: its subagent is
 *  dispatched by the parent's session, not opened by us.
 *
 *  `planMd` arrives already rendered (engine/brief's `briefMarkdown`), the same way
 *  `openWorkspace` receives it, so the two paths cannot drift into producing different
 *  briefs. Best-effort per repo: one unwritable worktree must not cost the others
 *  theirs. Returns the files it wrote.
 *
 *  Deliberately no `ensureGitExcluded` call: it follows a worktree's `commondir` and
 *  writes to the repo's SHARED `info/exclude` (see gitExclude.ts), so the entry
 *  `openWorkspace` writes later in the same take covers every worktree of that repo,
 *  children included — one entry, not one per worktree. Until then the brief shows as
 *  untracked inside the child worktree, and it stays that way if the take ends early at
 *  one of `launch`'s own pickers. That transient window is the price of keeping this
 *  helper to one responsibility. */
export function writeBriefInto(
  services: ServiceRef[],
  ticket: TicketRef,
  planMd: string,
  log: (m: string) => void,
): string[] {
  const written: string[] = [];
  for (const s of services) {
    try {
      const dir = path.join(s.path, BRIEF_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, BRIEF_FILE);
      // `[s]` and `s.name`, not the whole set: a child's brief names the one worktree
      // its subagent works in, so "Repos in scope" must not list the siblings it is
      // being kept out of. No file hints either — those come from the ticket
      // description resolved against a repo, and the caller has already rendered the
      // description into `planMd`.
      fs.writeFileSync(file, briefMarkdown(ticket, planMd, [s], s.name, []));
      written.push(file);
    } catch (e) {
      log(`brief ${s.name}: could not write into ${s.path} (${e})`);
    }
  }
  return written;
}

/** The filename one attachment lands under: its own name, unless an earlier
 * attachment in the same launch already claimed that name, in which case the source
 * file's stem is folded in. Deterministic and exported because the brief NAMES these
 * paths — the copy and the text have to agree, and they are produced by different
 * callers (this module writes the files, tasksView writes the lines). */
export function attachmentFileName(all: readonly { path: string; name: string }[], index: number): string {
  const att = all[index];
  const claimedEarlier = all.slice(0, index).some((a) => a.name === att.name);
  if (!claimedEarlier) return att.name;
  const stem = path.basename(att.path, path.extname(att.path));
  const ext = path.extname(att.name);
  return `${path.basename(att.name, ext)}-${stem}${ext}`;
}

/** Where one attachment sits under the brief's `images/` directory: `<run key>/<name>`.
 *
 * The run key is load-bearing, not decoration. `attachmentFileName` de-duplicates within
 * ONE launch's list, which is all a single launch needs and nothing a second launch can
 * use — and several tasks share a checkout routinely (a repo taken twice, a note taken
 * beside a running one). Every pasted screenshot is called `image.png`, because that is
 * what `saveImage` names a note's clipboard paste, so two notes taken into one repo used
 * to land on the same `images/image.png`: the later take silently replaced the earlier
 * agent's screenshot, and an agent reads that file when it gets to it, not when it is
 * launched. Keying the directory by run separates them without deleting anything, which
 * matters precisely because the other agent may still be working.
 *
 * Re-taking the SAME note reuses its key and so overwrites its own directory — the same
 * "a re-run replaces that note's own record" rule the run store follows.
 *
 * Always "/"-joined: the return value goes into brief and prompt text, where the path is
 * repo-relative markdown and git-style POSIX, never `path.sep`. Callers writing files
 * split it back into segments. */
export function attachmentRelPath(runKey: string, all: readonly { path: string; name: string }[], index: number): string {
  return `${attachmentDirName(runKey)}/${attachmentFileName(all, index)}`;
}

/** The run key as ONE path segment. Keys reaching a filesystem path is not new — worktree
 * folders are `<repo>-<KEY>` — but a key becoming a directory here is, and the keys are
 * built from free text (a notepad title) or handed over by a task source, so anything that
 * could climb out of `images/` or split into a second segment is folded to a dash rather
 * than trusted. The slug shape matches `slugify`/`branchName`, minus their length cap: the
 * key is already bounded by the callers that build it. */
function attachmentDirName(runKey: string): string {
  return runKey.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "task";
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
  // Resolve the agent before anything is created. Under the three fixed settings this
  // is a plain read and the plan file carries no provider, so the target window keeps
  // reading the preference live at seed time — flipping the setting still affects
  // plans already on disk. Only `ask` pins a choice into the plan, because by then
  // there is no preference left for the target window to read.
  const setting = readAgentProviderSetting();
  // A caller's pin (`OpenRequest.provider`) means "resolve to this INSTEAD OF
  // PROMPTING", so it applies under `ask` and nowhere else. Under a fixed setting
  // there is no prompt to suppress and the user's explicit preference wins: an
  // Orchestrator rule that pins Claude Code purely to avoid a dialog must still seed
  // Cursor for a user whose setting says `cursor`. Honouring it there would also split
  // the answer in two — a fixed setting writes no provider into the plan, so the target
  // window would seed the setting while `OpenResult.provider` named the pin, and the
  // toast would contradict the session the user is looking at. The invariant this
  // upholds, and the one every caller may rely on: `OpenResult.provider` is always what
  // the target window will actually seed, on every path.
  let pinned: AgentProvider | undefined = setting === "ask" ? req.provider : undefined;
  if (seedAgent && !pinned && setting === "ask") {
    // A one-item picker is not a question. On a host that is neither VS Code nor
    // Cursor, `hostProviders()` is exactly `["claude-code"]`, and a modal held open by
    // `ignoreFocusOut` that can be answered only one way is pure friction on every
    // launch. Short-circuited HERE rather than in `hostProviders`, which is read as a
    // capability LIST elsewhere — Doctor feeds it straight into `DoctorInputs` to
    // decide which agents' rows to show under `ask` — and must keep answering "what
    // can this host run", not "should we prompt".
    const choices = hostProviders();
    if (choices.length === 1) {
      pinned = choices[0];
    } else {
      const choice = await vscode.window.showQuickPick(
        choices.map((p) => ({ label: providerLabel(p), provider: p })),
        { title: "Which tool?", placeHolder: "Pick the tool to start this session with", ignoreFocusOut: true },
      );
      // Dismissed: the user cancelled the launch itself. Nothing has been created yet,
      // so returning here leaves no window, no worktree, no brief and no plan behind.
      if (!choice) {
        return { mode, briefs: [], opened: [], remoteControl: false, provider: "claude-code", cancelled: true };
      }
      pinned = choice.provider;
    }
  }
  const provider: AgentProvider = pinned ?? resolvedProvider(setting);
  // Written into the plan only when `ask` produced it — see the comment above.
  const planProvider = setting === "ask" ? provider : undefined;
  // "This window" only means anything if this window can be named by a plan match.
  // Without an identity there is nothing to seed, so the request degrades to the
  // normal open path rather than silently doing nothing.
  const here = req.openIn === "current" ? req.currentWindow : undefined;
  // Every seed site below renders through this, so the suffix reaches each window the
  // launch opens — a per-window launch seeds one prompt per repo, and a note's detail
  // belongs in all of them.
  const suffix = req.promptSuffix?.trim() ? `\n\n${req.promptSuffix.trim()}` : "";
  const seedPrompt = (mentions: string[], briefPath?: string): string =>
    agentPrompt(ticket, mentions, promptTemplate, briefPath) + suffix;
  const hints = extractFileHints(descriptionText);
  const filesByRepo = new Map(services.map((s) => [s.name, resolveFilesInRepo(s.path, hints)]));

  // 1 — briefs + git-exclude
  const briefs = services.map((s) => {
    const files = filesByRepo.get(s.name) ?? [];
    const dir = path.join(s.path, BRIEF_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const briefPath = path.join(dir, BRIEF_FILE);
    // Unconditional by default — see `keepExistingBrief` for the one caller that must
    // not clobber a brief an agent is already working from. The path is reported either
    // way, so a kept brief still resolves the seeded prompt's `{brief}`.
    if (!(req.keepExistingBrief && fs.existsSync(briefPath))) {
      fs.writeFileSync(briefPath, briefMarkdown(ticket, planMd, services, s.name, files));
    }
    // Attachments ride with the brief because they are part of it: the brief names
    // their repo-relative paths, so they have to exist in EVERY repo the launch
    // seeds, not only the first. Written even when the brief itself was kept — a
    // kept brief still resolves those paths.
    const attachments = req.attachments ?? [];
    if (attachments.length > 0) {
      const imagesDir = path.join(dir, "images");
      for (const [i, att] of attachments.entries()) {
        // `attachmentRelPath` is "/"-joined for the brief text; split it back out so the
        // directory it names is created and written with this platform's separator.
        const target = path.join(imagesDir, ...attachmentRelPath(ticket.key, attachments, i).split("/"));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(att.path, target);
      }
    }
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
    // them: `@webapp/src/x.ts` when webapp isn't a root here would send the agent to a
    // different checkout, which is worse than no mention at all. `{brief}` is absolute
    // for the same reason its relative form can't be trusted off-root.
    const mentions = services.flatMap((s) =>
      (filesByRepo.get(s.name) ?? [])
        .map((f) => mentionInWorkspace(here.roots, s.path, f))
        .filter((m): m is string => !!m),
    );
    matches.push({
      matchPath: here.identity,
      prompt: seedPrompt(mentions, briefs[0]?.path),
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
      prompt: seedPrompt(mentions, briefs[0]?.path),
    });
  } else if (req.existingFolder) {
    const folder = req.existingFolder;
    // Focus an already-open folder window and seed there. VS Code offers no way to
    // inject roots into a folder window remotely, so its folder set is unchanged;
    // ensure a brief exists IN that folder so the seeded relative {brief} resolves.
    //
    // `absoluteBrief` skips that entirely, because for its one caller the fallback is
    // destructive rather than helpful: a review's brief belongs in the review worktree,
    // and this folder is a repo someone else's agent is working in — writing here
    // clobbers the brief that agent was given and then points this launch's `{brief}`
    // at it. Naming our own brief absolutely resolves from any cwd, so nothing is lost.
    if (!req.absoluteBrief && !services.some((s) => canon(s.path) === canon(folder))) {
      const dir = path.join(folder, BRIEF_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const fallbackBrief = path.join(dir, BRIEF_FILE);
      // The second write site, and it needs the same guard for the same reason: this
      // folder is a window someone is already working in.
      if (!(req.keepExistingBrief && fs.existsSync(fallbackBrief))) {
        fs.writeFileSync(fallbackBrief, briefMarkdown(ticket, planMd, services, path.basename(folder), []));
      }
      ensureGitExcluded(folder, `${BRIEF_DIR}/`);
    }
    unaddedRepos = services.filter((s) => canon(s.path) !== canon(folder)).map((s) => s.name);
    const mentions = services.flatMap((s) => (filesByRepo.get(s.name) ?? []).map((f) => mention("per-window", s.name, f)));
    matches.push({ matchPath: folder, prompt: seedPrompt(mentions, req.absoluteBrief ? briefs[0]?.path : undefined) });
  } else if (mode === "multiroot") {
    fs.mkdirSync(workspaceDir, { recursive: true });
    workspaceFile = path.join(workspaceDir, `${ticket.key}.code-workspace`);
    // One name per root, computed once: the folder the file declares and the folder an
    // `@mention` names have to be the same string, or the mention resolves to nothing.
    const names = new Map(services.map((s) => [s.name, serviceFolderName(ticket.key, s)]));
    fs.writeFileSync(
      workspaceFile,
      JSON.stringify(
        { folders: services.map((s) => ({ name: names.get(s.name)!, path: s.path })), settings: {} },
        null,
        2,
      ) + "\n",
    );
    const mentions = services.flatMap((s) =>
      (filesByRepo.get(s.name) ?? []).map((f) => mention("multiroot", names.get(s.name)!, f)),
    );
    matches.push({ matchPath: workspaceFile, prompt: seedPrompt(mentions) });
  } else {
    for (const s of services) {
      const mentions = (filesByRepo.get(s.name) ?? []).map((f) => mention("per-window", s.name, f));
      matches.push({ matchPath: s.path, prompt: seedPrompt(mentions) });
    }
  }

  // One clipboard, one window. A launch that opens several windows would leave every
  // window but the last pasting another task's brief, so withhold it entirely. Also
  // withhold it when seedAgent is off: nothing seeds without a plan file (below), so
  // "applies" must never be true when no plan file will carry it. And it is Claude
  // Code's feature alone, so a non-Claude agent withholds it too — under `ask` this is
  // where a Copilot or Cursor pick drops it. Dropping is right where refusing would be
  // wrong: the user made that choice interactively moments ago, and `remoteControl`
  // already feeds `seededNote`, so the toast corrects itself with no new message.
  const remoteControl = !!req.remoteControl && seedAgent && matches.length === 1 && provider === "claude-code";

  // 3 — durable writes BEFORE opening: a window that opens (or is focused) and seeds
  //     can otherwise race these to disk, so nothing may be opened before this lands.
  if (seedAgent) {
    writePlanFile({ key: ticket.key, createdAt: Date.now(), seedAgent: true, remoteControl, provider: planProvider, matches });
  }
  if (req.recordRun !== false) {
    const run: Run = {
      key: ticket.key,
      summary: ticket.summary,
      url: ticket.url,
      createdAt: Date.now(),
      kind: req.kind,
      ...(seedAgent ? { provider } : {}),
      mode: effMode,
      workspaceFile,
      repos: services.map((s) => ({
        name: s.name,
        path: s.path,
        isGit: s.isGit,
        branch: gitState(s.name, s.path).branch ?? undefined,
      })),
      briefPaths: briefs.map((b) => b.path),
      ...(req.parentKey ? { parentKey: req.parentKey } : {}),
      ...(req.children?.length ? { children: req.children } : {}),
    };
    try {
      writeRun(defaultRunsDir(), run);
    } catch {
      /* the Deck record is best-effort — never fail a take over it */
    }
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

  return { mode: effMode, workspaceFile, briefs, opened, mergedRepos, mergeFailed, unaddedRepos, remoteControl, seededInPlace: !!here, provider };
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
  // does — a raw relative "webapp" would contain nothing. Only the path is needed here,
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
 *  a worktree's label is key-qualified (`api-PROJ-1`) but must still dedup against a
 *  folder the workspace already calls `api`. */
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
 *  the caller drops the mention: `@webapp/src/x.ts` when the root named `webapp` is
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

/** The agent to seed with, resolved in the target window at seed time. A plan carries
 *  `provider` only when `ask` resolved it in the source window; otherwise the setting
 *  is read live, which is what makes flipping the preference affect plans already on
 *  disk. A bare `ask` reaching here means the plan predates its own resolution — a
 *  settings flip inside the 15-minute PLAN_TTL_MS window — so it degrades to the one
 *  agent every host can run rather than putting a dialog in a window the user was not
 *  expecting one in. */
function seedProvider(plan: PlanFile): AgentProvider {
  return plan.provider ?? resolvedProvider(readAgentProviderSetting());
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
      // A plan that cannot be parsed will never seed — clear it the way the
      // expired branch below already clears stale ones. These files are
      // transient 15-minute handshakes; leaving one wedges nothing, but it
      // would sit there forever.
      fs.rmSync(full, { force: true });
      continue;
    }
    // Everything past the parse is wrapped too: one malformed plan (e.g. no
    // `matches`) used to throw out of the whole pass, blocking every other
    // plan in every window — and with a corrupt createdAt its TTL never
    // elapsed, so the wedge was permanent.
    try {
      const age = now - plan.createdAt;
      // NaN (missing/corrupt createdAt) and a future stamp both read as
      // expired — either way the 15-minute TTL could otherwise never elapse.
      if (!(age >= 0) || age > PLAN_TTL_MS) {
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
    } catch {
      fs.rmSync(full, { force: true });
    }
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
      provider: seedProvider(plan),
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

/** Open a chat panel with the prompt pre-filled and unsubmitted. Serves both Copilot
 * and Cursor: they register the same command id, `workbench.action.chat.open`. Polls
 * for it because Agent Flow and the chat extension both activate on
 * `onStartupFinished`, so the same activation race applies to either host.
 *
 * There is no URI-handler rung here — neither publishes a documented
 * open-with-prompt URI we are willing to use. Cursor does register
 * `deeplink.prompt.prefill`, but it raises a "Create chat with prompt" confirmation
 * modal before doing anything, which is worse than the clipboard fallback below. So a
 * false return means the caller should fall back to the clipboard.
 *
 * `multi` forks by provider, because their handlers differ:
 *   - Copilot's chat panel is single-instance, so a batch of N tasks would each
 *     overwrite the previous prompt and the user would silently end up with only the
 *     last one seeded. It bails immediately, sending the caller down its existing
 *     `multi` fallback: the "briefs are in .pick-task/" notification.
 *   - Cursor's handler calls `createComposer({ openInNewTab: true })`, so each call
 *     gets its own composer tab and a batch seeds correctly. It proceeds. */
async function seedChatPanel(
  provider: AgentProvider,
  seedText: string,
  key: string,
  log: (m: string) => void,
  multi = false,
): Promise<boolean> {
  if (multi && provider === "copilot") {
    log(`seed ${key}: per-task Copilot chat tabs are not wired up yet — batch falls back to the briefs`);
    return false;
  }
  // Command presence proves nothing on a modern host: core VS Code registers
  // workbench.action.chat.open (its built-in chat framework) even with no chat
  // extension installed, and executing it then "succeeds" while opening nothing
  // the user can see — a silently unseeded take. Only the extension that
  // actually provides the panel makes the command mean what this function
  // promises. Cursor is exempt: its chat is the host's own, not an extension.
  if (provider === "copilot" && !vscode.extensions.getExtension("GitHub.copilot-chat")) {
    log(`seed ${key}: GitHub Copilot Chat is not installed — falling back to the clipboard`);
    return false;
  }
  // Copilot's product name for the chat panel itself is "Copilot Chat", distinct
  // from providerLabel's generic "Copilot" used everywhere else (toasts, session
  // names) — this line predates providerLabel and keeps its original wording so the
  // emitted log stays byte-identical to what shipped before Cursor existed.
  const label = provider === "copilot" ? "Copilot Chat" : providerLabel(provider);
  for (let attempt = 1; attempt <= 7; attempt++) {
    let cmds: string[];
    try {
      cmds = await vscode.commands.getCommands(true);
    } catch (e) {
      log(`seed ${key}: ${provider} command attempt ${attempt} threw: ${e}`);
      await delay(700);
      continue;
    }
    if (!cmds.includes(CHAT_OPEN_CMD)) {
      await delay(700);
      continue;
    }
    // The command is registered, so any throw from here on is a real failure on its
    // merits rather than the activation race this loop exists to ride out. Retrying
    // would stall ~4.9s and could reopen the panel on every attempt, so try exactly
    // once and fall through to the clipboard fallback below.
    try {
      await vscode.commands.executeCommand(CHAT_OPEN_CMD, {
        query: seedText,
        isPartialQuery: true,
        mode: "agent",
      });
      log(`seed ${key}: opened ${label} via ${CHAT_OPEN_CMD} (attempt ${attempt})`);
      return true;
    } catch (e) {
      log(`seed ${key}: ${CHAT_OPEN_CMD} is registered but threw — not retrying: ${e}`);
      return false;
    }
  }
  log(`seed ${key}: no chat command registered — falling back to the clipboard`);
  return false;
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
  /** Already resolved by seedProvider, in this window, at seed time — the plan's own
   *  choice if it carried one, otherwise the live setting. */
  provider: AgentProvider;
}): Promise<void> {
  const { prompt, key, matchPath, log, remoteControl = false, multi = false, provider } = opts;

  // `/remote-control` is a Claude Code slash command; every other agent would seed it
  // as literal prompt text. tasksView already refuses the combination pre-flight, but
  // a plan file written under Claude Code can outlive a flip to Copilot or Cursor —
  // the plan does not carry the provider, it is re-read here — so the block is
  // repeated at the last moment before anything is seeded. Refuse rather than
  // silently drop one of the two. Only this exact pair is refused: an ordinary
  // non-Claude seed falls straight through. The advice has to name re-taking the
  // task, not just the settings change: the caller sets this plan's `seeded:` guard
  // BEFORE calling us (see runSeedPass), and nothing clears it short of PLAN_TTL_MS —
  // so fixing the setting and reloading would find the plan already consumed and seed
  // nothing. Telling the user to reload would be telling them to do something that
  // cannot work.
  if (remoteControl && provider !== "claude-code") {
    log(`seed ${key}: refused — Remote Control needs Claude Code`);
    vscode.window.showErrorMessage(
      `Agent Flow Deck: ${key} not seeded — Remote Control needs Claude Code. Set agentFlow.agentProvider to claude-code (or turn agentFlow.remoteControl off), then take ${key} again — reloading this window won't re-seed it.`,
    );
    return;
  }

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

  // The surface is read here, in the target window, at seed time — never carried in
  // the plan file. Flipping it therefore also affects plans already on disk, which is
  // what a preference should do. The provider is resolved the same way, one level up
  // in seedProvider, which also gets to honor a plan's own recorded choice.
  //
  // Codex has no extension surface: workbench.action.chat.open belongs to Copilot
  // and Cursor, and Codex's IDE extension publishes no open-with-prompt command —
  // so under either surface setting a Codex seed lands in a terminal.
  if (readAgentSurface() === "terminal" || provider === "codex") {
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
  } else if (await seedChatPanel(provider, seedText, key, log, multi)) {
    announceRemoteControl();
    return;
  }

  // 3 — fallback. One clipboard can't carry N prompts, so a batch gets a pointer to
  // the briefs instead — they hold the same context and sit in the window's roots.
  if (multi) {
    vscode.window.showInformationMessage(
      `Agent Flow Deck: couldn't start ${providerLabel(provider)} for ${key}. Its brief is in ${BRIEF_DIR}/${BRIEF_FILE} — open it to start the task.`,
    );
    log(`seed ${key}: no ${providerLabel(provider)} available — pointed at the brief (batch, clipboard withheld)`);
    return;
  }
  if (remoteControl) log(`seed ${key}: Remote Control dropped — the clipboard is needed for the prompt`);
  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    `Agent Flow Deck: opened workspace for ${key}. ${providerLabel(provider)} prompt copied — paste it into the panel to start.`,
  );
  log(`seed ${key}: fell back to clipboard`);
}
