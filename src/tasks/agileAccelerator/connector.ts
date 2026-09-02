import * as vscode from "vscode";
import { getConfig } from "../../config";
import type { AuthProbe, ProjectProbe } from "../../engine/doctor";
import { isTaskNetworkError, SourceInfo, TaskConnector, TaskProvider } from "../provider";
import { SfCli, SfMissingError } from "./cli";
import { buildSchema, WORK_OBJECT_CANDIDATES, type Schema } from "./describe";
import { AgileAcceleratorProvider } from "./provider";
import { buildStatusQuery } from "./soql";
import { keyOf, readStatus, recordUrl, statusCategoryOf, type SfRecord } from "./shape";

/** Frozen on release. Renaming either strands every configured install. */
const ENDPOINT_SETTING = "agentFlow.agileAccelerator.instanceUrl";
const SCOPE_SETTING = "agentFlow.agileAccelerator.team";
const TARGET_ORG_SETTING = "agentFlow.agileAccelerator.targetOrg";

/** How long a status readback stays fresh. The Deck polls `status()` per run
 *  card; without this each card would cost its own process spawn. */
const STATUS_TTL_MS = 30_000;

/** `buildStatusQuery` emits `LIMIT keys.length`, so an unbounded key list is an
 *  unbounded query. A session that has ever shown this many tickets is not
 *  realistic, so chunking past this is a safety valve, not a normal path. */
const STATUS_BATCH_CAP = 200;

/** Nothing evicted `statuses` before this existed, so every key ever polled in
 *  the session would rejoin every later TTL refresh forever. Map preserves
 *  insertion order, so a delete+set moves an entry to the end; whatever
 *  iterates first is the oldest. */
const STATUS_CACHE_CAP = 500;

const SF_INSTALL_URL = "https://developer.salesforce.com/tools/salesforcecli";

class AgileAcceleratorConnector implements TaskConnector {
  readonly id = "agileAccelerator";
  readonly setupSteps = 3;
  readonly signInSteps = 0; // `sf org login web` owns the round-trip; we prompt for nothing

  /** `makeCli` defaults to the real constructor; tests inject a fake so
   *  `probe()`, `statusOf`'s coalescing, and `schema()`'s retry can be exercised
   *  without a real `sf` process. */
  constructor(private readonly makeCli: (targetOrg: string) => SfCli = (targetOrg) => new SfCli(targetOrg)) {}

  /** Session-lived caches. They live here, not on a provider: `provider()` is
   *  rebuilt per operation by contract. */
  private schemaCache: Promise<Schema> | null = null;
  private identityCache: Promise<{ id: string; displayName: string } | null> | null = null;
  private readonly ids = new Map<string, string>();
  private readonly statuses = new Map<string, { at: number; status: string | null; category: string | null }>();

  /** Misses that arrive in the same microtask tick — which, per deckView's
   *  `Promise.all` refresh, is the whole Deck's cards at once — are coalesced
   *  into one query by `flushStatuses`. Keyed by ticket key so every waiter for
   *  that key gets the same result. */
  private pendingWaiters = new Map<string, Array<(r: { status: string | null; category: string | null }) => void>>();
  private statusFlushScheduled = false;
  /** Whichever `SfCli` last registered a miss. Every `SfCli` built this session
   *  shares one `targetOrg`, so "last one wins" is equivalent to "any one". */
  private pendingCli: SfCli | null = null;

  private cli(): SfCli {
    return this.makeCli(getConfig().agileAcceleratorTargetOrg.trim());
  }

