import * as vscode from "vscode";
import { getConfig } from "../../config";
import type { AuthProbe, ProjectProbe } from "../../engine/doctor";
import { SourceInfo, TaskConnector, TaskProvider } from "../provider";
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
   * Writes to global settings, exactly as the pre-seam wizard did. */
  async configure(from: number, total: number): Promise<boolean> {
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
    if (baseUrl === undefined) return false;

    const project = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from + 1}/${total})`,
      prompt: "Jira project key to pull tasks from",
      ignoreFocusOut: true,
      placeHolder: "ABC",
      validateInput: (v) => (v.trim() ? undefined : "Enter a project key"),
    });
    if (project === undefined) return false;

    const c = vscode.workspace.getConfiguration("agentFlow");
    await c.update("jira.baseUrl", baseUrl.trim().replace(/\/+$/, ""), vscode.ConfigurationTarget.Global);
    await c.update("jira.project", project.trim().toUpperCase(), vscode.ConfigurationTarget.Global);
    return true;
  }

  isAuthenticated(): Promise<boolean> { return this.auth.isAuthenticated(); }
  signIn(): Promise<boolean> { return this.auth.signIn(); }
  signOut(): Promise<void> { return this.auth.signOut(); }

  provider(): TaskProvider {
    const cfg = getConfig();
    return new JiraProvider(new JiraClient(cfg.baseUrl, cfg.project, this.auth));
  }

  /** Ordered on purpose: the scope lookup is skipped when auth failed, because
   * its answer would be meaningless and the call cannot succeed. A signed-out
   * user should see one problem, not a cascade of two. */
  async probe(): Promise<{ auth?: AuthProbe; scope?: ProjectProbe }> {
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
