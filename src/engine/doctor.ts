// Agent Flow depends on five things outside itself — a reachable Jira site, valid
// credentials, `gh` installed *and* signed in, a reposRoot that holds checkouts, and
// the Claude Code extension. Today each one fails at the moment of use, narrowly,
// and three of them fail silently. This module decides what is broken; it does no
// probing of its own so it stays free of `vscode` and testable as a plain table.

/** The Claude Code build that introduced `claude-vscode.editor.open`, which the
 *  shared-window batch launch needs. Below this, that one feature degrades. */
export const CLAUDE_CODE_FLOOR = "2.1.220";

/** Most decisive first. `skip` outranks `ok` because "not applicable" is a fact the
 *  reader may want to question, whereas a pass needs no attention at all. */
export type CheckStatus = "fail" | "warn" | "skip" | "ok";

export type DoctorGroup = "Jira" | "Local" | "GitHub" | "Claude Code" | "State";

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
  baseUrl: string;
  project: string;
  hasCredentials: boolean;
  authProbe?: AuthProbe;
  projectProbe?: ProjectProbe;
  gitOnPath: boolean;
  reposRoot: { path: string; exists: boolean; repos: number; gitRepos: number };
  workspaceDir: { path: string; exists: boolean; writable: boolean };
  prFacts: boolean;
  // Structural rather than importing GhGap, which lives beside `vscode`-aware code.
  gh?: { gap: { kind: "missing" | "signed-out"; detail: string } | null; foundAt: string | null };
  claudeCode: { installed: boolean; version: string | null };
  claudeProjectsReadable: boolean;
  runs: number;
}

const SIGN_IN: DoctorAction = { kind: "command", command: "agentFlow.signIn", label: "Sign in" };
const SETUP: DoctorAction = { kind: "command", command: "agentFlow.setup", label: "Run Setup" };

const RANK: Record<CheckStatus, number> = { fail: 0, warn: 1, skip: 2, ok: 3 };

/** Every check, most decisive first, so the QuickPick opens on the thing to fix. */
export function runChecks(i: DoctorInputs): Check[] {
  const checks: Check[] = [...jiraChecks(i), ...localChecks(i), ...ghChecks(i), ...claudeChecks(i), ...stateChecks(i)];
  // A stable sort keeps the authored group order inside one status, so the report
  // reads top-to-bottom the way the check set is documented.
  return checks
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => RANK[a.c.status] - RANK[b.c.status] || a.idx - b.idx)
    .map(({ c }) => c);
}

function jiraChecks(i: DoctorInputs): Check[] {
  const out: Check[] = [];

  const siteOk = /^https:\/\/.+/.test(i.baseUrl);
  out.push({
    group: "Jira",
    label: "Site configured",
    status: siteOk ? "ok" : "fail",
    detail: i.baseUrl
      ? siteOk
        ? i.baseUrl
        : `${i.baseUrl} — needs to be an https URL`
      : "agentFlow.jira.baseUrl is empty",
    ...(siteOk ? {} : { action: SETUP }),
  });

  out.push({
    group: "Jira",
    label: "Project configured",
    status: i.project ? "ok" : "fail",
    detail: i.project || "agentFlow.jira.project is empty",
    ...(i.project ? {} : { action: SETUP }),
  });

  out.push({
    group: "Jira",
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
          group: "Jira",
          label: "Credentials valid",
          status: "skip",
          detail: "not probed — no credentials to probe with",
        }
      : i.authProbe.ok
        ? { group: "Jira", label: "Credentials valid", status: "ok", detail: `signed in as ${i.authProbe.displayName}` }
        : i.authProbe.reason === "auth"
          ? { group: "Jira", label: "Credentials valid", status: "fail", detail: i.authProbe.message, action: SIGN_IN }
          : { group: "Jira", label: "Credentials valid", status: "warn", detail: i.authProbe.message },
  );

  out.push(
    !i.projectProbe
      ? {
          group: "Jira",
          label: "Project resolves",
          status: "skip",
          detail: "not probed — credentials are missing or rejected",
        }
      : i.projectProbe.ok
        ? { group: "Jira", label: "Project resolves", status: "ok", detail: i.projectProbe.name }
        : i.projectProbe.reason === "not-found"
          ? {
              group: "Jira",
              label: "Project resolves",
              status: "fail",
              detail: `${i.project} not found, or not visible to you`,
              action: SETUP,
            }
          : { group: "Jira", label: "Project resolves", status: "warn", detail: i.projectProbe.message },
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

function ghChecks(i: DoctorInputs): Check[] {
  if (!i.prFacts || !i.gh) {
    return [{ group: "GitHub", label: "gh", status: "skip", detail: "agentFlow.prFacts is off" }];
  }
  const { gap, foundAt } = i.gh;
  // Naming where gh was found is the most valuable line in the report: a Homebrew
  // gh invisible to the extension host's bare launchd PATH reads, to a signed-in
  // user, as the Deck simply being broken.
  if (!gap) {
    return [{ group: "GitHub", label: "gh", status: "ok", detail: `signed in — ${foundAt ?? "gh"}` }];
  }
  return [
    {
      group: "GitHub",
      label: "gh",
      status: "fail",
      detail:
        gap.kind === "missing"
          ? "not installed, or not on a PATH the extension host can see"
          : `signed out — ${foundAt ?? "gh"}`,
      action: { kind: "external", url: "https://cli.github.com", label: "Install gh" },
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

  out.push({
    group: "Claude Code",
    label: "Claude session files",
    status: i.claudeProjectsReadable ? "ok" : "warn",
    detail: i.claudeProjectsReadable
      ? "~/.claude/projects is readable"
      : "~/.claude/projects is unreadable — the Deck's live signal falls back to git and Jira",
  });

  return out;
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
 *  codicons and no markup. */
export function formatReport(checks: Check[]): string {
  const lines = [`Agent Flow Doctor — ${summarize(checks)}`, ""];
  let group: DoctorGroup | null = null;
  for (const c of [...checks].sort((a, b) => groupOrder(a.group) - groupOrder(b.group))) {
    if (c.group !== group) {
      group = c.group;
      lines.push(`${group}:`);
    }
    lines.push(`  [${c.status}] ${c.label} — ${c.detail}`);
  }
  return lines.join("\n");
}

function groupOrder(g: DoctorGroup): number {
  return ["Jira", "Local", "GitHub", "Claude Code", "State"].indexOf(g);
}
