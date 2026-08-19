import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getConfig, type AgentProvider } from "./config";
import type { TaskConnector } from "./tasks/provider";
import { discoverRepos } from "./engine/repos";
import { probeGh } from "./engine/pr/provider";
import { resolveBin } from "./engine/pr/which";
import { defaultRunsDir, readRuns } from "./engine/runs";
import {
  runChecks,
  summarize,
  formatReport,
  type AuthProbe,
  type Check,
  type DoctorAction,
  type DoctorInputs,
  type ProjectProbe,
} from "./engine/doctor";

export const CLAUDE_CODE_ID = "anthropic.claude-code";

/** The settings Doctor reads. A narrow slice of the config — the source-facing
 *  fields come from `connector.info()`, the rest from `getConfig()` — so the
 *  probes can be driven from a literal in tests. */
export interface DoctorConfig {
  sourceLabel: string;
  scopeNoun: string;
  endpoint: string;
  scope: string;
  endpointSetting: string;
  scopeSetting: string;
  reposRoot: string;
  workspaceDir: string;
  repoBlocklist: string[];
  prFacts: boolean;
  agentProvider: AgentProvider;
}

/** Every outside-world touch Doctor makes, injected. `collectInputs` is then pure
 *  orchestration — which is what makes it testable without a Jira site, a
 *  filesystem or a `gh` binary. The source's own error classification now lives
 *  behind `probe()`, on the connector (Task 6) — this module no longer knows
 *  what a `JiraAuthError` or a 404 is. */
export interface DoctorDeps {
  config: () => DoctorConfig;
  hasCredentials: () => Promise<boolean>;
  probe: () => Promise<{ auth?: AuthProbe; scope?: ProjectProbe }>;
  which: (bin: string) => string | null;
  gh: () => Promise<{ kind: "missing" | "signed-out"; detail: string } | null>;
  statDir: (p: string) => { exists: boolean; writable: boolean };
  repos: () => { repos: number; gitRepos: number };
  claudeExtension: () => { installed: boolean; version: string | null };
  claudeProjectsReadable: () => boolean;
  chatCommand: () => Promise<{ available: boolean }>;
  runs: () => number;
  log: (message: string) => void;
}

/** Probe the world, hand the verdict to the pure module. The classification that
 *  used to live here — `instanceof JiraAuthError`, a 404 read as `not-found` —
 *  moved behind `d.probe()` on the connector (Task 6); this function is now pure
 *  forwarding plus the one gate below. */
export async function collectInputs(d: DoctorDeps): Promise<DoctorInputs> {
  const cfg = d.config();
  const hasCredentials = await d.hasCredentials();

  // No casts: TaskConnector.probe() returns AuthProbe/ProjectProbe directly, so
  // a connector that classifies a failure into the wrong shape is a compile
  // error here rather than a Doctor row that quietly reports the wrong thing.
  // Gating on `hasCredentials` here is redundant with `probe()`'s own gate on
  // `isAuthenticated()` — kept anyway so a never-signed-in user gets a `skip`
  // even from a connector that forgot its own gate.
  const { auth: authProbe, scope: projectProbe } = hasCredentials ? await d.probe() : {};

  const repos = d.repos();
  return {
    sourceLabel: cfg.sourceLabel,
    scopeNoun: cfg.scopeNoun,
    endpoint: cfg.endpoint,
    scope: cfg.scope,
    endpointSetting: cfg.endpointSetting,
    scopeSetting: cfg.scopeSetting,
    hasCredentials,
    authProbe,
    projectProbe,
    gitOnPath: !!d.which("git"),
    // Only existence matters for the repos root — nothing writes there.
    reposRoot: { path: cfg.reposRoot, exists: d.statDir(cfg.reposRoot).exists, ...repos },
    workspaceDir: { path: cfg.workspaceDir, ...d.statDir(cfg.workspaceDir) },
    prFacts: cfg.prFacts,
    gh: cfg.prFacts ? { gap: await d.gh(), foundAt: d.which("gh") } : undefined,
    claudeCode: d.claudeExtension(),
    claudeProjectsReadable: d.claudeProjectsReadable(),
    runs: d.runs(),
    agentProvider: cfg.agentProvider,
    // Only probed when it can matter — the Claude Code path must not pay for it.
    chatCommand: cfg.agentProvider !== "claude-code" ? await d.chatCommand() : { available: false },
  };
}

const ICON: Record<Check["status"], string> = {
  fail: "$(error)",
  warn: "$(warning)",
  skip: "$(circle-slash)",
  ok: "$(pass)",
};

interface DoctorItem extends vscode.QuickPickItem {
  check?: Check;
  copy?: boolean;
}

