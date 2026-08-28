import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getConfig, hostProviders, type AgentProviderSetting } from "./config";
import type { TaskConnector } from "./tasks/provider";
import { discoverRepos } from "./engine/repos";
import { resolveForge } from "./engine/forge/registry";
import type { Forge } from "./engine/forge/types";
import { resolveBin } from "./engine/pr/which";
import { defaultRunsDir, readRuns } from "./engine/runs";
import { defaultPrFactsDir, summarisePrReads } from "./engine/pr/store";
import {
  runChecks,
  summarize,
  formatReport,
  FORGE_MODE_PASSTHROUGH,
  FORGE_MODE_PROJECTED,
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
  agentProvider: AgentProviderSetting;
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
  /** Describing the forge is cheap — a config read plus a registry lookup — so it
   *  is always resolved. Probing it is not, so `forgeProbe` is its own member and
   *  `collectInputs` gates the call on `prFacts`. */
  forge: () => { label: string; cli: string; installUrl: string };
  forgeProbe: () => Promise<{ kind: "missing" | "signed-out"; detail: string } | null>;
  /** Which mode the forge's CLI is in, for a forge whose capability depends on
   *  which build is installed (Bitbucket's `atlassian-cli`). This is its own
   *  member rather than a field `forge()` fills in, for the same reason
   *  `forgeProbe` is separate from `forge()` above: describing the forge is
   *  cheap, a config read plus a registry lookup, so `forge()` stays
   *  synchronous and is always called. Resolving the mode means awaiting
   *  `resolveCaps()`, which for Bitbucket spawns `bb api --help` — a probe, not
   *  a description — so it gets the same treatment as `forgeProbe`: its own
   *  async member, gated on `prFacts` by `collectInputs` rather than run on
   *  every cheap describe. Optional so a `DoctorDeps` built without it (every
   *  test double predating this member) still type-checks, and `collectInputs`
   *  reads the absence as "no mode to report" — the same answer a forge with
   *  exactly one mode gives. */
  forgeMode?: () => Promise<string | null>;
  /** How the last round of PR reads went, read off the Deck's fact cache.
   *  Optional so a caller that predates the row — every existing test among them
   *  — keeps working and simply reports nothing, which is the honest answer when
   *  nobody is looking at the cache. Gated on `prFacts` at the call site: with
   *  the feature off there are no reads to have failed. */
  prReads?: () => { runs: number; repos: string[] };
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
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  // A probe that dies must become a row in the report, never a dead Doctor:
  // this command exists for exactly the machines where probes fail, and an
  // uncaught rejection here used to abort the whole command with a generic host
  // error — no report, on the machine that needed one most. Each fallible input
  // is guarded individually so one broken seam cannot hide the others' verdicts.
  const guard = <T>(label: string, fallback: T, run: () => T): T => {
    try {
      return run();
    } catch (e) {
      d.log(`doctor: ${label} failed: ${message(e)}`);
      return fallback;
    }
  };
  const guardAsync = async <T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      d.log(`doctor: ${label} failed: ${message(e)}`);
      return fallback;
    }
  };

  const cfg = d.config();
  const hasCredentials = await guardAsync("credentials check", false, () => d.hasCredentials());

  // No casts: TaskConnector.probe() returns AuthProbe/ProjectProbe directly, so
  // a connector that classifies a failure into the wrong shape is a compile
  // error here rather than a Doctor row that quietly reports the wrong thing.
  // Gating on `hasCredentials` here is redundant with `probe()`'s own gate on
  // `isAuthenticated()` — kept anyway so a never-signed-in user gets a `skip`
  // even from a connector that forgot its own gate.
  let authProbe: AuthProbe | undefined;
  let projectProbe: ProjectProbe | undefined;
  if (hasCredentials) {
    try {
      ({ auth: authProbe, scope: projectProbe } = await d.probe());
    } catch (e) {
      // The probe dying IS the diagnosis: a connector that classifies its own
      // failures never rejects, so whatever escaped is a transport-level break —
      // surface it as the failing reachability row rather than aborting.
      d.log(`doctor: source probe failed: ${message(e)}`);
      authProbe = { ok: false, reason: "network", message: message(e) };
    }
  }

  const repos = guard("repo scan", { repos: 0, gitRepos: 0 }, () => d.repos());
  // Resolved unconditionally — describing the forge is cheap — while the probe
  // itself stays gated on `prFacts` so a Deck with PR facts off does not pay for
  // an `auth status` call.
  const f = d.forge();
  // Gated on `prFacts` exactly like `gap` below — and, separately, left
  // `undefined` rather than forced to `null` when `forgeMode` isn't supplied at
  // all (every `DoctorDeps` test double predating this member), so a forge with
  // no mode to report and a forge nobody asked about read identically to
  // `DoctorInputs.forge`'s optional `mode` field and to `toEqual` callers that
  // built their expectation before this member existed.
  const mode = cfg.prFacts && d.forgeMode ? await guardAsync("forge mode probe", null, () => d.forgeMode!()) : undefined;
  // A rejecting forge probe maps to a `missing` gap — the fail row — because the
  // usual escape here is the spawn itself failing (ENOENT, PATH), which is what
  // that row's wording already describes. Healthy is `null`; a rejection must
  // never read as healthy.
  let gap: { kind: "missing" | "signed-out"; detail: string } | null = null;
  if (cfg.prFacts) {
    try {
      gap = await d.forgeProbe();
    } catch (e) {
      d.log(`doctor: forge probe failed: ${message(e)}`);
      gap = { kind: "missing", detail: message(e) };
    }
  }
  const forge = { ...f, gap, foundAt: guard(`${f.cli} lookup`, null, () => d.which(f.cli)), mode };
  // Same gate as the probe above, for the same reason: PR facts off means nothing
  // was ever read, so there is no failure to report and no cache worth walking.
  const prReads = guard("PR reads summary", undefined, () => (cfg.prFacts ? d.prReads?.() : undefined));
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
    gitOnPath: !!guard("git lookup", null, () => d.which("git")),
    // Only existence matters for the repos root — nothing writes there.
    reposRoot: {
      path: cfg.reposRoot,
      exists: guard("repos root stat", { exists: false, writable: false }, () => d.statDir(cfg.reposRoot)).exists,
      ...repos,
    },
    workspaceDir: {
      path: cfg.workspaceDir,
      ...guard("workspace dir stat", { exists: false, writable: false }, () => d.statDir(cfg.workspaceDir)),
    },
    prFacts: cfg.prFacts,
    forge,
    prReads,
    claudeCode: guard("Claude Code extension probe", { installed: false, version: null }, () => d.claudeExtension()),
    claudeProjectsReadable: guard("session files probe", false, () => d.claudeProjectsReadable()),
    runs: guard("runs scan", 0, () => d.runs()),
    agentProvider: cfg.agentProvider,
    hostProviders: hostProviders(),
    // Probed whenever a chat-panel agent could be the one that runs — which under
    // `ask` is any host that offers one.
    chatCommand:
      cfg.agentProvider !== "claude-code"
        ? await guardAsync("chat command probe", { available: false }, () => d.chatCommand())
        : { available: false },
    // Probed whenever Codex could be the agent that runs — a fixed `codex`
    // setting, or `ask`, where Codex is on every host's picker.
    ...(cfg.agentProvider === "codex" || cfg.agentProvider === "ask"
      ? { codexCli: guard("codex lookup", { foundAt: null }, () => ({ foundAt: d.which("codex") })) }
      : {}),
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
  // Belt to `collectInputs`' braces: every probe in there is guarded
  // individually, but Doctor must never die with a generic host error on
  // exactly the machines it exists to diagnose — so anything that still
  // escapes (a throwing config read, a QuickPick failure) is caught, logged,
  // and reported rather than rethrown into the command frame.
  try {
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
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    d.log(`doctor: failed: ${detail}`);
    vscode.window.showErrorMessage(`Agent Flow Deck Doctor could not finish: ${detail}`);
  }
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
  /** The configured forge, resolved once per call for whichever member asked.
   *  Both `forge` and `forgeProbe` go through this, so one config read and one
   *  `Forge` construction serve each — and, more importantly, both report an
   *  unknown `agentFlow.forge` through the same logger. */
  const resolved = (): Forge => resolveForge(getConfig().forge, log);
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
      // Passed through unresolved: under `ask` the answer isn't known until launch,
      // so `collectInputs` hands `runChecks` every host agent's rows rather than
      // guessing at one. `resolvedProvider` is not used here — that helper is for
      // copy that must name one concrete agent before a launch has picked.
      agentProvider: c.agentProvider,
    };
  };
  return {
    config: cfg,
    hasCredentials: () => connector.isAuthenticated(),
    probe: () => connector.probe(),
    which: (bin) => resolveBin(bin),
    // `log`, not a swallowing `() => {}`: Doctor is THE surface built to report
    // this class of misconfiguration, and `agentFlow.forge: "gitla"` otherwise
    // yields a report reading "GitHub / gh: signed in" with nothing anywhere
    // telling the user their setting was ignored. The Deck panel logs its own
    // fallback, but Doctor runs independently of it, so a user who never opened
    // the Deck would never see that line.
    forge: () => {
      const { label, cli } = resolved();
      return { label, cli: cli.name, installUrl: cli.installUrl };
    },
    forgeProbe: () => resolved().probe(),
    // `resolved()` again, matching `forgeProbe` above: a fresh `Forge` per call
    // rather than a shared one, so this doesn't need to coordinate with either.
    // A forge with no `resolveCaps` (GitHub, GitLab) has exactly one mode, and
    // `null` is that "nothing to report" answer — not a failure.
    forgeMode: async () => {
      const caps = await resolved().resolveCaps?.();
      return caps ? (caps.changesRequested ? FORGE_MODE_PASSTHROUGH : FORGE_MODE_PROJECTED) : null;
    },
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
    prReads: () => summarisePrReads(defaultPrFactsDir()),
    log,
  };
}