  info(): SourceInfo {
    const cfg = getConfig();
    return {
      label: "Agile Accelerator",
      scopeNoun: "team",
      scopeValue: cfg.agileAcceleratorTeam.trim(),
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
    // A cached negative — from a prior timeout, not necessarily a real "signed
    // out" — would otherwise survive this call, so "refresh the Deck" re-reads
    // the same stale failure the CLI sign-in was meant to fix.
    this.identityCache = null;
    this.schemaCache = null;
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
      team: cfg.agileAcceleratorTeam.trim(),
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

    // Deliberately bypasses `identity()`: that cache swallows every failure to
    // null for callers who only want "signed in or not", which is exactly what
    // made this branch dead before — a CLI timeout came back as `null`, never
    // as a rejection, so it was misreported as `reason: "auth"`. Doctor's
    // auth|network split exists to prevent precisely that, so this needs the
    // raw thrown error.
    let auth: AuthProbe;
    try {
      const me = await cli.userInfo();
      auth = me.username
        ? { ok: true, displayName: me.username }
        : { ok: false, reason: "auth", message: "Run `sf org login web` to sign in." };
    } catch (e) {
      if (e instanceof SfMissingError) {
        auth = {
          ok: false,
          reason: "auth",
          message: `The Salesforce CLI (sf) was not found. Install it: ${SF_INSTALL_URL}`,
        };
      } else if (isTaskNetworkError(e)) {
        auth = { ok: false, reason: "network", message: e instanceof Error ? e.message : String(e) };
      } else {
        auth = { ok: false, reason: "auth", message: e instanceof Error ? e.message : "Run `sf org login web` to sign in." };
      }
    }
    if (!auth.ok) return { auth };

    let scope: ProjectProbe;
    try {
      const schema = await this.schema(cli);
      scope = schema.teamField
        ? { ok: true, name: getConfig().agileAcceleratorTeam.trim() }
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
    const instanceUrl = getConfig().agileAcceleratorInstanceUrl;
    const id = this.ids.get(key);
    return id ? recordUrl(instanceUrl, id) : instanceUrl.replace(/\/+$/, "");
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
      .catch(() => {
        // A thrown error is not a confident "signed out" — it may be a
        // transient timeout. Don't poison the cache with it: clear the slot so
        // the next call retries, exactly as `schema()` already does below.
        // This call itself still resolves to null — the swallow-to-null
        // contract non-probe callers rely on is unchanged; `probe()` needs the
        // raw throw instead, so it calls `cli.userInfo()` directly rather than
        // through here.
        this.identityCache = null;
        return null;
      });
    return this.identityCache;
  }

  /** One describe per session. Tries the packaged object, then the bare one GUS
   *  uses. A failure clears the cache so a later call can retry. */
  private schema(cli: SfCli): Promise<Schema> {
    if (!this.schemaCache) {
      // Named, so the failure handler can check it is still the current attempt
      // before clearing. `signIn`/`signOut` null this slot directly, so an
      // in-flight describe CAN lose ownership of it mid-flight; without the
      // identity check, that describe's later rejection would evict a healthy
      // newer promise and cost a redundant round trip.
      const p: Promise<Schema> = (async () => {
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
        if (this.schemaCache === p) this.schemaCache = null;
        throw e;
      });
      this.schemaCache = p;
    }
    return this.schemaCache;
  }

  /** Registers a miss and schedules (at most once) a same-tick flush that
   *  coalesces every key requested before the flush runs into one query.
   *  deckView's refresh fans out `Promise.all` over every card in a single
   *  tick, so this is the difference between one query per refresh and one
   *  query per card. Never throws — every path resolves via `flushStatuses`. */
  private statusOf(cli: SfCli, key: string): Promise<{ status: string | null; category: string | null }> {
    const now = Date.now();
    const hit = this.statuses.get(key);
    if (hit && now - hit.at < STATUS_TTL_MS) return Promise.resolve({ status: hit.status, category: hit.category });

    this.pendingCli = cli;
    return new Promise((resolve) => {
      const waiters = this.pendingWaiters.get(key);
      if (waiters) waiters.push(resolve);
      else this.pendingWaiters.set(key, [resolve]);

      if (!this.statusFlushScheduled) {
        this.statusFlushScheduled = true;
        queueMicrotask(() => void this.flushStatuses());
      }
    });
  }

  /** Runs once per scheduled tick, however many keys arrived in it. */
  private async flushStatuses(): Promise<void> {
    this.statusFlushScheduled = false;
    const waiters = this.pendingWaiters;
    this.pendingWaiters = new Map();
    const cli = this.pendingCli;
    const keys = [...waiters.keys()];
    const now = Date.now();

    const settle = (ks: readonly string[], result: { status: string | null; category: string | null }) => {
      for (const k of ks) for (const w of waiters.get(k) ?? []) w(result);
    };

    if (!cli || keys.length === 0) {
      settle(keys, { status: null, category: null });
      return;
    }

    let schema: Schema;
    try {
      schema = await this.schema(cli);
    } catch {
      // A background poll behind an already-rendered card: unknown is a
      // better answer than a thrown error. Not cached, so the next flush
      // (`schema()` having cleared its own cache on failure) retries.
      settle(keys, { status: null, category: null });
      return;
    }

    for (let i = 0; i < keys.length; i += STATUS_BATCH_CAP) {
      const chunk = keys.slice(i, i + STATUS_BATCH_CAP);
      try {
        const records = await cli.query<SfRecord>(buildStatusQuery(schema, chunk));
        const returned = new Set<string>();
        for (const rec of records) {
          const k = keyOf(rec);
          if (!k) continue;
          const status = readStatus(rec, schema);
          const entry = { at: now, status: status || null, category: status ? statusCategoryOf(status) : null };
          this.rememberStatus(k, entry);
          returned.add(k);
          settle([k], { status: entry.status, category: entry.category });
        }
        // Keys the org did not return are cached as unknown, so a deleted
        // record does not re-query on every poll.
        const missing = chunk.filter((k) => !returned.has(k));
        for (const k of missing) this.rememberStatus(k, { at: now, status: null, category: null });
        settle(missing, { status: null, category: null });
      } catch {
        // Not cached, on purpose — see the comment on the outer catch above.
        settle(chunk, { status: null, category: null });
      }
    }
  }

  private rememberStatus(key: string, entry: { at: number; status: string | null; category: string | null }): void {
    this.statuses.delete(key);
    this.statuses.set(key, entry);
    if (this.statuses.size > STATUS_CACHE_CAP) {
      const oldest = this.statuses.keys().next().value;
      if (oldest !== undefined) this.statuses.delete(oldest);
    }
  }
}

export function makeAgileAcceleratorConnector(
  _ctx: vscode.ExtensionContext,
  makeCli?: (targetOrg: string) => SfCli,
): TaskConnector {
  // `_ctx` is unused — this connector stores no secrets. The parameter exists to
  // match the registry's factory signature. `makeCli` is test-only DI mirroring
  // `cli.ts`'s own `run?`/`locate?` seam; production callers never pass it.
  return new AgileAcceleratorConnector(makeCli);
}
