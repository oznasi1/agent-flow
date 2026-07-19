import { vi } from "vitest";
import type * as vscode from "vscode";
import type { JiraTask, ServiceRef } from "../../src/types";
import type { JiraAuth } from "../../src/jira/auth";

// ── domain factories ────────────────────────────────────────────────────────

/** A JiraTask with sensible defaults; override any field. */
export function mkTask(overrides: Partial<JiraTask> = {}): JiraTask {
  const key = overrides.key ?? "ASM-1";
  return {
    key,
    summary: key,
    status: "",
    statusCategory: "new",
    priority: "",
    assignee: "Unassigned",
    labels: [],
    components: [],
    sprint: null,
    inOpenSprint: false,
    updated: "",
    url: "",
    estimateSeconds: null,
    ...overrides,
  };
}

/** ServiceRefs for a set of repo names (all git by default). */
export function mkRepos(names: string[], opts: { isGit?: boolean; root?: string } = {}): ServiceRef[] {
  const root = opts.root ?? "/repos";
  return names.map((name) => ({ name, path: `${root}/${name}`, isGit: opts.isGit ?? true }));
}

// ── JiraAuth fake ───────────────────────────────────────────────────────────

/** A JiraAuth whose four methods are vi.fns. Configure per-test with
 *  `vi.mocked(auth.isAuthenticated).mockResolvedValue(false)`, etc. */
export function fakeAuth(opts: { authed?: boolean; header?: string } = {}): JiraAuth {
  const authed = opts.authed ?? true;
  const header = opts.header ?? "Basic dGVzdA==";
  return {
    getAuthHeader: vi.fn(async () => (authed ? header : undefined)),
    isAuthenticated: vi.fn(async () => authed),
    signIn: vi.fn(async () => true),
    signOut: vi.fn(async () => undefined),
  };
}

// ── in-memory VS Code state ─────────────────────────────────────────────────

export type FakeMemento = {
  keys: () => string[];
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  setKeysForSync: ReturnType<typeof vi.fn>;
  store: Map<string, unknown>;
};

export function memento(initial: Record<string, unknown> = {}): FakeMemento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    keys: () => [...store.keys()],
    get: vi.fn((key: string, def?: unknown) => (store.has(key) ? store.get(key) : def)),
    update: vi.fn(async (key: string, val: unknown) => {
      if (val === undefined) store.delete(key);
      else store.set(key, val);
    }),
    setKeysForSync: vi.fn(),
  };
}

export type FakeSecrets = {
  get: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  onDidChange: ReturnType<typeof vi.fn>;
  __store: Map<string, string>;
};

export function fakeSecrets(initial: Record<string, string> = {}): FakeSecrets {
  const __store = new Map<string, string>(Object.entries(initial));
  return {
    __store,
    get: vi.fn(async (key: string) => __store.get(key)),
    store: vi.fn(async (key: string, val: string) => {
      __store.set(key, val);
    }),
    delete: vi.fn(async (key: string) => {
      __store.delete(key);
    }),
    onDidChange: vi.fn(),
  };
}

/** A minimal ExtensionContext plus the mockable stores exposed separately so
 *  tests can both pass `context` to a constructor and assert on the stores. */
export function fakeContext(init: {
  workspaceState?: Record<string, unknown>;
  globalState?: Record<string, unknown>;
  secrets?: Record<string, string>;
} = {}) {
  const workspaceState = memento(init.workspaceState);
  const globalState = memento(init.globalState);
  const secrets = fakeSecrets(init.secrets);
  const extensionUri = { fsPath: "/ext", scheme: "file", toString: () => "/ext" };
  const context = {
    subscriptions: [] as { dispose(): void }[],
    workspaceState,
    globalState,
    secrets,
    extensionUri,
  } as unknown as vscode.ExtensionContext;
  return { context, workspaceState, globalState, secrets, extensionUri };
}

// ── fetch mocking (for JiraClient) ──────────────────────────────────────────

export interface FakeResponse {
  status: number;
  ok: boolean;
  text: () => Promise<string>;
}

export function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(body) };
}

export function textResponse(text: string, status = 200): FakeResponse {
  return { status, ok: status >= 200 && status < 300, text: async () => text };
}

/** 204/empty-body response (Jira transitions & edits return no content). */
export function emptyResponse(status = 204): FakeResponse {
  return { status, ok: status >= 200 && status < 300, text: async () => "" };
}

/** Install a scripted global.fetch that returns the given responses in order.
 *  Any call beyond the sequence rejects, surfacing unexpected requests. */
export function installFetch(responses: FakeResponse[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  fetchMock.mockRejectedValue(new Error("fetch called more times than the mocked sequence provides"));
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}
