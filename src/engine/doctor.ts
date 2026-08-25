// Agent Flow Deck depends on five things outside itself — a reachable Jira site, valid
// credentials, the configured forge's CLI installed *and* signed in, a reposRoot
// that holds checkouts, and the Claude Code extension. Today each one fails at the
// moment of use, narrowly, and three of them fail silently. This module decides
// what is broken; it does no probing of its own so it stays free of `vscode` and
// testable as a plain table.

/** The Claude Code build that introduced `claude-vscode.editor.open`, which the
 *  shared-window batch launch needs. Below this, that one feature degrades. */
export const CLAUDE_CODE_FLOOR = "2.1.220";

/** Most decisive first. `skip` outranks `ok` because "not applicable" is a fact the
 *  reader may want to question, whereas a pass needs no attention at all. */
export type CheckStatus = "fail" | "warn" | "skip" | "ok";

/** `"source"` is a placeholder a connector's own label stands in for at render
 *  time (see `formatReport`'s `sourceLabel` parameter and `doctorView.ts`'s use
 *  of `DoctorInputs.sourceLabel`) — so a Jira user still reads "Jira" while this
 *  module, and the literal union below, stay free of any one source's name.
 *  The forge group is different: it is not a placeholder swapped in later but
 *  the forge's own label written straight into the check (`"GitHub"`, `"GitLab"`,
 *  or whatever a future forge names itself) — see `forgeChecks`. `(string & {})`
 *  keeps the named literals as hover suggestions while still accepting that
 *  value. The others are fixed: every source and every forge share them. */
export type DoctorGroup = "source" | "Local" | "Claude Code" | "Copilot" | "Cursor" | "State" | (string & {});

/** What fixes a failing check. Resolved by the view — this module names the intent
 *  and never touches `vscode`. */
export type DoctorAction =
  | { kind: "command"; command: string; label: string }
  | { kind: "setting"; setting: string; label: string }
  | { kind: "extension"; id: string; label: string }
  | { kind: "external"; url: string; label: string };

export interface Check {
  group: DoctorGroup;
  label: string;
  status: CheckStatus;
  detail: string;
  action?: DoctorAction;
}

/** Inlined rather than importing `AgentProvider` from src/config.ts — this module
 *  has zero imports by design, staying free of `vscode` and testable as a plain
 *  table. */
type Provider = "claude-code" | "copilot" | "cursor";

/** A live `GET /myself`. Distinguishing these three is the whole reason Doctor
 *  cannot reuse `getMyself()`, which collapses every failure to `null`. */
export type AuthProbe =
  | { ok: true; displayName: string }
  | { ok: false; reason: "auth" | "network"; message: string };

/** A live project lookup. `not-found` is the user's mistake; `error` is the
 *  network's, and blaming the project key for it would send them to the wrong fix. */
export type ProjectProbe =
  | { ok: true; name: string }
  | { ok: false; reason: "not-found" | "error"; message: string };

/** Everything the caller probed. `undefined` on an optional member means the probe
 *  was deliberately not run, which becomes a `skip` rather than a silent pass. */
