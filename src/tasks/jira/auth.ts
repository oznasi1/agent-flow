import * as vscode from "vscode";
import type { SetupStep } from "../provider";

/**
 * Pluggable Jira authentication. The rest of the extension only depends on this
 * interface, so the concrete mechanism (API token today, OAuth web-flow later)
 * can be swapped without touching the client or UI.
 */
export interface JiraAuth {
  /** Returns the value for the HTTP `Authorization` header, or undefined if not signed in. */
  getAuthHeader(): Promise<string | undefined>;
  isAuthenticated(): Promise<boolean>;
  /** `step` present means the first-run wizard is asking — see `SetupStep`. */
  signIn(step?: SetupStep): Promise<boolean>;
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

  /** Two boxes, numbered as the wizard's last two steps when `step` says so and
   * as their own little pair when it does not — the standalone "Sign in to Jira"
   * command has no wizard to be part of. */
  async signIn(step?: SetupStep): Promise<boolean> {
    const title = (n: 0 | 1) =>
      step
        ? `Agent Flow Deck Setup (${step.from + n}/${step.total})`
        : `Jira sign-in (${n + 1}/2)`;

    const email = await vscode.window.showInputBox({
      title: title(0),
      prompt: "Your Atlassian account email",
      ignoreFocusOut: true,
      placeHolder: "you@example.com",
      validateInput: (v) => (v.includes("@") ? undefined : "Enter a valid email"),
    });
    if (!email) return false;

    // Handing over an API token is the step users hesitate at, so the prompt
    // spends its width on where the token goes rather than on where to get one:
    // it is stored by this editor, on this machine, and sent to nothing but the
    // Jira site the user just named. The token URL moves to the placeholder,
    // which is the one line long enough to hold it unclipped.
    const token = await vscode.window.showInputBox({
      title: title(1),
      prompt: "Atlassian API token — kept on this machine only, in this editor's encrypted secret storage",
      ignoreFocusOut: true,
      placeHolder: "Create one at id.atlassian.com/manage-profile/security/api-tokens",
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
