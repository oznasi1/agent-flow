import * as fs from "fs";
import * as path from "path";
import { Run, ServiceRef, WorkspaceMode } from "../types";
import { extractFileHints, resolveFilesInRepo, mention } from "./files";
import { ensureGitExcluded } from "./gitExclude";
import { gitState } from "./git";
import { writeRun, defaultRunsDir } from "./runs";
import {
  BRIEF_DIR,
  BRIEF_FILE,
  TicketRef,
  agentPrompt,
  briefMarkdown,
  mergeReposIntoWorkspace,
  openInEditor,
  writePlanFile,
} from "./workspace";

export interface BatchTask {
  ticket: TicketRef;
  planMd: string;
  descriptionText: string;
  /** Already resolved to per-task worktrees by the caller. */
  services: ServiceRef[];
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
}

export interface SharedOpenResult {
  workspaceFile?: string;
  opened: boolean;
  briefs: { key: string; repo: string; path: string; gitExcluded: boolean; files: number }[];
  mergedFolders?: string[]; // folders appended to an existing workspace
  mergeFailed?: boolean; // existing workspace couldn't be parsed; opened as-is
  unaddedFolders?: string[]; // live-folder: roots VS Code can't inject remotely
  seeded: number; // plan files written
}

/** A task's worktree as a workspace folder. The key qualifier is load-bearing: two
 * tasks in one repo would otherwise present as two identically-named roots, and the
 * folder name is what an `@mention` resolves against. */
function folderName(key: string, repo: string): string {
  return `${key}-${repo}`;
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

  // 2 — every worktree as a workspace folder, key-qualified.
  const folders = tasks.flatMap((t) =>
    t.services.map((s) => ({ name: folderName(t.ticket.key, s.name), path: s.path })),
  );

  // 3 — resolve the destination into a single match path.
  let workspaceFile: string | undefined;
  let mergedFolders: string[] | undefined;
  let mergeFailed: boolean | undefined;
  let unaddedFolders: string[] | undefined;
  let openTarget: string;
  if (target.kind === "existing") {
    const merge = mergeReposIntoWorkspace(
      target.file,
      folders.map((f) => ({ name: f.name, path: f.path, isGit: true })),
    );
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
  // The live-folder destination never gets the worktrees (above), and a failed merge
  // never wrote them into the existing workspace either — in both cases the qualified
  // form names nothing, so fall back to the bare relative form the single-task
  // existingFolder path uses (workspace.ts).
  const mentionMode: WorkspaceMode = workspaceFile && !mergeFailed ? "multiroot" : "per-window";

  // 4 — one plan + one run per task, all naming the same window. Durable writes come
  //     before the open: reusing the current window reloads this extension host.
  const createdAt = Date.now();

  // The plan files must land back-to-back: the plan-dir watcher debounces 300ms after
  // the last event and seeds whatever one pass collects, and a pass holding a single
  // plan opens a plain session instead of stacking tabs in one Claude group. Writing
  // the Run records in the same loop would put gitState's four git subprocesses per
  // repo between consecutive plans — easily past the debounce.
  if (seedAgent) {
    tasks.forEach((t, i) => {
      const mentions = t.services.flatMap((s) =>
        (filesByPair.get(`${t.ticket.key}:${s.name}`) ?? []).map((f) =>
          mention(mentionMode, folderName(t.ticket.key, s.name), f),
        ),
      );
      // Absolute, not the usual relative path: N worktree roots each hold
      // `.pick-task/TASK.md`, so a relative reference names no file in particular.
      const prompt = agentPrompt(t.ticket, mentions, promptTemplate, briefPathFor.get(t.ticket.key));
      // Remote Control is never offered here — one clipboard can't serve N sessions.
      writePlanFile({ key: t.ticket.key, createdAt, seedAgent: true, seq: i, matches: [{ matchPath, prompt }] });
    });
  }

  tasks.forEach((t) => {
    const run: Run = {
      key: t.ticket.key,
      summary: t.ticket.summary,
      url: t.ticket.url,
      createdAt,
      mode: workspaceFile ? "multiroot" : "per-window",
      workspaceFile,
      repos: t.services.map((s) => ({
        name: s.name,
        path: s.path,
        isGit: s.isGit,
        branch: gitState(s.name, s.path).branch ?? undefined,
      })),
      briefPaths: briefs.filter((b) => b.key === t.ticket.key).map((b) => b.path),
    };
    try {
      writeRun(defaultRunsDir(), run);
    } catch {
      /* the Deck record is best-effort — never fail a launch over it */
    }
  });

  // 5 — open once.
  const opened = await openInEditor(openTarget, target.kind !== "current");
  return {
    workspaceFile,
    opened,
    briefs,
    mergedFolders,
    mergeFailed,
    unaddedFolders,
    seeded: seedAgent ? tasks.length : 0,
  };
}
