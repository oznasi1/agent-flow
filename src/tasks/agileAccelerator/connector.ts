import * as vscode from "vscode";
import { getConfig } from "../../config";
import type { AuthProbe, ProjectProbe } from "../../engine/doctor";
import { SourceInfo, TaskConnector, TaskProvider } from "../provider";
import { SfCli } from "./cli";
import { buildSchema, WORK_OBJECT_CANDIDATES, type Schema } from "./describe";
import { AgileAcceleratorProvider } from "./provider";
import { buildStatusQuery } from "./soql";
import { keyOf, statusCategoryOf, type SfRecord } from "./shape";

/** Frozen on release. Renaming either strands every configured install. */
const ENDPOINT_SETTING = "agentFlow.agileAccelerator.instanceUrl";
const SCOPE_SETTING = "agentFlow.agileAccelerator.team";
const TARGET_ORG_SETTING = "agentFlow.agileAccelerator.targetOrg";

/** How long a status readback stays fresh. The Deck polls `status()` per run
 *  card; without this each card would cost its own process spawn. */
const STATUS_TTL_MS = 30_000;

const SF_INSTALL_URL = "https://developer.salesforce.com/tools/salesforcecli";

class AgileAcceleratorConnector implements TaskConnector {
  readonly id = "agileAccelerator";
  readonly setupSteps = 3;

  /** Session-lived caches. They live here, not on a provider: `provider()` is
   *  rebuilt per operation by contract. */
  private schemaCache: Promise<Schema> | null = null;
  private identityCache: Promise<{ id: string; displayName: string } | null> | null = null;
  private readonly ids = new Map<string, string>();
  private readonly statuses = new Map<string, { at: number; status: string | null; category: string | null }>();

  private cli(): SfCli {
    return new SfCli(getConfig().agileAcceleratorTargetOrg.trim());
  }

  info(): SourceInfo {
    const cfg = getConfig();
    return {
      label: "Agile Accelerator",
      scopeNoun: "team",
      scopeValue: cfg.agileAcceleratorTeam,
      endpoint: cfg.agileAcceleratorInstanceUrl,
      exampleKey: "W-1234567",
      endpointSetting: ENDPOINT_SETTING,
      scopeSetting: SCOPE_SETTING,
    };
  }

  isConfigured(): boolean {
    const cfg = getConfig();
    return !!cfg.agileAcceleratorInstanceUrl.trim() && !!cfg.agileAcceleratorTeam.trim();
  }

