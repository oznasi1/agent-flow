// Hand-written mock of the `vscode` module. The real `vscode` is injected by the
// extension host at runtime and is not an installable npm package, so vitest
// aliases every `import ... from "vscode"` to this file (see vitest.config.ts).
//
// Source code type-checks against the real @types/vscode (tsc doesn't apply the
// alias); only the *runtime* values come from here. Tests should import THIS file
// via its relative path to get the `vi.Mock`-typed handles for configuration:
//   import * as vscode from "../_mocks/vscode";
//   vscode.window.showQuickPick.mockResolvedValueOnce(...);
import { vi } from "vitest";

// ── configuration store (backs workspace.getConfiguration) ──────────────────
let configStore: Record<string, unknown> = {};
export function setConfig(values: Record<string, unknown>): void {
  configStore = { ...configStore, ...values };
}

function makeConfig() {
  return {
    get: vi.fn((key: string, def?: unknown) => (key in configStore ? configStore[key] : def)),
    update: vi.fn(async (key: string, value: unknown, _target?: unknown): Promise<void> => {
      configStore[key] = value;
    }),
    inspect: vi.fn((key: string) =>
      key in configStore ? { key, globalValue: configStore[key] } : { key },
    ),
  };
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

// ── namespaces ──────────────────────────────────────────────────────────────

/** A fake WebviewPanel that captures the callbacks its owner registers so tests
 * can drive them: `_fire(msg)` delivers a webview→host message, `_fireDispose()`
 * simulates the user closing the panel, `_fireViewState()` a visibility change. */
export function makeWebviewPanel() {
  let onMsg: ((m: any) => any) | undefined;
  let onDispose: (() => any) | undefined;
  let onViewState: (() => any) | undefined;
  const webview = {
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: vi.fn((u: unknown) => u),
    onDidReceiveMessage: vi.fn((cb: (m: any) => any) => {
      onMsg = cb;
      return { dispose: vi.fn() };
    }),
    postMessage: vi.fn(async (_m: unknown) => true),
  };
  return {
    webview,
    visible: true,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn((cb: () => any) => {
      onDispose = cb;
      return { dispose: vi.fn() };
    }),
    onDidChangeViewState: vi.fn((cb: () => any) => {
      onViewState = cb;
      return { dispose: vi.fn() };
    }),
    _fire: (m: unknown) => onMsg?.(m),
    _fireDispose: () => onDispose?.(),
    _fireViewState: () => onViewState?.(),
  };
}

export const window = {
  showInputBox: vi.fn(async (_opts?: unknown): Promise<string | undefined> => undefined),
  showQuickPick: vi.fn(async (_items?: unknown, _opts?: unknown): Promise<any> => undefined),
  withProgress: vi.fn(async (_opts: unknown, task: (...a: any[]) => any) => task()),
  showInformationMessage: vi.fn(async (..._a: unknown[]): Promise<string | undefined> => undefined),
  showWarningMessage: vi.fn(async (..._a: unknown[]): Promise<string | undefined> => undefined),
  createOutputChannel: vi.fn((_name: string) => ({ appendLine: vi.fn(), dispose: vi.fn() })),
  registerWebviewViewProvider: vi.fn((_id: string, _provider: unknown) => ({ dispose: vi.fn() })),
  createWebviewPanel: vi.fn((_id: string, _title: string, _col: unknown, _opts?: unknown) => makeWebviewPanel()),
  showTextDocument: vi.fn(async (_doc: unknown, _opts?: unknown): Promise<any> => undefined),
  showOpenDialog: vi.fn(async (_opts?: unknown): Promise<any[] | undefined> => undefined),
  onDidChangeWindowState: vi.fn((_cb: (e: unknown) => void) => ({ dispose: vi.fn() })),
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;

export const commands = {
  executeCommand: vi.fn(async (..._a: unknown[]): Promise<any> => undefined),
  getCommands: vi.fn(async (_filter?: boolean): Promise<string[]> => []),
  registerCommand: vi.fn((_id: string, _cb: (...a: any[]) => any) => ({ dispose: vi.fn() })),
};

export const env = {
  appName: "Cursor",
  uriScheme: "cursor",
  openExternal: vi.fn(async (_uri: unknown): Promise<boolean> => true),
  clipboard: { writeText: vi.fn(async (_t: string): Promise<void> => undefined) },
};

// `workspace.workspaceFile` / `.workspaceFolders` are plain (mutable) fields the
// tests set per-case; `getConfiguration` returns a store-backed stub.
export const workspace = {
  workspaceFile: undefined as { scheme: string; fsPath: string } | undefined,
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  getConfiguration: vi.fn((_section?: string) => makeConfig()),
  openTextDocument: vi.fn(async (_opts?: unknown): Promise<any> => ({})),
};

export const Uri = {
  parse: vi.fn((s: string) => ({ toString: () => s, scheme: s.split(":")[0], fsPath: s })),
  file: vi.fn((p: string) => ({ toString: () => p, scheme: "file", fsPath: p })),
  joinPath: vi.fn((base: any, ...segs: string[]) => {
    const joined = [base?.fsPath ?? String(base ?? ""), ...segs].join("/");
    return { toString: () => joined, scheme: "file", fsPath: joined };
  }),
};

/** Reset every mock's call history + implementations and all mutable state back
 * to defaults. Wired into a global beforeEach in test/_setup.ts. */
export function resetVscodeMocks(): void {
  configStore = {};

  window.showInputBox.mockReset().mockResolvedValue(undefined);
  window.showQuickPick.mockReset().mockResolvedValue(undefined);
  window.withProgress.mockReset().mockImplementation(async (_opts: unknown, task: (...a: any[]) => any) => task());
  window.showInformationMessage.mockReset().mockResolvedValue(undefined);
  window.showWarningMessage.mockReset().mockResolvedValue(undefined);
  window.createOutputChannel.mockReset().mockImplementation((_name: string) => ({ appendLine: vi.fn(), dispose: vi.fn() }));
  window.registerWebviewViewProvider.mockReset().mockImplementation(() => ({ dispose: vi.fn() }));
  window.createWebviewPanel.mockReset().mockImplementation(() => makeWebviewPanel());
  window.showTextDocument.mockReset().mockResolvedValue(undefined);
  window.showOpenDialog.mockReset().mockResolvedValue(undefined);
  window.onDidChangeWindowState.mockReset().mockImplementation(() => ({ dispose: vi.fn() }));

  commands.executeCommand.mockReset().mockResolvedValue(undefined);
  commands.getCommands.mockReset().mockResolvedValue([]);
  commands.registerCommand.mockReset().mockImplementation(() => ({ dispose: vi.fn() }));

  env.appName = "Cursor";
  env.uriScheme = "cursor";
  env.openExternal.mockReset().mockResolvedValue(true);
  env.clipboard.writeText.mockReset().mockResolvedValue(undefined);

  workspace.workspaceFile = undefined;
  workspace.workspaceFolders = undefined;
  workspace.getConfiguration.mockReset().mockImplementation((_section?: string) => makeConfig());
  workspace.openTextDocument.mockReset().mockResolvedValue({});

  Uri.parse.mockClear();
  Uri.file.mockClear();
  Uri.joinPath.mockClear();
}