export interface DoctorInputs {
  /** The connector's `info().label`, e.g. "Jira" — stands in for the `"source"`
   *  group placeholder wherever it is rendered as text. */
  sourceLabel: string;
  /** The connector's own name for its scope, e.g. "project" — capitalized to
   *  build the "X configured"/"X resolves" row labels below. */
  scopeNoun: string;
  endpoint: string;
  scope: string;
  /** Setting ids to name in a row's detail when `endpoint`/`scope` is empty. */
  endpointSetting: string;
  scopeSetting: string;
  hasCredentials: boolean;
  authProbe?: AuthProbe;
  projectProbe?: ProjectProbe;
  gitOnPath: boolean;
  reposRoot: { path: string; exists: boolean; repos: number; gitRepos: number };
  workspaceDir: { path: string; exists: boolean; writable: boolean };
  prFacts: boolean;
  /** The configured forge, and whether its CLI is usable. `gap` is null both when
   *  the CLI is healthy and when `prFacts` is off (nothing was probed) — `prFacts`
   *  is what distinguishes those, and it is read separately.
   *  Structural rather than importing `ForgeGap`, which lives in forge/types.ts
   *  alongside the other forge-only types this module has no other reason to know. */
  forge: {
    label: string;
    cli: string;
    installUrl: string;
    gap: { kind: "missing" | "signed-out"; detail: string } | null;
    foundAt: string | null;
    /** A human-readable mode, for a forge whose capability depends on which
     *  build of its CLI is installed — `"passthrough (full)"` or
     *  `"projected (limited — upgrade atlassian-cli for full support)"`. Null
     *  (or omitted) for the forges that have exactly one mode, where a mode row
     *  would be noise.
     *
     *  Structural rather than importing anything from `forge/`, matching how
     *  `gap` is already declared here. Optional so the existing constructions
     *  of this object elsewhere keep compiling untouched. */
    mode?: string | null;
  };
  claudeCode: { installed: boolean; version: string | null };
  claudeProjectsReadable: boolean;
  runs: number;
  /** Which agent seeds sessions — decides whether the Claude Code rows or a
   *  chat-agent row (Copilot or Cursor) appear. Already host-guarded by
   *  readAgentProviderSetting, so `"copilot"`/`"cursor"` are never present
   *  outside their host. `"ask"` means the choice isn't made until launch, so
   *  every agent this host can run gets its rows — see `hostProviders` below.
   *  Inlined rather than imported from src/config.ts's `AgentProviderSetting` —
   *  this module has zero imports by design, staying free of `vscode` and
   *  testable as a plain table. */
  agentProvider: Provider | "ask";
  /** The agents this host can actually start, in picker order — src/config.ts's
   *  `hostProviders()`, supplied by the caller since this module cannot call it
   *  itself. Only consulted when `agentProvider` is `"ask"`. */
  hostProviders: Provider[];
  /** Probed by command registration, not extension id: chat is built into VS Code
   *  and Copilot ships bundled in some builds, so an id check would false-negative.
   *  Cursor registers the same command, which is why one field and one probe serve
   *  both non-Claude providers. Renamed from `copilotChat` now that it does. */
  chatCommand: { available: boolean };
}

const SIGN_IN: DoctorAction = { kind: "command", command: "agentFlow.signIn", label: "Sign in" };
const SETUP: DoctorAction = { kind: "command", command: "agentFlow.setup", label: "Run Setup" };

const RANK: Record<CheckStatus, number> = { fail: 0, warn: 1, skip: 2, ok: 3 };

/** Every check, most decisive first, so the QuickPick opens on the thing to fix. */
export function runChecks(i: DoctorInputs): Check[] {
  const checks: Check[] = [...sourceChecks(i), ...localChecks(i), ...forgeChecks(i), ...agentChecks(i), ...stateChecks(i)];
  // A stable sort keeps the authored group order inside one status, so the report
  // reads top-to-bottom the way the check set is documented.
  return checks
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => RANK[a.c.status] - RANK[b.c.status] || a.idx - b.idx)
    .map(({ c }) => c);
}

/** Capitalizes a connector's own noun for its scope ("project" → "Project") to
 *  build a row label without hardcoding any one source's vocabulary. */
const Noun = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);

