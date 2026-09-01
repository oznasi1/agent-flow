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
    it("writes only its own key", () => {
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

    // `persist` replaces the whole persisted object with one containing only
    // its own key — the exact behaviour the Orchestrator drawer had before
    // this module existed (see drawerResize.ts's own comment on `persist`).
    // A second drawer built on this same factory therefore clobbers whatever
    // the first drawer had stored, rather than sitting beside it: this test
    // pins that consequence down rather than hiding it, so a later task that
    // wires up a second drawer's key sees the gap instead of discovering it
    // by losing a user's saved width.
    it("replaces rather than merges, so a second key's persist clobbers a first key already stored", () => {
      const a = createDrawerResize({ min: 420, def: 560, key: "aWidth" });
      const b = createDrawerResize({ min: 420, def: 560, key: "bWidth" });

      a.persist(500);
      expect(vscodeApi.setState).toHaveBeenLastCalledWith({ aWidth: 500 });

      // Simulate the host now holding what `a` just wrote.
      vi.mocked(vscodeApi.getState).mockReturnValue({ aWidth: 500 } as never);

      b.persist(700);
      // `b` overwrites the whole object with just its own key — `aWidth` is
      // gone, not merged forward.
      expect(vscodeApi.setState).toHaveBeenLastCalledWith({ bWidth: 700 });
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
