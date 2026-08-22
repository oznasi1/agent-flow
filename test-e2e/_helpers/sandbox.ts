import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface Sandbox {
  root: string;
  home: string; // child HOME — ~/.agentflow lands here, never in the real one
  userDataDir: string;
  extensionsDir: string;
  fixtureDir: string;
  reposRoot: string;
  repoPath: string; // the one temp git repo, named "rocket"
  dispose(): void;
}

/** The task the journey takes. The summary CONTAINS the repo name ("rocket") on
 *  purpose: `inferServices` matches repo names against the task text, so the
 *  repo-confirm QuickPick opens with this repo pre-checked and a single Enter
 *  confirms it. */
// `inOpenSprint: true` is actually inert — recorded here so nobody "fixes" it
// away expecting a behavior change. The fixture connector's `list()` ignores
// the lens argument entirely and returns both tasks regardless of which lens
// is selected; `showAddToSprint` (App.tsx:782) keys off `unassigned`, not
// `inOpenSprint`; and `onRemoveFromSprint` (App.tsx:684) keys off the ACTIVE
// LENS, not this field. So the "My sprint" lens shows both fixture cards no
// matter what this flag is set to, and the reorder/reset-order/remove-from-
// sprint journeys below never actually prove sprint membership — only that
// card ordering persists within a lens, and that the remove affordance fires.
export const FIXTURE_TASK = {
  key: "E2E-1", summary: "Fix the rocket telemetry panel", status: "To Do",
  statusCategory: "new", priority: "P2", assignee: "Unassigned",
  labels: [], components: [], sprint: null, inOpenSprint: true,
  updated: "2026-08-21T00:00:00.000Z", url: "https://fixture.invalid/browse/E2E-1",
  estimateSeconds: null, descriptionText: "The rocket panel shows stale numbers.",
};

/** A second task for the batch journey — same repo hint so inference checks it. */
export const FIXTURE_TASK_2 = {
  ...FIXTURE_TASK,
  key: "E2E-2", summary: "Refit the rocket landing gear",
  url: "https://fixture.invalid/browse/E2E-2",
  descriptionText: "Landing gear misses the pad.",
};

/** A child of E2E-1. Parented records are excluded from `list()`, so the pool
 *  stays at TWO cards and every existing journey's count assertion holds. */
export const FIXTURE_CHILD = {
  ...FIXTURE_TASK,
  key: "E2E-1-a", summary: "Repoint the telemetry feed",
  url: "https://fixture.invalid/browse/E2E-1-a",
  descriptionText: "The feed points at the retired endpoint.",
  parent: "E2E-1",
};

/** The Marketplace lists agents and commands out of `.claude/`. The real one is
 *  gitignored, so the sandbox writes its own — two files whose names the
 *  journey asserts on. `dir` is the directory `.claude/` is created under —
 *  pass `home` (see the call site in `makeSandbox`), not `repoPath`: no
 *  journey opens a workspace folder for this sandbox, so `scanClaudeAssets`
 *  never reads a repo-scoped `.claude/`, only `claudeConfigDir()`.
 *
 *  Also creates an EMPTY `.claude/plugins/` dir: `scanClaudeAssets` derives
 *  `notSetUp` from `isDir(${claudeDir}/plugins)` alone (claudeAssets.ts) and
 *  the webview's `.notSetUp` branch renders an empty-state message INSTEAD of
 *  `.results` — with no `plugins/` dir the seeded agent and command would be
 *  scanned and counted in the filter pills but never rendered as rows. */
export function seedClaudeAssets(dir: string): void {
  const agents = path.join(dir, ".claude", "agents");
  const commands = path.join(dir, ".claude", "commands");
  const plugins = path.join(dir, ".claude", "plugins");
  fs.mkdirSync(agents, { recursive: true });
  fs.mkdirSync(commands, { recursive: true });
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(
    path.join(agents, "telemetry-auditor.md"),
    "---\nname: telemetry-auditor\ndescription: Audits the rocket telemetry panel.\n---\n\nCheck the feed endpoint.\n",
  );
  fs.writeFileSync(
    path.join(commands, "refit.md"),
    "---\ndescription: Refit the landing gear.\n---\n\nRun the refit checklist.\n",
  );
}