function sourceChecks(i: DoctorInputs): Check[] {
  const out: Check[] = [];
  const scopeLabel = Noun(i.scopeNoun);

  // "Site configured" stays as-is: every source has an endpoint, whatever its
  // scope is called.
  const siteOk = /^https:\/\/.+/.test(i.endpoint);
  out.push({
    group: "source",
    label: "Site configured",
    status: siteOk ? "ok" : "fail",
    detail: i.endpoint
      ? siteOk
        ? i.endpoint
        : `${i.endpoint} — needs to be an https URL`
      : `${i.endpointSetting} is empty`,
    ...(siteOk ? {} : { action: SETUP }),
  });

  out.push({
    group: "source",
    label: `${scopeLabel} configured`,
    status: i.scope ? "ok" : "fail",
    detail: i.scope || `${i.scopeSetting} is empty`,
    ...(i.scope ? {} : { action: SETUP }),
  });

  out.push({
    group: "source",
    label: "Credentials stored",
    status: i.hasCredentials ? "ok" : "fail",
    detail: i.hasCredentials ? "email and API token in SecretStorage" : "no email or API token stored",
    ...(i.hasCredentials ? {} : { action: SIGN_IN }),
  });

  // The check that earns Doctor its network call: a revoked token reads as
  // signed-in to `isAuthenticated()`, which only looks for stored strings.
  out.push(
    !i.authProbe
      ? {
          group: "source",
          label: "Credentials valid",
          status: "skip",
          detail: "not probed — no credentials to probe with",
        }
      : i.authProbe.ok
        ? { group: "source", label: "Credentials valid", status: "ok", detail: `signed in as ${i.authProbe.displayName}` }
        : i.authProbe.reason === "auth"
          ? { group: "source", label: "Credentials valid", status: "fail", detail: i.authProbe.message, action: SIGN_IN }
          : { group: "source", label: "Credentials valid", status: "warn", detail: i.authProbe.message },
  );

  out.push(
    !i.projectProbe
      ? {
          group: "source",
          label: `${scopeLabel} resolves`,
          status: "skip",
          detail: "not probed — credentials are missing or rejected",
        }
      : i.projectProbe.ok
        ? { group: "source", label: `${scopeLabel} resolves`, status: "ok", detail: i.projectProbe.name }
        : i.projectProbe.reason === "not-found"
          ? {
              group: "source",
              label: `${scopeLabel} resolves`,
              status: "fail",
              detail: `${i.scope} not found, or not visible to you`,
              action: SETUP,
            }
          : { group: "source", label: `${scopeLabel} resolves`, status: "warn", detail: i.projectProbe.message },
  );

  return out;
}

function localChecks(i: DoctorInputs): Check[] {
  const out: Check[] = [];

  out.push({
    group: "Local",
    label: "git on PATH",
    status: i.gitOnPath ? "ok" : "fail",
    detail: i.gitOnPath ? "found" : "not found — worktrees and diffs need it",
  });

  // A missing root is never legitimate; an empty one is normal on a fresh machine,
  // so it must not shout the same way.
  const r = i.reposRoot;
  out.push({
    group: "Local",
    label: "Repos root",
    status: !r.exists ? "fail" : r.repos === 0 ? "warn" : "ok",
    detail: !r.exists
      ? `${r.path} does not exist`
      : r.repos === 0
        ? `no repos under ${r.path}`
        : `${r.repos} repos, ${r.gitRepos} git — ${r.path}`,
    ...(r.exists && r.repos > 0 ? {} : { action: { kind: "setting", setting: "agentFlow.reposRoot", label: "Open setting" } }),
  });

  const w = i.workspaceDir;
  const workspaceOk = w.exists && w.writable;
  out.push({
    group: "Local",
    label: "Workspace dir",
    status: workspaceOk ? "ok" : "fail",
    detail: workspaceOk ? w.path : !w.exists ? `${w.path} does not exist` : `${w.path} is not writable`,
    ...(workspaceOk ? {} : { action: { kind: "setting", setting: "agentFlow.workspaceDir", label: "Open setting" } }),
  });

  return out;
}

