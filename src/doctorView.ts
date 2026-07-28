import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getConfig } from "./config";
import { JiraAuth } from "./jira/auth";
import { JiraClient, JiraAuthError, JiraApiError } from "./jira/client";
import { describeJiraError } from "./jira/errors";
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

/** The settings Doctor reads. A narrow slice of the config so the probes can be
 *  driven from a literal in tests. */
export interface DoctorConfig {
  baseUrl: string;
  project: string;
  reposRoot: string;
  workspaceDir: string;
  repoBlocklist: string[];
  prFacts: boolean;
}

/** Every outside-world touch Doctor makes, injected. `collectInputs` is then pure
 *  orchestration — which is what makes the classification testable without a Jira
 *  site, a filesystem or a `gh` binary. */
export interface DoctorDeps {
  config: () => DoctorConfig;
  hasCredentials: () => Promise<boolean>;
  probeMyself: () => Promise<{ accountId: string; displayName: string }>;
  getProject: (key: string) => Promise<{ id: string; key: string; name: string }>;
  which: (bin: string) => string | null;
  gh: () => Promise<{ kind: "missing" | "signed-out"; detail: string } | null>;
  statDir: (p: string) => { exists: boolean; writable: boolean };
  repos: () => { repos: number; gitRepos: number };
  claudeExtension: () => { installed: boolean; version: string | null };
  claudeProjectsReadable: () => boolean;
  runs: () => number;
  log: (message: string) => void;
}

/** Probe the world, classify the failures, hand the verdict to the pure module.
 *
 *  The ordering matters: each Jira probe is skipped when the one before it failed,
 *  because the answer would be meaningless and the call cannot succeed. A signed-out
 *  user should see one problem, not a cascade of three. */
export async function collectInputs(d: DoctorDeps): Promise<DoctorInputs> {
  const cfg = d.config();
  const hasCredentials = await d.hasCredentials();

  let authProbe: AuthProbe | undefined;
  if (hasCredentials) {
    try {
      const me = await d.probeMyself();
      authProbe = { ok: true, displayName: me.displayName || me.accountId };
    } catch (e) {
      // JiraAuthError is the credentials; anything else is reaching Jira at all.
      // request() already phrases both well, so Doctor invents no wording.
      authProbe = e instanceof JiraAuthError
        ? { ok: false, reason: "auth", message: e.message }
        : { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) };
    }
  }

  let projectProbe: ProjectProbe | undefined;
  if (cfg.project && authProbe?.ok) {
    try {
      const p = await d.getProject(cfg.project);
      projectProbe = { ok: true, name: p.name || p.key };
    } catch (e) {
      const message = e instanceof JiraApiError ? describeJiraError(e) : e instanceof Error ? e.message : String(e);
      projectProbe = e instanceof JiraApiError && e.status === 404
        ? { ok: false, reason: "not-found", message }
        : { ok: false, reason: "error", message };
    }
  }

  const repos = d.repos();
  return {
    baseUrl: cfg.baseUrl,
    project: cfg.project,
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
    title: `Agent Flow Doctor — ${summary}`,
    placeHolder: "Pick a problem to fix, or copy the report",
    ignoreFocusOut: true,
  });
  if (!picked) return;
  if (picked.copy) {
    await vscode.env.clipboard.writeText(formatReport(checks));
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
export function defaultDeps(auth: JiraAuth, log: (message: string) => void): DoctorDeps {
  const cfg = (): DoctorConfig => {
    const c = getConfig();
    return {
      baseUrl: c.baseUrl,
      project: c.project,
      reposRoot: c.reposRoot,
      workspaceDir: c.workspaceDir,
      repoBlocklist: c.repoBlocklist,
      prFacts: c.prFacts,
    };
  };
  const client = () => {
    const c = cfg();
    return new JiraClient(c.baseUrl, c.project, auth);
  };
  return {
    config: cfg,
    hasCredentials: () => auth.isAuthenticated(),
    probeMyself: () => client().probeMyself(),
    getProject: (key) => client().getProject(key),
    which: (bin) => resolveBin(bin),
    gh: () => probeGh(),
    statDir,
    repos: () => {
      const c = cfg();
      const found = discoverRepos(c.reposRoot, c.repoBlocklist);
      return { repos: found.length, gitRepos: found.filter((r) => r.isGit).length };
    },
    claudeExtension: probeClaudeExtension,
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
