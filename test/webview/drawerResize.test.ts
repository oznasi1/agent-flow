// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDrawerResize, RESIZE_STEP } from "../../src/webview/drawerResize";

// Same pattern OrchestratorDrawer.test.tsx uses: a plain vi.fn() pair standing
// in for the real acquireVsCodeApi(), which does not exist under jsdom.
vi.mock("../../src/webview/vscodeApi", () => ({
  vscodeApi: { getState: vi.fn(() => undefined), setState: vi.fn() },
}));

import { vscodeApi } from "../../src/webview/vscodeApi";

describe("createDrawerResize", () => {
  beforeEach(() => {
    vi.mocked(vscodeApi.getState).mockReset().mockReturnValue(undefined);
    vi.mocked(vscodeApi.setState).mockReset();
  });

  describe("clamp", () => {
    it("floors a width below the configured minimum", () => {
      const r = createDrawerResize({ min: 420, def: 560, key: "w" });
      expect(r.clamp(10)).toBe(420);
    });

    it("ceils a width above the viewport-derived ceiling", () => {
      const prev = window.innerWidth;
      // ceiling = max(min, innerWidth - BOARD_MARGIN); with a 1000px viewport
      // and min 420, the ceiling sits below 1000 so an oversized request is
      // actually clamped rather than passing through unchanged.
      Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
      try {
        const r = createDrawerResize({ min: 420, def: 560, key: "w" });
        const ceiling = r.ceiling();
        expect(ceiling).toBeLessThan(1000);
        expect(r.clamp(5000)).toBe(ceiling);
      } finally {
        Object.defineProperty(window, "innerWidth", { value: prev, configurable: true });
      }
    });

    it("falls back to the minimum as the ceiling when the viewport itself is narrower than the minimum", () => {
      const prev = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { value: 100, configurable: true });
      try {
        const r = createDrawerResize({ min: 420, def: 560, key: "w" });
        expect(r.ceiling()).toBe(420);
        expect(r.clamp(5000)).toBe(420);
      } finally {
        Object.defineProperty(window, "innerWidth", { value: prev, configurable: true });
      }
    });
  });

  describe("the arrow-key step", () => {
    it("is a fixed 16px increment shared by every drawer built on this module", () => {
      expect(RESIZE_STEP).toBe(16);
    });

    it("moves a width by exactly one step before clamping applies", () => {
      const r = createDrawerResize({ min: 420, def: 560, key: "w" });
      expect(r.clamp(560 + RESIZE_STEP)).toBe(576);
      expect(r.clamp(560 - RESIZE_STEP)).toBe(544);
    });
  });

  describe("read", () => {
    it("returns null when nothing has been persisted", () => {
      vi.mocked(vscodeApi.getState).mockReturnValue(undefined);
      const r = createDrawerResize({ min: 420, def: 560, key: "w" });
      expect(r.read()).toBeNull();
    });

    it("returns null for a garbage stored value instead of throwing or handing it back", () => {
      vi.mocked(vscodeApi.getState).mockReturnValue({ w: "not-a-number" } as never);
      const r = createDrawerResize({ min: 420, def: 560, key: "w" });
      expect(r.read()).toBeNull();
    });

    it("returns null when getState itself throws", () => {
      vi.mocked(vscodeApi.getState).mockImplementation(() => {
        throw new Error("state store unavailable");
      });
      const r = createDrawerResize({ min: 420, def: 560, key: "w" });
      expect(r.read()).toBeNull();
    });

    it("reads only its own key, ignoring a value stored under a different drawer's key", () => {
      vi.mocked(vscodeApi.getState).mockReturnValue({ otherWidth: 900 } as never);
      const mine = createDrawerResize({ min: 420, def: 560, key: "myWidth" });
      expect(mine.read()).toBeNull();
    });

    it("reads its own value back when it is the one present", () => {
      vi.mocked(vscodeApi.getState).mockReturnValue({ myWidth: 640 } as never);
      const mine = createDrawerResize({ min: 420, def: 560, key: "myWidth" });
      expect(mine.read()).toBe(640);
    });
  });

  describe("persist", () => {
    // A stateful stand-in for the real webview state store: `vscodeApi.getState`/
    // `setState` are otherwise just recorded calls, which cannot answer "does a
    // later read see what an earlier persist wrote" — the very question a merge
    // vs. replace `persist` differ on. Local to each test that needs it, not the
    // shared `beforeEach` mock, since most tests here don't need real storage.
    function fakeStore(initial: unknown = undefined): void {
      let state = initial;
      vi.mocked(vscodeApi.getState).mockImplementation(() => state as never);
      vi.mocked(vscodeApi.setState).mockImplementation((s: unknown) => {
        state = s;
      });
    }

    it("persists under its own key when nothing else has been stored", () => {
      const r = createDrawerResize({ min: 420, def: 560, key: "myWidth" });
      r.persist(700);
      expect(vscodeApi.setState).toHaveBeenCalledWith({ myWidth: 700 });
    });

    it("does not throw when setState itself throws", () => {
      vi.mocked(vscodeApi.setState).mockImplementation(() => {
        throw new Error("state store unavailable");
      });
      const r = createDrawerResize({ min: 420, def: 560, key: "myWidth" });
      expect(() => r.persist(700)).not.toThrow();
    });

    it("does not throw when reading the existing state to merge into throws", () => {
      vi.mocked(vscodeApi.getState).mockImplementation(() => {
        throw new Error("state store unavailable");
      });
      const r = createDrawerResize({ min: 420, def: 560, key: "myWidth" });
      // Whole persist is one try/catch (see drawerResize.ts): a broken read
      // aborts the write too rather than risk merging into a base it never
      // actually saw, but it must not throw out of a keypress or a pointer
      // release over it either.
      expect(() => r.persist(700)).not.toThrow();
      expect(vscodeApi.setState).not.toHaveBeenCalled();
    });

    // The real regression guard this refactor exists for: `persist` merges
    // into whatever is already stored rather than replacing it wholesale, so
    // two drawers sharing this module's `persist` can each resize without
    // wiping the other's width. A version that wrote `{ [key]: w }` outright
    // (this module's very first draft did exactly that, matching the
    // Orchestrator drawer's pre-extraction behaviour) would fail this pair.
    it("persisting width A under one key and width B under another: both survive a read back", () => {
      fakeStore();
      const a = createDrawerResize({ min: 420, def: 560, key: "aWidth" });
      const b = createDrawerResize({ min: 420, def: 560, key: "bWidth" });

      a.persist(500);
      b.persist(700);

      expect(a.read()).toBe(500);
      expect(b.read()).toBe(700);
    });

    it("persisting over a pre-existing state object preserves a key neither drawer owns", () => {
      // The webview's persisted state may already hold something that belongs
      // to neither drawer — this module must not assume it owns the whole
      // object just because it's the one calling setState.
      fakeStore({ someOtherFeature: "value" });
      const a = createDrawerResize({ min: 420, def: 560, key: "aWidth" });

      a.persist(500);

      expect(vscodeApi.getState()).toEqual({ someOtherFeature: "value", aWidth: 500 });
    });
  });

  describe("full", () => {
    it("is the raw viewport width, not the reserved-for-a-board-column ceiling", () => {
      const prev = window.innerWidth;
      Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
      try {
        const r = createDrawerResize({ min: 420, def: 560, key: "w" });
        expect(r.full()).toBe(1200);
        expect(r.full()).toBeGreaterThan(r.ceiling());
      } finally {
        Object.defineProperty(window, "innerWidth", { value: prev, configurable: true });
      }
    });
  });
});
