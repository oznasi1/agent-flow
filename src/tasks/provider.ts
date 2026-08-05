// The seam between Agent Flow and wherever its tickets come from. Deliberately
// free of `vscode` imports so it stays testable in isolation; anything needing
// the editor API belongs in a connector.
import { Filter, JiraTask as Task, Size } from "../types";
// `import type` on both of these deliberately: client.ts imports auth.ts, which
// imports `vscode`. A value import would drag the editor API into a module that
// must stay loadable in isolation; a type-only import is erased at build time.
// The paths are the PRE-move ones (src/jira/…) because Task 3 has not run yet —
// Task 3's sweep rewrites them to ./jira/… along with everything else.
import type { JiraDetail as TaskDetail } from "../jira/client";
import type { FieldPrompt } from "../jira/transitionFields";
import type { AuthProbe, ProjectProbe } from "../engine/doctor";

export type { FieldPrompt, Task, TaskDetail };

/** Where a task can move to next, and what that move demands. `fields` is already
 * normalized to the generic prompt vocabulary — no source metadata escapes. */
export interface StatusTarget {
  id: string;
  toName: string;
  toCategory: "new" | "indeterminate" | "done" | "";
  /** The source's own name for the move, when it differs from the destination
   * (Jira transitions are named separately from their target status). */
  via?: string;
  fields: FieldPrompt[];
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
  assignToMe(key: string): Promise<void>;
  me(): Promise<{ id: string; displayName: string } | null>;
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
  /** Collect this connector's own settings. `from`/`total` keep the wizard's
   * "(2/4)" numbering honest across connectors with different step counts. */
  configure(from: number, total: number): Promise<boolean>;
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
 * there is nothing left to try. */
export class TaskWriteError extends Error {
  constructor(message: string, readonly retryWith: FieldPrompt[] = []) {
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