  /** Collect only. The returned thunk performs the writes, so an Esc at a later
   *  wizard step leaves an already-configured user's settings untouched. */
  async configure(from: number, total: number): Promise<(() => Promise<void>) | null> {
    const instanceUrl = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from}/${total})`,
      prompt: "Your Salesforce Lightning URL (GUS, or the org with Agile Accelerator installed)",
      ignoreFocusOut: true,
      placeHolder: "https://your-org.lightning.force.com",
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return "Enter your Lightning URL";
        try {
          return new URL(t).protocol === "https:" ? undefined : "URL must start with https://";
        } catch {
          return "Enter a valid URL (e.g. https://your-org.lightning.force.com)";
        }
      },
    });
    if (instanceUrl === undefined) return null;

    const team = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from + 1}/${total})`,
      prompt: "Your scrum team's name, exactly as it appears in Agile Accelerator",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "Enter your team name"),
    });
    if (team === undefined) return null;

    const targetOrg = await vscode.window.showInputBox({
      title: `Agent Flow Deck Setup (${from + 2}/${total})`,
      prompt: "Salesforce CLI org alias (optional — leave blank to use your default org)",
      ignoreFocusOut: true,
      placeHolder: "gus",
    });
    if (targetOrg === undefined) return null;

    return async () => {
      const c = vscode.workspace.getConfiguration();
      const g = vscode.ConfigurationTarget.Global;
      await c.update(ENDPOINT_SETTING, instanceUrl.trim().replace(/\/+$/, ""), g);
      await c.update(SCOPE_SETTING, team.trim(), g);
      await c.update(TARGET_ORG_SETTING, targetOrg.trim(), g);
    };
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.identity()) !== null;
  }

  /** The extension cannot own this flow — `sf` owns the browser round-trip and
   *  the token. Naming the command is the whole of the help we can give. */
  async signIn(): Promise<boolean> {
    void vscode.window.showInformationMessage(
      "Sign in with the Salesforce CLI: run `sf org login web` in a terminal, then refresh the Deck.",
    );
    return false;
  }

  /** Advisory only. This connector stores no credential, and `sf logout` would
   *  sign the user out of an org their other tooling may depend on. */
  async signOut(): Promise<void> {
    void vscode.window.showInformationMessage(
      "Agent Flow stores no Salesforce credentials. To sign out, run `sf org logout`.",
    );
    this.identityCache = null;
    this.schemaCache = null;
  }

  provider(): TaskProvider {
    const cfg = getConfig();
    const cli = this.cli();
    return new AgileAcceleratorProvider({
      cli,
      schema: () => this.schema(cli),
      identity: () => this.identity(),
      statusOf: (key) => this.statusOf(cli, key),
      rememberIds: (pairs) => {
        for (const [key, id] of pairs) if (key && id) this.ids.set(key, id);
      },
      team: cfg.agileAcceleratorTeam,
      instanceUrl: cfg.agileAcceleratorInstanceUrl,
    });
  }

  async probe(): Promise<{ auth?: AuthProbe; scope?: ProjectProbe }> {
    const cli = this.cli();
    if (!cli.installed()) {
      return {
        auth: { ok: false, reason: "auth", message: `The Salesforce CLI (sf) was not found. Install it: ${SF_INSTALL_URL}` },
      };
    }

    let auth: AuthProbe;
    try {
      const me = await this.identity();
      auth = me
        ? { ok: true, displayName: me.displayName }
        : { ok: false, reason: "auth", message: "Run `sf org login web` to sign in." };
    } catch (e) {
      auth = { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) };
    }
    if (!auth.ok) return { auth };

    let scope: ProjectProbe;
    try {
      const schema = await this.schema(cli);
      scope = schema.teamField
        ? { ok: true, name: getConfig().agileAcceleratorTeam }
        : { ok: false, reason: "not-found", message: `No team field found on ${schema.object}.` };
    } catch (e) {
      scope = { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
    }
    return { auth, scope };
  }

  /** Synchronous, so it cannot look an Id up. On a memo miss it returns the
   *  instance root — see the spec: a guessed deep-link shape that 404s is worse
   *  than an honest landing page. */
  taskUrl(key: string): string {
    const base = getConfig().agileAcceleratorInstanceUrl.replace(/\/+$/, "");
    const id = this.ids.get(key);
    return id ? `${base}/lightning/r/ADM_Work__c/${id}/view` : base;
  }

  /** Our own persisted urls carry an Id, not a key, so this returns null far more
   *  often than Jira's does. A wrong non-null answer would point a user at
   *  someone else's work item. */
  keyFromUrl(url: string): string | null {
    if (typeof url !== "string") return null;
    const m = /\bW-\d+\b/.exec(url);
    return m ? m[0] : null;
  }

  // ── caches ────────────────────────────────────────────────────────────────

  private identity(): Promise<{ id: string; displayName: string } | null> {
    this.identityCache ??= this.cli()
      .userInfo()
      .then((u) => (u.username ? { id: u.id, displayName: u.username } : null))
      .catch(() => null);
    return this.identityCache;
  }

  /** One describe per session. Tries the packaged object, then the bare one GUS
   *  uses. A failure clears the cache so a later call can retry. */
  private schema(cli: SfCli): Promise<Schema> {
    this.schemaCache ??= (async () => {
      let last: unknown;
      for (const object of WORK_OBJECT_CANDIDATES) {
        try {
          return buildSchema(object, await cli.describe(object));
        } catch (e) {
          last = e;
        }
      }
      throw last instanceof Error ? last : new Error("Could not describe the work item object.");
    })().catch((e: unknown) => {
      this.schemaCache = null;
      throw e;
    });
    return this.schemaCache;
  }

  /** Batched, TTL'd status readback. A miss fetches the missing key together
   *  with every other key already known, so a Deck full of cards costs one
   *  query rather than one per card. Never throws. */
  private async statusOf(
    cli: SfCli,
    key: string,
  ): Promise<{ status: string | null; category: string | null }> {
    const now = Date.now();
    const hit = this.statuses.get(key);
    if (hit && now - hit.at < STATUS_TTL_MS) return { status: hit.status, category: hit.category };

    const stale = [...this.statuses.entries()].filter(([, v]) => now - v.at >= STATUS_TTL_MS).map(([k]) => k);
    const keys = [...new Set([key, ...stale])];

    try {
      const schema = await this.schema(cli);
      const records = await cli.query<SfRecord>(buildStatusQuery(schema, keys));
      const seen = new Set<string>();
      for (const rec of records) {
        const k = keyOf(rec);
        if (!k) continue;
        const status = schema.has("Status__c") ? String(rec[schema.field("Status__c")] ?? "") : "";
        this.statuses.set(k, { at: now, status: status || null, category: status ? statusCategoryOf(status) : null });
        seen.add(k);
      }
      // Keys the org did not return are cached as unknown, so a deleted record
      // does not re-query on every poll.
      for (const k of keys) if (!seen.has(k)) this.statuses.set(k, { at: now, status: null, category: null });
    } catch {
      // A background poll behind an already-rendered card: unknown is a better
      // answer than a thrown error.
      return { status: null, category: null };
    }

    const out = this.statuses.get(key);
    return { status: out?.status ?? null, category: out?.category ?? null };
  }
}

export function makeAgileAcceleratorConnector(_ctx: vscode.ExtensionContext): TaskConnector {
  // `_ctx` is unused — this connector stores no secrets. The parameter exists to
  // match the registry's factory signature.
  return new AgileAcceleratorConnector();
}