function buildItems(checks: Check[]): DoctorItem[] {
  const items: DoctorItem[] = checks.map((c) => ({
    label: `${ICON[c.status]} ${c.label}`,
    description: c.detail,
    // The action's own label is the hint: "Sign in", "Open setting", "Install gh".
    detail: c.action ? `$(arrow-small-right) ${c.action.label}` : undefined,
    check: c,
  }));
  items.push({
    label: "$(clippy) Copy diagnostic report",
    description: "plain text, for a ticket or a thread",
    copy: true,
  });
  return items;
}

async function applyAction(action: DoctorAction): Promise<void> {
  switch (action.kind) {
    case "command":
      await vscode.commands.executeCommand(action.command);
      return;
    case "setting":
      await vscode.commands.executeCommand("workbench.action.openSettings", action.setting);
      return;
    case "extension":
      await vscode.commands.executeCommand("workbench.extensions.search", action.id);
      return;
    case "external":
      await vscode.env.openExternal(vscode.Uri.parse(action.url));
      return;
  }
}

/** Probe everything, show the verdict, and run the fix the user clicks. Read-only
 *  apart from the clipboard: nothing here repairs anything on its own. */
export async function showDoctor(d: DoctorDeps): Promise<void> {
  const inputs = await collectInputs(d);
  const checks = runChecks(inputs);
  const summary = summarize(checks);
  d.log(`doctor: ${summary}`);

  const picked = await vscode.window.showQuickPick(buildItems(checks), {
    title: `Agent Flow Deck Doctor — ${summary}`,
    placeHolder: "Pick a problem to fix, or copy the report",
    ignoreFocusOut: true,
  });
  if (!picked) return;
  if (picked.copy) {
    await vscode.env.clipboard.writeText(formatReport(checks, inputs.sourceLabel));
    return;
  }
  if (picked.check?.action) await applyAction(picked.check.action);
}

/** Nothing in the extension checked this before: `workspace.ts` calls Claude Code's
 *  command and silently falls back when it's absent. */
export function probeClaudeExtension(): { installed: boolean; version: string | null } {
  const ext = vscode.extensions.getExtension(CLAUDE_CODE_ID);
  if (!ext) return { installed: false, version: null };
  return { installed: true, version: ext.packageJSON?.version ?? null };
}

/** Whether this window can open a chat panel at all. Command registration rather
 *  than an extension id: chat is built into VS Code, Copilot ships bundled in
 *  some builds, and Cursor registers the same command — so one probe serves
 *  both non-Claude providers. */
export async function probeChatCommand(): Promise<{ available: boolean }> {
  try {
    return { available: (await vscode.commands.getCommands(true)).includes("workbench.action.chat.open") };
  } catch {
    return { available: false };
  }
}

function statDir(p: string): { exists: boolean; writable: boolean } {
  try {
    if (!fs.statSync(p).isDirectory()) return { exists: false, writable: false };
  } catch {
    return { exists: false, writable: false };
  }
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return { exists: true, writable: true };
  } catch {
    return { exists: true, writable: false };
  }
}

/** The real wiring. Kept separate from `showDoctor` so the command is one line and
 *  the tests never touch the network or the filesystem. */
export function defaultDeps(connector: TaskConnector, log: (message: string) => void): DoctorDeps {
  const cfg = (): DoctorConfig => {
    const c = getConfig();
    const info = connector.info();
    return {
      sourceLabel: info.label,
      scopeNoun: info.scopeNoun,
      endpoint: info.endpoint,
      scope: info.scopeValue,
      endpointSetting: info.endpointSetting,
      scopeSetting: info.scopeSetting,
      reposRoot: c.reposRoot,
      workspaceDir: c.workspaceDir,
      repoBlocklist: c.repoBlocklist,
      prFacts: c.prFacts,
      agentProvider: c.agentProvider,
    };
  };
  return {
    config: cfg,
    hasCredentials: () => connector.isAuthenticated(),
    probe: () => connector.probe(),
    which: (bin) => resolveBin(bin),
    gh: () => probeGh(),
    statDir,
    repos: () => {
      const c = cfg();
      const found = discoverRepos(c.reposRoot, c.repoBlocklist);
      return { repos: found.length, gitRepos: found.filter((r) => r.isGit).length };
    },
    claudeExtension: probeClaudeExtension,
    chatCommand: probeChatCommand,
    claudeProjectsReadable: () => {
      try {
        fs.accessSync(path.join(os.homedir(), ".claude", "projects"), fs.constants.R_OK);
        return true;
      } catch {
        return false;
      }
    },
    runs: () => readRuns(defaultRunsDir()).length,
    log,
  };
}
