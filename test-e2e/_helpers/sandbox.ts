import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { FixtureConfig } from "../../src/tasks/fixture/connector";

export type { FixtureConfig };

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

/** Options for `seedClaudeAssets`. */
export interface SeedAssetsOptions {
  /** Also write a marketplace catalog under `.claude/plugins/` — see
   *  `seedRichPlugins`. Opt-in: the four pre-existing `marketplace.e2e.ts`
   *  tests assert exact row sets and counts against the two-asset base seed,
   *  and must keep passing unmodified. */
  rich?: boolean;
}

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
export function seedClaudeAssets(dir: string, opts: SeedAssetsOptions = {}): void {
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
  if (opts.rich) seedRichPlugins(dir);
}

/** A marketplace catalog rich enough to drive the Marketplace's filters, read
 *  off `scanClaudeAssets` (src/engine/claudeAssets.ts:345-420 on 2026-09-04),
 *  which reads, in order:
 *
 *   - `<claudeDir>/plugins` — its mere existence is `notSetUp === false` (:362)
 *   - `plugins/known_marketplaces.json` (:363) — `{ <key>: { source, installLocation } }`
 *   - `plugins/installed_plugins.json` (:364) — `{ plugins: { "<plugin>@<mkt>": [{scope,version,installPath}] } }`
 *   - `<installLocation>/.claude-plugin/marketplace.json` (:373) — the catalog,
 *     whose `name` (not the known_marketplaces key) is the marketplace's
 *     displayed name and the `@<mkt>` half of every ref (:374, :381)
 *   - each catalog entry's `category` (:387, `categoryOf` :329) — LOWER-CASED,
 *     and absent becomes the explicit `uncategorized` bucket. NOTE: the plan
 *     said `plugin.json`; the code reads the category off the catalog entry in
 *     marketplace.json, and there is no per-plugin plugin.json read at all.
 *   - `<claudeDir>/settings.json`'s `enabledPlugins["<plugin>@<mkt>"]` (:235) —
 *     `false` is "disabled", and an ABSENT ref stays `null` (unknown), which is
 *     deliberately not the same thing (no badge either way but the "Enabled
 *     only" scope drops only an explicit `false`).
 *
 *  Content state per plugin comes from `resolveContentDir` (:300): an install
 *  entry whose `installPath` is a real directory ⇒ `installed`; else the
 *  catalog `source` path under `installLocation` if that exists ⇒ `clone`; else
 *  `manifest` — the "not downloaded" row, whose `installCommand` is
 *  `/plugin install <plugin>@<mkt>` (:409).
 *
 *  The shape below is chosen so every filter dimension has a positive AND a
 *  negative case, and so no two dimensions are carried by the same row:
 *
 *  | plugin          | category      | enabled | state         | assets                  |
 *  |-----------------|---------------|---------|---------------|-------------------------|
 *  | flight-recorder | monitoring    | true    | installed     | skill flight-log, hook  |
 *  | hangar-checks   | monitoring    | null    | installed     | command preflight       |
 *  | cargo-scales    | uncategorized | null    | installed     | skill mass-budget       |
 *  | gantry-lights   | deployment    | FALSE   | installed     | skill gantry-check      |
 *  | launch-pad      | monitoring    | null    | not downloaded | —                      |
 *
 *  Plus the base seed's own two assets under `yours` (`(user)` / `~/.claude`),
 *  which makes the pills read Skills 3 · Commands 2 · Agents 1 · Hooks 1. */
