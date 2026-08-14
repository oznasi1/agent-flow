// The seam between Agent Flow and wherever its tickets come from. Deliberately
// free of `vscode` imports so it stays testable in isolation; anything needing
// the editor API belongs in a connector.
import { Filter, Task, Size } from "../types";
// `import type` on TaskDetail deliberately, and it is load-bearing rather than
// stylistic: client.ts imports auth.ts, which imports `vscode`. A value import
// would drag the editor API into this module, which is specified to load without
// it. A type-only import is erased at build time, so the chain is never followed
// at runtime. (`./fields` needs no such care — it imports nothing.)
import type { TaskDetail } from "./jira/client";
import type { FieldPrompt } from "./fields";
import type { AuthProbe, ProjectProbe } from "../engine/doctor";

export type { FieldPrompt, Task, TaskDetail };

/** Where a task can move to next, and what that move demands. `fields` is already
 * normalized to the generic prompt vocabulary — no source metadata escapes. */
export interface StatusTarget {
  id: string;
  toName: string;
  /** `""` means the source could not categorize this destination — distinct
   * from `"done"`. Only `"done"` drives run retirement, so an uncategorized
   * destination is treated as still-open. `Task.statusCategory` has no `""`
   * member — a task always has a category, a destination may not — so the two
   * must not be compared with `===` without handling that mismatch. */
  toCategory: "new" | "indeterminate" | "done" | "";
  /** The source's own name for the move, when it differs from the destination
   * (Jira transitions are named separately from their target status). */
  via?: string;
  fields: FieldPrompt[];
  /** Display names of fields the move REQUIRES but that could not be turned into a
   * prompt — a rich-text/ADF body, an attachment, a picker this vocabulary has no
   * shape for. The move is still attempted: the source may well accept it, and
   * refusing to try would be worse than letting the source decide.
   *
   * Diagnostic only, and never shown to the user. It exists because this is the one
   * place the extension makes a silent decision on the user's behalf: when the write
   * is then refused for a field nobody was asked about, the log line built from this
   * is the only way to learn the omission was deliberate rather than a bug.
   *
   * Optional so a source with nothing to declare (any source whose fields all map,
   * including the test fixture) needs no field at all — absent and empty mean the
   * same thing. */
  unfillable?: string[];
}

/** Optional operations, held as objects rather than booleans so that "supported"
 * and "callable" are the same fact — a caller cannot check one flag and then reach
 * for a differently-named method. */
