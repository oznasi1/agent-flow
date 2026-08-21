import * as fs from "fs";
import * as path from "path";
import { Run, ServiceRef } from "../types";
import { readAgentProviderSetting, resolvedProvider } from "../config";
import { extractFileHints, resolveFilesInRepo, mention } from "./files";
import { ensureGitExcluded } from "./gitExclude";
import { folderName } from "./worktree";
import { gitState } from "./git";
import { writeRun, defaultRunsDir } from "./runs";
import {
  BRIEF_DIR,
  BRIEF_FILE,
  PlanFile,
  TicketRef,
  agentPrompt,
  briefMarkdown,
  mentionInWorkspace,
  mergeReposIntoWorkspace,
  openInEditor,
  workspaceFolders,
  writePlanFile,
} from "./workspace";
import { type CurrentWindow } from "./presence";

export interface BatchTask {
  ticket: TicketRef;
  planMd: string;
  descriptionText: string;
  /** Already resolved to per-task worktrees by the caller. */
  services: ServiceRef[];
  /** The parent ticket this task was fanned out from, when it was. Reaches the run
   *  record unchanged; see `Run.parentKey`. */
  parentKey?: string;
  /** What launched this run, written straight onto the Run record. Reviews pass
   *  "review" — `decorateReviews` matches a row to its run with
   *  `runKind(r) === "review"`, and `Run.kind` is also what keeps a run carrying a
   *  PR url out of Jira polling. Absent means "task", exactly as before. */
  kind?: Run["kind"];
}

export type SharedTarget =
  | { kind: "new" }
  | { kind: "current" }
  | { kind: "existing"; file: string }
  | { kind: "live-folder"; folder: string };

export interface SharedOpenRequest {
  tasks: BatchTask[];
  promptTemplate: string;
  workspaceDir: string;
  seedAgent: boolean;
  target: SharedTarget;
  /** This window's identity + roots. REQUIRED when `target.kind` is "current" — without
   *  it there is no plan match that names this window, so nothing would seed. */
  currentWindow?: CurrentWindow;
  /** Folders the user approved adding to an `existing` target — the ONLY thing merged.
   *  Absent or empty leaves that workspace file byte-identical. */
  foldersToAdd?: { name: string; path: string }[];
  /** The agent the caller resolved for this batch, stamped onto every plan file. Set
   *  ONLY under `agentFlow.agentProvider: "ask"`, where the target window has no
   *  preference left to read and would otherwise degrade the whole batch to Claude
   *  Code — seeding an agent the user did not pick, minutes after they picked one.
   *  Absent under a fixed setting, so the plan files stay byte-identical and the target
   *  window keeps reading the setting live at seed time. Exactly the split
   *  `openWorkspace` makes with its own `planProvider`. */
  provider?: PlanFile["provider"];
}

export interface SharedOpenResult {
  workspaceFile?: string;
  opened: boolean;
  briefs: { key: string; repo: string; path: string; gitExcluded: boolean; files: number }[];
  mergedFolders?: string[]; // folders appended to an existing workspace
  mergeFailed?: boolean; // existing workspace couldn't be parsed; opened as-is
  unaddedFolders?: string[]; // live-folder: roots VS Code can't inject remotely
  seeded: number; // plan files written
  seededInPlace?: boolean; // "current": this window was seeded as-is; nothing was opened
}

/**
 * Open ONE window holding every task's worktrees, with a Claude session seeded per
 * task. `openWorkspace` can't do this by being called N times — each call would
 * rewrite and reopen the same destination — so the whole batch is assembled here and
 * opened once. The N plan files all name the same matchPath; `maybeSeedAgent` seeds
 * every one of them in that window.
 */