function seedRichPlugins(dir: string): void {
  const claude = path.join(dir, ".claude");
  const install = path.join(claude, "plugins", "marketplaces", "rocket-tools");
  const write = (rel: string, body: string): void => {
    const abs = path.join(install, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };
  const md = (name: string, description: string, body: string): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

  write(
    ".claude-plugin/marketplace.json",
    JSON.stringify(
      {
        name: "rocket-tools",
        plugins: [
          { name: "flight-recorder", description: "Records the flight telemetry stream.", category: "Monitoring", source: "./flight-recorder" },
          { name: "hangar-checks", description: "Pre-launch checks for the hangar.", category: "Monitoring", source: "./hangar-checks" },
          { name: "cargo-scales", description: "Weighs the cargo bay.", source: "./cargo-scales" },
          { name: "gantry-lights", description: "Drives the gantry light rig.", category: "Deployment", source: "./gantry-lights" },
          { name: "launch-pad", description: "Pad scheduling and holds.", category: "Monitoring", source: "./launch-pad" },
        ],
      },
      null,
      2,
    ),
  );

  write("flight-recorder/skills/flight-log/SKILL.md", md("flight-log", "Reads one flight's log.", "Open the log and summarise the burn."));
  write(
    "flight-recorder/hooks/hooks.json",
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo flight-recorder" }] }] } }, null, 2),
  );
  write("flight-recorder/README.md", "# flight-recorder\n\nRecords the flight telemetry stream.\n");
  write("hangar-checks/commands/preflight.md", "---\ndescription: Walk the pre-flight list.\n---\n\nCheck the hangar doors.\n");
  write("cargo-scales/skills/mass-budget/SKILL.md", md("mass-budget", "Balances the mass budget.", "Sum the manifest and compare."));
  write("gantry-lights/skills/gantry-check/SKILL.md", md("gantry-check", "Checks the gantry lights.", "Sweep every lamp."));
  // launch-pad: deliberately NO directory, so resolveContentDir lands on
  // `manifest` and the row renders as "not downloaded" with its install command.

  const plugins = path.join(claude, "plugins");
  fs.writeFileSync(
    path.join(plugins, "known_marketplaces.json"),
    JSON.stringify(
      { "rocket-tools": { source: { source: "github", repo: "fixture/rocket-tools" }, installLocation: install } },
      null,
      2,
    ),
  );
  const entry = (name: string, version: string) => [
    { scope: "user", version, installPath: path.join(install, name) },
  ];
  fs.writeFileSync(
    path.join(plugins, "installed_plugins.json"),
    JSON.stringify(
      {
        plugins: {
          "flight-recorder@rocket-tools": entry("flight-recorder", "1.2.0"),
          "hangar-checks@rocket-tools": entry("hangar-checks", "2.0.0"),
          "cargo-scales@rocket-tools": entry("cargo-scales", "0.4.1"),
          "gantry-lights@rocket-tools": entry("gantry-lights", "0.9.0"),
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(claude, "settings.json"),
    JSON.stringify(
      {
        enabledPlugins: {
          "flight-recorder@rocket-tools": true,
          // The one explicit `false` in the tree — the "disabled" badge and the
          // row the "Enabled only" scope drops.
          "gantry-lights@rocket-tools": false,
        },
      },
      null,
      2,
    ),
  );
}

/** Configure the fixture connector's capabilities and failures by writing
 *  `<fixtureDir>/config.json`. Call before `launchHost` for knobs the webview
 *  reads once at init (caps, supportedFilters, sizes); knobs the connector reads
 *  per call (statusTargets, reject, failDetail, me) may be flipped mid-test.
 *  Absent file = the shipped connector, so no existing journey needs this. */
export function writeFixtureConfig(sb: Sandbox, cfg: FixtureConfig): void {
  fs.writeFileSync(path.join(sb.fixtureDir, "config.json"), JSON.stringify(cfg, null, 2));
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

  // And `codex`, for the same reason: it is the one non-Claude provider whose real
  // path this lane can exercise (no host gate), and a developer's actual Codex CLI
  // must never start a session from a test.
  fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\necho CODEX-SHIM-READY\nexec cat\n", { mode: 0o755 });

  // And `cursor-agent`, for the patched cursor host (see cursorHostExecutable in
  // host.ts) — the same never-run-the-real-CLI contract as the other two.
  fs.writeFileSync(path.join(bin, "cursor-agent"), "#!/bin/sh\necho CURSOR-AGENT-SHIM-READY\nexec cat\n", { mode: 0o755 });

  return {
    root, home, userDataDir, extensionsDir, fixtureDir, reposRoot, repoPath,
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