export function makeSandbox(settingsOverride: Record<string, unknown> = {}): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "af-e2e-"));
  const home = path.join(root, "home");
  const userDataDir = path.join(root, "user-data");
  const extensionsDir = path.join(root, "extensions");
  const fixtureDir = path.join(root, "fixtures");
  const reposRoot = path.join(root, "repos");
  const repoPath = path.join(reposRoot, "rocket");
  for (const d of [home, userDataDir, extensionsDir, fixtureDir, repoPath]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // A real git repo — discoverRepos and the brief's git-exclude write need one.
  execFileSync("git", ["init", "-q"], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# rocket\n");
  execFileSync("git", ["add", "."], { cwd: repoPath });
  execFileSync(
    "git",
    ["-c", "user.email=e2e@fixture.invalid", "-c", "user.name=E2E", "commit", "-qm", "init"],
    { cwd: repoPath },
  );

  fs.writeFileSync(
    path.join(fixtureDir, "tasks.json"),
    JSON.stringify([FIXTURE_TASK, FIXTURE_TASK_2, FIXTURE_CHILD], null, 2),
  );

  // `home`, not `repoPath`: `launchHost` never passes a folder to open, so
  // `vscode.workspace.workspaceFolders` is empty for the whole session and
  // `scanClaudeAssets` (claudeAssets.ts) only ever reads `claudeConfigDir()` —
  // `$CLAUDE_CONFIG_DIR` or `~/.claude`, which resolves to `home` here since
  // `launchHost` points HOME at the sandbox. A repo-scoped `.claude/` would
  // never be scanned and the Marketplace journey would see an empty list.
  seedClaudeAssets(home);

  // Pre-answer every mid-take prompt except the repo-confirm QuickPick:
  //  - taskMode "implementation" is a built-in prompt-mode id → no mode pick
  //  - openIn "new-window" → no destination pick
  //  - worktree "never"    → no worktree pick (journey 4 will flip this)
  //  - remoteControl "off" → no Remote Control pick
  //  - childWorktrees false → no tree pick, even though the fixture now
  //    claims `children`; the child-tree journey flips this one to true
  //  - 1 repo → chooseWorkspaceMode returns "per-window" with no pick
  //  - defaultFilter "mine" → LOAD-BEARING now that the fixture connector's
  //    supportedFilters includes "mysprint": getConfig().defaultFilter
  //    defaults to "mysprint" (src/config.ts), and effectiveFilter used to
  //    fall back to "mine" only because "mysprint" was unsupported. Now that
  //    it's supported, every journey would otherwise open on the My-sprint
  //    lens — which filters to `inOpenSprint` tasks — pinning this keeps the
  //    11 pre-existing journeys' card counts byte-identical.
  const settings = {
    "agentFlow.taskSource": "fixture",
    "agentFlow.reposRoot": reposRoot,
    "agentFlow.workspaceDir": path.join(root, "workspaces"),
    "agentFlow.taskMode": "implementation",
    "agentFlow.openIn": "new-window",
    "agentFlow.worktree": "never",
    "agentFlow.remoteControl": "off",
    "agentFlow.childWorktrees": false,
    "agentFlow.seedAgent": true,
    "agentFlow.defaultFilter": "mine",
    "security.workspace.trust.enabled": false,
    "update.mode": "none",
    "extensions.autoUpdate": false,
    // Per-journey overrides last, so a journey can flip exactly one answer
    // (worktree mode) without restating the whole contract.
    ...settingsOverride,
  };
  fs.mkdirSync(path.join(userDataDir, "User"), { recursive: true });
  fs.writeFileSync(path.join(userDataDir, "User", "settings.json"), JSON.stringify(settings, null, 2));

  // Shadow /usr/bin/open with a failing shim. openInEditor (workspace.ts) shells
  // `open -a <appName>` first, which on a developer's Mac would launch the REAL
  // installed editor — outside this Electron app, invisible to Playwright, wrong
  // extensions. The shim makes exec fail, forcing the documented fallback:
  // vscode.openFolder{forceNewWindow} inside the SAME Electron app.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "open"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

  // Shadow `claude` too: terminal-surface seeding runs the provider CLI in a real
  // integrated terminal, and the developer's actual Claude Code CLI must never
  // start an agent session from a test. The shim prints a marker and then holds
  // stdin open (cat), so the seeded prompt lands in a "running" TUI the way the
  // real one would. The HOME override keeps the shell from reading the real rc
  // files, so no user PATH entry can outrank this shim.
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\necho CLAUDE-SHIM-READY\nexec cat\n", { mode: 0o755 });

  return {
    root, home, userDataDir, extensionsDir, fixtureDir, reposRoot, repoPath,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