export async function openSharedWorkspace(req: SharedOpenRequest): Promise<SharedOpenResult> {
  const { tasks, promptTemplate, workspaceDir, seedAgent, target } = req;
  const here = target.kind === "current" ? req.currentWindow : undefined;

  // 1 — a brief per task-service pair. Every service is a per-task worktree, so no
  //     two tasks share a brief path.
  const briefs: SharedOpenResult["briefs"] = [];
  const briefPathFor = new Map<string, string>(); // task key → its first brief, for {brief}
  const filesByPair = new Map<string, string[]>(); // `${key}:${repo}` → matched files
  for (const t of tasks) {
    const hints = extractFileHints(t.descriptionText);
    for (const s of t.services) {
      const files = resolveFilesInRepo(s.path, hints);
      filesByPair.set(`${t.ticket.key}:${s.name}`, files);
      const dir = path.join(s.path, BRIEF_DIR);
      fs.mkdirSync(dir, { recursive: true });
      const briefPath = path.join(dir, BRIEF_FILE);
      fs.writeFileSync(briefPath, briefMarkdown(t.ticket, t.planMd, t.services, s.name, files));
      if (!briefPathFor.has(t.ticket.key)) briefPathFor.set(t.ticket.key, briefPath);
      briefs.push({
        key: t.ticket.key,
        repo: s.name,
        path: briefPath,
        gitExcluded: ensureGitExcluded(s.path, `${BRIEF_DIR}/`),
        files: files.length,
      });
    }
  }

  // 2 — every worktree as a workspace folder, named `<repo>-<KEY>`.
  const folders = tasks.flatMap((t) =>
    t.services.map((s) => ({ name: folderName(t.ticket.key, s.name), path: s.path })),
  );

  // 3 — resolve the destination into a single match path.
  let workspaceFile: string | undefined;
  let mergedFolders: string[] | undefined;
  let mergeFailed: boolean | undefined;
  let unaddedFolders: string[] | undefined;
  let openTarget: string;
  if (here) {
    // Seed this window as it stands — no workspace file, nothing opened. The worktrees
    // aren't roots here unless they happen to sit inside one, exactly as with any other
    // already-open destination; the absolute brief paths carry the context regardless.
    openTarget = here.identity;
  } else if (target.kind === "existing") {
    const merge = mergeReposIntoWorkspace(target.file, req.foldersToAdd ?? []);
    mergedFolders = merge.added;
    mergeFailed = merge.ok ? undefined : true;
    workspaceFile = target.file;
    openTarget = target.file;
  } else if (target.kind === "live-folder") {
    // VS Code offers no way to inject roots into another window, so the worktrees
    // stay out of it. The seeded prompts carry absolute brief paths, so the agents
    // can still read their context from there.
    unaddedFolders = folders.map((f) => f.name);
    openTarget = target.folder;
  } else {
    fs.mkdirSync(workspaceDir, { recursive: true });
    const first = tasks[0].ticket.key;
    workspaceFile = path.join(workspaceDir, `${first}+${tasks.length - 1}.code-workspace`);
    fs.writeFileSync(workspaceFile, JSON.stringify({ folders, settings: {} }, null, 2) + "\n");
    openTarget = workspaceFile;
  }
  const matchPath = workspaceFile ?? openTarget;
  // A `@<folder>/<rel>` mention only resolves against a root the window actually has.
  // For an existing workspace the roots are whatever it declares plus whatever was just
  // merged, so resolve each repo against them: a worktree inside a declared root gets a
  // precise mention, and a repo inside none gets no mention at all rather than one that
  // silently names a different checkout. An unparseable file falls to `?? []`, so every
  // candidate matches no root and gets no mention at all — deliberate, not the old code's
  // bare `@rel` fallback. The live-folder destination never gets the worktrees, and a
  // freshly written workspace has every folder as a root.
  // "current" resolves against the roots this window actually has, for the same reason
  // "existing" resolves against the file's: a mention naming a root the window doesn't
  // have silently points at a different checkout.
  const roots = here ? here.roots : target.kind === "existing" ? workspaceFolders(target.file) ?? [] : undefined;
  const mentionsFor = (key: string, s: ServiceRef, files: string[]): string[] =>
    roots
      ? files.map((f) => mentionInWorkspace(roots, s.path, f)).filter((m): m is string => !!m)
      : files.map((f) => mention(workspaceFile ? "multiroot" : "per-window", folderName(key, s.name), f));

  // 4 — one plan + one run per task, all naming the same window. Durable writes come
  //     before the open: a window that opens (or is focused) and seeds can otherwise
  //     race these to disk, so nothing may be opened before this lands.
  const createdAt = Date.now();

  // The plan files must land back-to-back: the plan-dir watcher debounces 300ms after
  // the last event and seeds whatever one pass collects, and a pass holding a single
  // plan opens a plain session instead of stacking tabs in one Claude group. Writing
  // the Run records in the same loop would put gitState's four git subprocesses per
  // repo between consecutive plans — easily past the debounce.
  if (seedAgent) {
    tasks.forEach((t, i) => {
      const mentions = t.services.flatMap((s) =>
        mentionsFor(t.ticket.key, s, filesByPair.get(`${t.ticket.key}:${s.name}`) ?? []),
      );
      // Absolute, not the usual relative path: N worktree roots each hold
      // `.pick-task/TASK.md`, so a relative reference names no file in particular.
      const prompt = agentPrompt(t.ticket, mentions, promptTemplate, briefPathFor.get(t.ticket.key));
      // Remote Control is never offered here — one clipboard can't serve N sessions.
      // The pin is spread rather than written as `provider: req.provider`, so a batch
      // under a fixed setting produces the plan file it always produced: absent is how
      // "read the setting live" is spelled, and `undefined` would serialize as a
      // missing key anyway only by accident of JSON.stringify.
      writePlanFile({
        key: t.ticket.key, createdAt, seedAgent: true, seq: i, matches: [{ matchPath, prompt }],
        ...(req.provider ? { provider: req.provider } : {}),
      });
    });
  }

  // One resolution for the whole batch: `req.provider` is the pin `ask` produced, and a
  // fixed setting is read here rather than per task, because every task in one batch is
  // seeded by the same launch and cannot disagree about its agent.
  const provider = seedAgent ? (req.provider ?? resolvedProvider(readAgentProviderSetting())) : undefined;

  tasks.forEach((t) => {
    const run: Run = {
      key: t.ticket.key,
      summary: t.ticket.summary,
      url: t.ticket.url,
      createdAt,
      ...(provider ? { provider } : {}),
      // Spread-conditional, not `kind: t.kind`: absent is how "task" is spelled on
      // every record a task batch has ever written, and this keeps those bytes identical.
      ...(t.kind ? { kind: t.kind } : {}),
      mode: here ? (here.kind === "workspace" ? "multiroot" : "per-window") : workspaceFile ? "multiroot" : "per-window",
      workspaceFile,
      repos: t.services.map((s) => ({
        name: s.name,
        path: s.path,
        isGit: s.isGit,
        branch: gitState(s.name, s.path).branch ?? undefined,
      })),
      briefPaths: briefs.filter((b) => b.key === t.ticket.key).map((b) => b.path),
      ...(t.parentKey ? { parentKey: t.parentKey } : {}),
    };
    try {
      writeRun(defaultRunsDir(), run);
    } catch {
      /* the Deck record is best-effort — never fail a launch over it */
    }
  });

  // 5 — open once, unless the destination is the window we're already in.
  const opened = here ? true : await openInEditor(openTarget);
  return {
    workspaceFile,
    opened,
    briefs,
    mergedFolders,
    mergeFailed,
    unaddedFolders,
    seeded: seedAgent ? tasks.length : 0,
    seededInPlace: !!here,
  };
}
