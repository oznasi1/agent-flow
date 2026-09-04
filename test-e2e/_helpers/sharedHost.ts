import { test, type ElectronApplication, type Page } from "@playwright/test";
import { makeSandbox, type Sandbox } from "./sandbox";
import { launchHost } from "./host";

/** How long `afterAll` waits for a graceful `app.close()` before killing the
 *  Electron process. Well under Playwright's own 120s hook timeout, so a hung
 *  close is reported as this helper's problem rather than the file's. */
const CLOSE_DEADLINE_MS = 20_000;

/** What a grouped journey's tests read. Accessors, not values: the host does
 *  not exist yet when `fn` runs (Playwright collects the describe body before
 *  `beforeAll` fires), so a captured value would always be undefined. */
export interface HostCtx {
  page(): Page;
  sb(): Sandbox;
  /** The Electron app, for the one thing `page()` cannot answer: which OTHER
   *  windows exist. A test that opens one must settle it (await its
   *  `.activitybar`) or the shared `app.close()` in `afterAll` hangs. */
  app(): ElectronApplication;
}

/** One Electron boot shared by every `test()` in the block.
 *
 *  Only for surfaces whose actions are LOCAL (the Notepad's globalState, the
 *  Marketplace's reads) or APPEND-ONLY (`writes.jsonl` — each test asserts the
 *  line IT appended, by op and key, never the whole file). Anything that opens
 *  a window, creates a worktree or writes a run record must keep using
 *  `launchHost` per test: those mutate state a sibling test would inherit.
 *
 *  Serial mode is not an optimisation — it is the failure contract. Without it
 *  a failed test leaves a half-mutated host and every sibling reports a
 *  phantom failure; with it, they skip and the report names one real cause. */
export function describeWithHost(
  title: string,
  settings: Record<string, unknown>,
  fn: (ctx: HostCtx) => void,
  /** Runs between `makeSandbox` and `launchHost` — the only window in which a
   *  journey can shape state the webview reads once at init (the fixture
   *  connector's `config.json` caps, a richer `.claude/` seed, forge shims).
   *  A `beforeAll` registered inside `fn` would fire AFTER the host is up. */
  prepare?: (sb: Sandbox) => void,
): void {
  test.describe(title, () => {
    test.describe.configure({ mode: "serial" });

    let sb: Sandbox | undefined;
    let app: ElectronApplication | undefined;
    let page: Page | undefined;

    test.beforeAll(async () => {
      sb = makeSandbox(settings);
      prepare?.(sb);
      const launched = await launchHost(sb);
      app = launched.app;
      page = launched.page;
    });

    test.afterAll(async () => {
      // A crashed or already-dead Electron process can reject the close; if it
      // does, disposal must still run to avoid leaking the sandbox (a real git repo
      // and fixture files in a temp directory that only disposal removes).
      //
      // `close()` can also HANG rather than reject: a window a test opened and
      // never awaited keeps the app alive, and Playwright then fails the whole
      // FILE with `"afterAll" hook timeout` — every test in it already green.
      // That is a teardown artefact reported as a product failure, so the close
      // is raced against a deadline and the process killed outright if it wins.
      // A test that opens a window should still settle it; this only stops one
      // that forgot from turning a passing file red.
      try {
        // Read the pid BEFORE closing: once the app is gone, `process()` throws
        // rather than answering, so asking afterwards turns a clean teardown into
        // a TypeError that fails the file — which is exactly what it is here to
        // prevent.
        const pid = app?.process().pid;
        let closed = false;
        await Promise.race([
          app?.close().then(() => { closed = true; }),
          new Promise<void>((resolve) => setTimeout(resolve, CLOSE_DEADLINE_MS)),
        ]);
        // Still alive after the deadline: SIGKILL the Electron main process. The
        // sandbox disposal below is what actually matters for the next file.
        if (!closed && pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // already exited between the deadline and here — nothing to kill
          }
        }
      } finally {
        app = undefined;
        page = undefined;
        sb?.dispose();
        sb = undefined;
      }
    });

    fn({
      page: () => {
        if (!page) throw new Error("describeWithHost: page read outside a test body");
        return page;
      },
      sb: () => {
        if (!sb) throw new Error("describeWithHost: sandbox read outside a test body");
        return sb;
      },
      app: () => {
        if (!app) throw new Error("describeWithHost: app read outside a test body");
        return app;
      },
    });
  });
}