function forgeChecks(i: DoctorInputs): Check[] {
  const f = i.forge;
  // The skip row still carries the forge's own group and label: a row that named
  // no forge would read as a row about nothing, and the group set is what tells a
  // GitLab user their Deck is pointed where they think it is.
  if (!i.prFacts) {
    return [{ group: f.label, label: f.cli, status: "skip", detail: "agentFlow.prFacts is off" }];
  }
  // Naming where the CLI was found is the most valuable line in the report: a
  // Homebrew binary invisible to the extension host's bare launchd PATH reads, to
  // a signed-in user, as the Deck simply being broken.
  const where = f.foundAt ?? f.cli;
  if (!f.gap) {
    // Only a forge whose capability depends on the installed CLI build has a
    // mode worth naming — GitHub and GitLab have exactly one, so `f.mode` is
    // null there and this stays silent, matching the passing test's own row.
    const mode = f.mode ? ` — ${f.mode}` : "";
    return [{ group: f.label, label: f.cli, status: "ok", detail: `signed in — ${where}${mode}` }];
  }
  return [
    {
      group: f.label,
      label: f.cli,
      status: "fail",
      detail:
        f.gap.kind === "missing"
          ? "not installed, or not on a PATH the extension host can see"
          : `signed out — ${where}`,
      action: { kind: "external", url: f.installUrl, label: `Install ${f.cli}` },
    },
  ];
}

/** Picks the Claude Code rows, or a chat-agent row plus the Claude session-files
 *  row, by which agent is configured. The session-files row runs for any
 *  non-Claude provider — it's about the Deck's live signal, which reads
 *  `~/.claude/projects` regardless of which agent seeds sessions, and Cursor's
 *  composer sessions don't show up there, so the row still has to explain
 *  itself under Cursor too.
 *
 *  Under `ask` the answer is not known until launch time, so every agent this
 *  host can run gets its rows — a user about to be asked needs all of the
 *  answers, not one of them. */
function agentChecks(i: DoctorInputs): Check[] {
  if (i.agentProvider === "claude-code") return claudeChecks(i);
  if (i.agentProvider !== "ask") return [...chatChecks(i, i.agentProvider), ...claudeSessionChecks(i)];
  const others = i.hostProviders.filter((p): p is Exclude<Provider, "claude-code"> => p !== "claude-code");
  // No trailing `claudeSessionChecks` here: `claudeChecks` already ends with it. The
  // non-Claude arm above has to add it because it does NOT call `claudeChecks`.
  // Appending it a second time duplicated the row and double-counted its warning.
  return [...claudeChecks(i), ...others.flatMap((p) => chatChecks(i, p))];
}

/** The chat-panel row for whichever non-Claude agent is configured. Both Copilot
 *  and Cursor serve `workbench.action.chat.open`, so availability is one probe
 *  (`chatCommand`) — but the group, the row text, and the remedy differ per
 *  provider, so this stays a branch rather than a single templated row. Copilot's
 *  text is unchanged from before this row was shared (pinned by doctor.test.ts's
 *  "agent checks by provider" suite); Cursor's agent ships built into the editor,
 *  so its row carries no action to point at. */
function chatChecks(i: DoctorInputs, provider: Exclude<Provider, "claude-code">): Check[] {
  const ok = i.chatCommand.available;
  if (provider === "copilot") {
    return [
      {
        group: "Copilot",
        label: "Copilot Chat available",
        status: ok ? "ok" : "fail",
        detail: ok
          ? "workbench.action.chat.open is registered"
          : "no chat command is registered — GitHub Copilot Chat isn't available in this window",
        ...(ok ? {} : { action: { kind: "extension", id: "github.copilot-chat", label: "Show extension" } }),
      },
    ];
  }
  return [
    {
      group: "Cursor",
      label: "Cursor chat available",
      status: ok ? "ok" : "fail",
      detail: ok
        ? "workbench.action.chat.open is registered"
        : "no chat command is registered — Cursor's chat isn't available in this window",
    },
  ];
}

