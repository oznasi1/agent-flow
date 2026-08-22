import { test, type ElectronApplication, type Page } from "@playwright/test";
import { makeSandbox, type Sandbox } from "./sandbox";
import { launchHost } from "./host";

/** What a grouped journey's tests read. Accessors, not values: the host does
 *  not exist yet when `fn` runs (Playwright collects the describe body before
 *  `beforeAll` fires), so a captured value would always be undefined. */
export interface HostCtx {
  page(): Page;
  sb(): Sandbox;
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
): void {
  test.describe(title, () => {
    test.describe.configure({ mode: "serial" });

    let sb: Sandbox | undefined;
    let app: ElectronApplication | undefined;
    let page: Page | undefined;

    test.beforeAll(async () => {
      sb = makeSandbox(settings);
      const launched = await launchHost(sb);
      app = launched.app;
      page = launched.page;
    });

    test.afterAll(async () => {
      await app?.close();
      app = undefined;
      page = undefined;
      sb?.dispose();
      sb = undefined;
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
    });
  });
}