export interface Capabilities {
  /** Only these filter tabs render. */
  supportedFilters: readonly Filter[];
  /** The size control needs a per-task estimate; sources without one set false. */
  sizes: boolean;
  labels?: { add(key: string, label: string): Promise<void> };
  sprints?: {
    activeId(): Promise<string | null>;
    add(sprintId: string, key: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  components?: {
    list(): Promise<string[] | null>;
    update(key: string, delta: { add?: string[]; remove?: string[] }): Promise<void>;
  };
}

/** Capabilities as they cross into the webview. The capability objects cannot be
 * structured-cloned, so the wire form is flat booleans. */
export interface SerializedCaps {
  supportedFilters: Filter[];
  sizes: boolean;
  labels: boolean;
  sprints: boolean;
  components: boolean;
}

export function serializeCaps(caps: Capabilities): SerializedCaps {
  return {
    supportedFilters: [...caps.supportedFilters],
    sizes: caps.sizes,
    labels: !!caps.labels,
    sprints: !!caps.sprints,
    components: !!caps.components,
  };
}

export interface TaskProvider {
  list(lens: Filter, size: Size, max?: number): Promise<Task[]>;
  detail(key: string): Promise<TaskDetail>;
  status(key: string): Promise<{ status: string | null; category: string | null }>;
  statusTargets(key: string): Promise<StatusTarget[]>;
  /** `values` are raw prompt answers; the connector maps them to its own wire
   * shape. Throws `TaskWriteError` on a refusal. */
  moveTo(key: string, targetId: string, values: Record<string, string | string[]>): Promise<void>;
  /** Assign the task to the signed-in user. `meId` is an `id` from a `me()` the caller
   * has ALREADY resolved: passing it saves a second identity round-trip, and — the
   * reason it exists — removes a half-done state from any caller that pairs this with
   * another write. A caller that resolves identity, writes, then calls this can
   * otherwise have the second lookup answer differently from the first and strand the
   * earlier write. Omitted means resolve it here, for callers with nothing in hand. */
  assignToMe(key: string, meId?: string): Promise<void>;
  /** The signed-in identity, or `null` when the source names nobody. `id` may be
   * empty on a source that can say who the user is but has no stable identifier for
   * them — enough to display, not enough to write with. A caller that pairs this
   * with a write must therefore check `id`, not merely non-`null` (see
   * `addToMySprint` in src/tasksView.ts). */
  me(): Promise<{ id: string; displayName: string } | null>;
  /** Resolve whatever `caps` depends on, then resolve. **`caps` may read differently
   * after this settles** — that is the entire purpose. Optional: a source whose
   * capabilities are static (the fixture connector, any source with no server-side
   * configuration to discover) simply omits it, and callers treat its absence as
   * "caps are already final."
   *
   * Never rejects for an ordinary "couldn't find out" — a connector that cannot learn
   * its own shape must fall back to whatever it already claimed. Callers invoke this
   * as a best-effort side quest alongside the first `list()`, so a rejection here
   * would surface as a failed first paint for a fact the user never asked about.
   *
   * A connector that implements this must make `caps` a **getter**: a field captured
   * in the constructor freezes the pre-probe answer into the very instance the panel
   * is already reading. */
  refreshCaps?(): Promise<void>;
  readonly caps: Capabilities;
}

/** The display facts every UI string needs, in one call so a connector has one
 * place to answer them rather than five accessors. */
export interface SourceInfo {
  /** User-facing name, e.g. "Jira". Every "Sign in to X" string reads this. */
  label: string;
  /** What this source calls its scope, e.g. "project". Doctor row labels. */
  scopeNoun: string;
  /** The configured scope, e.g. "ABC". Empty when unconfigured. */
  scopeValue: string;
  /** The configured endpoint, e.g. the site URL. Empty when unconfigured. */
  endpoint: string;
  /** A plausible key for a placeholder, e.g. "ABC-1234". */
  exampleKey: string;
  /** Setting ids to name in Doctor when the two above are empty. */
  endpointSetting: string;
  scopeSetting: string;
}

export interface TaskConnector {
  /** The `agentFlow.taskSource` value, e.g. "jira". */
  readonly id: string;
  info(): SourceInfo;

  isConfigured(): boolean;
  /** Collect this connector's own settings — and do NOT write them. `from`/`total`
   * keep the wizard's "(2/4)" numbering honest across connectors with different
   * step counts.
   *
   * Returns a commit thunk that performs the writes, or `null` when the user
   * cancelled partway. `setup.ts` invokes the thunk in one block after its own
   * last cancellable step, so cancelling the wizard anywhere leaves every setting
   * exactly as it was. Writing inside `configure()` instead would overwrite an
   * already-configured user's settings before a later step can still abort. */
  configure(from: number, total: number): Promise<(() => Promise<void>) | null>;
  readonly setupSteps: number;

  isAuthenticated(): Promise<boolean>;
  signIn(): Promise<boolean>;
  signOut(): Promise<void>;

  /** Built from current settings, per operation — exactly as `client()` did. */
  provider(): TaskProvider;

  /** Doctor's source-specific probes, already classified. Genuinely typed against
   * `engine/doctor.ts`'s `AuthProbe`/`ProjectProbe` — this is the one place a
   * probe's producer and its consumer must agree on a field name, and `unknown`
   * would let that drift silently. `engine/doctor.ts` has no imports of its own,
   * so importing its types here (type-only) cannot create a cycle. `undefined`
   * on either member means that probe was deliberately not run — Doctor renders
   * that as `skip`, not as a pass. */
  probe(): Promise<{ auth?: AuthProbe; scope?: ProjectProbe }>;

  taskUrl(key: string): string;
  /** Recover a task key from a url on an already-persisted run record. Returns
   * null when the url is not this source's, so the caller falls back to the
   * record key. */
  keyFromUrl(url: string): string | null;
}

// ── Errors ───────────────────────────────────────────────────────────────────
// Every class sets `this.name` to a string literal. esbuild.js runs with
// `minify: true` and no `keepNames`, so the class identifier is NOT a stable
// runtime value, and telemetry/events.ts classifies by `.name`.

export class TaskAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskAuthError";
  }
}

/** A non-2xx response. Keeps the envelope intact so a caller can react to failing
 * fields structurally instead of matching on prose. */
export class TaskApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors: Record<string, string>,
    readonly messages: string[],
  ) {
    super(message);
    this.name = "TaskApiError";
  }
}

/** A refused write. `retryWith` is the connector saying "ask the user for these,
 * then try again" — the only recovery a view knows how to perform. Empty means
 * there is nothing left to try.
 *
 * `status` is the transport status when the source has one, for the log line only —
 * 403-vs-400 is the difference between "you may not" and "that was malformed", and a
 * refusal message often states neither. Optional because a source need not be HTTP;
 * nothing user-facing may depend on it. */
export class TaskWriteError extends Error {
  constructor(
    message: string,
    readonly retryWith: FieldPrompt[] = [],
    readonly status?: number,
  ) {
    super(message);
    this.name = "TaskWriteError";
  }
}

/** Tag a network-level failure (unreachable host, DNS, timeout) as source-origin.
 * Stays an ordinary Error on purpose: views branch on `instanceof TaskApiError` /
 * `TaskAuthError`, and promoting a network failure into either would be a false
 * positive with real behavioural fallout. `code` is the field
 * classifyFailure (telemetry/events.ts) already reads. */
export function markTaskNetworkFailure(e: Error, code: "ETIMEDOUT" | "ENOTFOUND"): Error {
  return Object.assign(e, { code, taskSourceOrigin: true });
}

export function isTaskNetworkError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { taskSourceOrigin?: unknown }).taskSourceOrigin === true
  );
}