function claudeChecks(i: DoctorInputs): Check[] {
  const out: Check[] = [];
  const { installed, version } = i.claudeCode;

  out.push({
    group: "Claude Code",
    label: "Claude Code installed",
    status: installed ? "ok" : "fail",
    detail: installed ? (version ?? "installed") : "anthropic.claude-code is not installed",
    ...(installed ? {} : { action: { kind: "extension", id: "anthropic.claude-code", label: "Show extension" } }),
  });

  if (!installed) {
    out.push({ group: "Claude Code", label: "Claude Code version", status: "skip", detail: "extension not installed" });
  } else {
    const cmp = compareVersions(version, CLAUDE_CODE_FLOOR);
    out.push({
      group: "Claude Code",
      label: "Claude Code version",
      // Unparseable counts as below the floor: claiming a version is fine when we
      // can't read it is the one answer that could mislead.
      status: cmp === null || cmp < 0 ? "warn" : "ok",
      detail:
        cmp === null
          ? `can't read "${version}" — ${CLAUDE_CODE_FLOOR}+ is needed for shared-window batches`
          : cmp < 0
            ? `${version} — ${CLAUDE_CODE_FLOOR}+ is needed for shared-window batches`
            : (version as string),
    });
  }

  out.push(...claudeSessionChecks(i));

  return out;
}

function claudeSessionChecks(i: DoctorInputs): Check[] {
  return [
    {
      group: "Claude Code",
      label: "Claude session files",
      status: i.claudeProjectsReadable ? "ok" : "warn",
      detail: i.claudeProjectsReadable
        ? "~/.claude/projects is readable"
        : `~/.claude/projects is unreadable — the Deck's live signal falls back to git and ${i.sourceLabel}`,
    },
  ];
}

function stateChecks(i: DoctorInputs): Check[] {
  return [
    {
      group: "State",
      label: "Tracked runs",
      status: "ok",
      detail: `${i.runs} in ~/.agentflow/runs`,
    },
  ];
}

/** `null` when either side can't be read as a dotted number triple. */
function compareVersions(a: string | null, b: string): number | null {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const left = a ? parse(a) : null;
  const right = parse(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

/** The QuickPick title: what to fix, counted. */
export function summarize(checks: Check[]): string {
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  if (!fails && !warns) return "Everything checks out";
  const parts: string[] = [];
  if (fails) parts.push(`${fails} problem${fails === 1 ? "" : "s"}`);
  if (warns) parts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** Plain text for the clipboard — pasteable into a ticket or a Slack thread, so no
 *  codicons and no markup. `sourceLabel` is the one place this module accepts a
 *  source's own text: the `"source"` group placeholder renders as this string,
 *  so a Jira user reads "Jira:" exactly as before the group's name went generic. */
export function formatReport(checks: Check[], sourceLabel: string): string {
  const lines = [`Agent Flow Deck Doctor — ${summarize(checks)}`, ""];
  let group: DoctorGroup | null = null;
  for (const c of [...checks].sort((a, b) => groupOrder(a.group) - groupOrder(b.group))) {
    if (c.group !== group) {
      group = c.group;
      lines.push(`${group === "source" ? sourceLabel : group}:`);
    }
    lines.push(`  [${c.status}] ${c.label} — ${c.detail}`);
  }
  return lines.join("\n");
}

/** The groups whose position is fixed regardless of which source or forge is
 *  configured. The forge's own group (`"GitHub"`, `"GitLab"`, …) is deliberately
 *  absent — it is never one of these literals, so it always falls into the `-1`
 *  branch below and lands in the slot the old hardcoded `"GitHub"` used to hold. */
const FIXED_GROUP_ORDER: DoctorGroup[] = ["source", "Local", "Claude Code", "Copilot", "Cursor", "State"];

function groupOrder(g: DoctorGroup): number {
  const idx = FIXED_GROUP_ORDER.indexOf(g);
  if (idx === -1) return 2; // the forge's own group, between Local and Claude Code
  return idx < 2 ? idx : idx + 1;
}
