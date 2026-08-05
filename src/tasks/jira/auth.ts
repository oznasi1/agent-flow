import * as vscode from "vscode";

/**
 * Pluggable Jira authentication. The rest of the extension only depends on this
 * interface, so the concrete mechanism (API token today, OAuth web-flow later)
 * can be swapped without touching the client or UI.
 */
export interface JiraAuth {
  /** Returns the value for the HTTP `Authorization` header, or undefined if not signed in. */
  getAuthHeader(): Promise<string | undefined>;
  isAuthenticated(): Promise<boolean>;
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;
}

const EMAIL_KEY = "agentFlow.jira.email";
const TOKEN_KEY = "agentFlow.jira.token";

/**
 * API-token auth for Atlassian Cloud (Basic auth: base64(email:apiToken)).
 * Credentials live in VS Code SecretStorage (encrypted, never in settings.json).
 *
 * This is the v1 provider. The OAuth web-flow provider (a vscode
 * AuthenticationProvider that opens the browser) will implement the same
 * interface and replace this once an OAuth app is registered.
 */
export class ApiTokenAuth implements JiraAuth {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async getAuthHeader(): Promise<string | undefined> {
    const email = await this.secrets.get(EMAIL_KEY);
    const token = await this.secrets.get(TOKEN_KEY);
    if (!email || !token) return undefined;
    const basic = Buffer.from(`${email}:${token}`).toString("base64");
    return `Basic ${basic}`;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.getAuthHeader()) !== undefined;
  }

  async signIn(): Promise<boolean> {
    const email = await vscode.window.showInputBox({
      title: "Jira sign-in (1/2)",
      prompt: "Your Atlassian account email",
      ignoreFocusOut: true,
      placeHolder: "you@example.com",
      validateInput: (v) => (v.includes("@") ? undefined : "Enter a valid email"),
    });
    if (!email) return false;

    const token = await vscode.window.showInputBox({
      title: "Jira sign-in (2/2)",
      prompt: "Atlassian API token — create one at id.atlassian.com/manage-profile/security/api-tokens",
      ignoreFocusOut: true,
      password: true,
    });
    if (!token) return false;

    await this.secrets.store(EMAIL_KEY, email.trim());
    await this.secrets.store(TOKEN_KEY, token.trim());
    return true;
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(EMAIL_KEY);
    await this.secrets.delete(TOKEN_KEY);
  }
}
