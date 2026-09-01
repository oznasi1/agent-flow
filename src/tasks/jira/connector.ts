import * as vscode from "vscode";
import { getConfig } from "../../config";
import type { AuthProbe, ProjectProbe } from "../../engine/doctor";
import { SetupStep, SourceInfo, TaskConnector, TaskProvider } from "../provider";
import { ApiTokenAuth, JiraAuth } from "./auth";
import { JiraClient, JiraAuthError } from "./client";
import { describeJiraError, JiraApiError } from "./errors";
import { JiraProvider } from "./provider";

/** The url shape every Agent Flow run record written to date carries. Parsing it
 * is a compatibility obligation, not a design choice — see the compat test. */
const BROWSE = "/browse/";

/** The two settings this connector owns. Frozen: they shipped, and renaming them
 * would strand every configured install. */
const ENDPOINT_SETTING = "agentFlow.jira.baseUrl";
const SCOPE_SETTING = "agentFlow.jira.project";

class JiraConnector implements TaskConnector {
  readonly id = "jira";
  readonly setupSteps = 2;
  readonly signInSteps = 2; // email, then API token

  constructor(private readonly auth: JiraAuth) {}

  info(): SourceInfo {
    const cfg = getConfig();
    return {
      label: "Jira",
      scopeNoun: "project",
      scopeValue: cfg.project,
      endpoint: cfg.baseUrl,
      exampleKey: `${cfg.project || "ABC"}-1234`,
      endpointSetting: ENDPOINT_SETTING,
      scopeSetting: SCOPE_SETTING,
    };
  }

  isConfigured(): boolean {
    const cfg = getConfig();
    return !!cfg.baseUrl.trim() && !!cfg.project.trim();
  }

  /** The site URL and project key, as steps `from` and `from + 1` of `total`.
   * Collects only: the returned thunk writes both to global settings in one go,
   * exactly as the pre-seam wizard did — after its last abort guard, so an Esc at
   * a later step leaves an already-configured user's two settings untouched. */
  async configure(from: number, total: number): Promise<(() => Promise<void>) | null> {
    const baseUrl = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from}/${total})`,
      prompt: "Your Atlassian Jira Cloud site URL",
      ignoreFocusOut: true,
      placeHolder: "https://your-org.atlassian.net",
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return "Enter your Jira site URL";
        try {
          return new URL(t).protocol === "https:" ? undefined : "URL must start with https://";
        } catch {
          return "Enter a valid URL (e.g. https://your-org.atlassian.net)";
        }
      },
    });
    if (baseUrl === undefined) return null;

    const project = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from + 1}/${total})`,
      prompt: "Jira project key to pull tasks from",
      ignoreFocusOut: true,
      placeHolder: "ABC",
      validateInput: (v) => (v.trim() ? undefined : "Enter a project key"),
    });
    if (project === undefined) return null;

    // Normalized here, beside the input each value came from; the thunk only writes.
    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    const cleanProject = project.trim().toUpperCase();
    return async () => {
      const c = vscode.workspace.getConfiguration("agentFlow");
      await c.update("jira.baseUrl", cleanBaseUrl, vscode.ConfigurationTarget.Global);
      await c.update("jira.project", cleanProject, vscode.ConfigurationTarget.Global);
    };
  }

  isAuthenticated(): Promise<boolean> { return this.auth.isAuthenticated(); }
  signIn(step?: SetupStep): Promise<boolean> { return this.auth.signIn(step); }
  signOut(): Promise<void> { return this.auth.signOut(); }

  provider(): TaskProvider {
    const cfg = getConfig();
    return new JiraProvider(new JiraClient(cfg.baseUrl, cfg.project, this.auth));
  }

  /** No stored credentials means nothing to diagnose: a user who has never
   * signed in gets a neutral Doctor `skip` — see the `probe()` contract on
   * `TaskConnector` (src/tasks/provider.ts) — not a manufactured auth failure.
   * This gate is self-contained: it calls this connector's own
   * `isAuthenticated()` rather than trusting a caller to check first, so `{}`
   * (both members `undefined`, i.e. "not probed") stays reachable even if a
   * future caller forgets to gate on `hasCredentials` before calling this.
   *
   * Beyond that: the scope lookup is skipped whenever auth failed or no project
   * is configured, because its answer would be meaningless and the call cannot
   * succeed. A signed-out (or half-configured) user should see one problem, not
   * a cascade of two. */
  async probe(): Promise<{ auth?: AuthProbe; scope?: ProjectProbe }> {
    if (!(await this.isAuthenticated())) return {};
    const cfg = getConfig();
    const client = new JiraClient(cfg.baseUrl, cfg.project, this.auth);
    let auth: AuthProbe;
    try {
      const me = await client.probeMyself();
      auth = { ok: true, displayName: me.displayName || me.accountId };
    } catch (e) {
      // JiraAuthError means the credentials; anything else means reaching Jira
      // at all. request() already phrases both well, so invent no wording here.
      auth = e instanceof JiraAuthError
        ? { ok: false, reason: "auth", message: e.message }
        : { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) };
    }
    if (!cfg.project || !auth.ok) return { auth };
    let scope: ProjectProbe;
    try {
      const p = await client.getProject(cfg.project);
      scope = { ok: true, name: p.name || p.key };
    } catch (e) {
      const message = e instanceof JiraApiError
        ? describeJiraError(e)
        : e instanceof Error ? e.message : String(e);
      scope = e instanceof JiraApiError && e.status === 404
        ? { ok: false, reason: "not-found", message }
        : { ok: false, reason: "error", message };
    }
    return { auth, scope };
  }

  taskUrl(key: string): string {
    return `${getConfig().baseUrl}${BROWSE}${key}`;
  }

  keyFromUrl(url: string): string | null {
    const i = typeof url === "string" ? url.indexOf(BROWSE) : -1;
    if (i < 0) return null;
    const key = url.slice(i + BROWSE.length).trim();
    return key || null;
  }
}

export function makeJiraConnector(ctx: vscode.ExtensionContext): TaskConnector {
  return new JiraConnector(new ApiTokenAuth(ctx.secrets));
}
