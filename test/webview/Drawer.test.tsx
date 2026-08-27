// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, act } from "@testing-library/react";

import { Drawer, useDrawerExit } from "../../src/webview/Drawer";
import { DECK_CSS, DRAWER_ANIM_MS } from "../../src/webview/deckStyles";
import { ORCH_ANIM_MS, ORCH_CSS } from "../../src/webview/orchestratorStyles";

/** Every flat `selector { declarations }` block in a sheet, keyframe bodies and
 * comments dropped — the same shape tokens.test.ts parses these sheets with. */
const ruleBlocks = (sheet: string): { selector: string; body: string }[] =>
  [
    ...sheet
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^.*@keyframes.*$/gm, "")
      .matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map((m) => ({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] }));

const bodyOf = (sheet: string, selector: string): string => {
  const rule = ruleBlocks(sheet).find((r) => r.selector === selector);
  expect(rule, `no rule for "${selector}"`).toBeDefined();
  return rule!.body;
};

describe("the drawer shell", () => {
  const aside = () => document.querySelector("aside") as HTMLElement;

  it("composes the surface class onto the shared one", () => {
    render(<Drawer surface="dd" label="Detail" closing={false}>body</Drawer>);
    // Both, in that order, and nothing else: `.drawer` carries the geometry and
    // the slide, `.dd` only what differs. A surface class that replaced the
    // shared one instead of joining it would take the drawer out of its slot.
    expect(aside().className).toBe("drawer dd");
  });

  it("marks the closing state without dropping its identity", () => {
    render(<Drawer surface="orch" label="Orchestrator" closing>body</Drawer>);
    // `.orch` survives the exit, so nothing scoped to this surface restyles
    // halfway through the slide, and `.closing` is what the animation keys on.
    expect(aside().className).toBe("drawer orch closing");
  });

  it("names the landmark, and hides it only while closing", () => {
    const { rerender } = render(<Drawer surface="dd" label="Detail for PROJ-1" closing={false}>b</Drawer>);
    expect(aside().getAttribute("aria-label")).toBe("Detail for PROJ-1");
    // Absent, not "false" — see the attribute's own comment in Drawer.tsx.
    expect(aside().hasAttribute("aria-hidden")).toBe(false);
    rerender(<Drawer surface="dd" label="Detail for PROJ-1" closing>b</Drawer>);
    expect(aside().getAttribute("aria-hidden")).toBe("true");
  });

  // The Orchestrator's live width rides an inline custom property, so a shell
  // that swallowed `style` would pin that drawer at its stylesheet default and
  // silently break the resize grip.
  it("passes an inline style through to the element", () => {
    render(<Drawer surface="orch" label="O" closing={false} style={{ ["--orch-w" as never]: "700px" }}>b</Drawer>);
    expect(aside().style.getPropertyValue("--orch-w")).toBe("700px");
  });
});

describe("useDrawerExit", () => {
  /** A host for the hook: `key` is what the user is pointing at, `item` is what
   * that resolves to on the board — the two signals the hook exists to tell
   * apart. Renders what it is given so the frozen frame is observable. */
  function Host({ openKey, item }: { openKey: string | null; item: string | null }): JSX.Element {
    const { shown, closing } = useDrawerExit(openKey, item);
    return <div data-testid="out" data-closing={closing}>{shown ?? "gone"}</div>;
  }
  const out = () => document.querySelector("[data-testid=out]") as HTMLElement;
  const shown = () => out().textContent;
  const closing = () => out().getAttribute("data-closing") === "true";

  it("holds the last item for exactly the length of the slide", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Host openKey="a" item="A" />);
      expect(shown()).toBe("A");
      expect(closing()).toBe(false);

      rerender(<Host openKey={null} item={null} />);
      expect(shown()).toBe("A");
      expect(closing()).toBe(true);

      act(() => { vi.advanceTimersByTime(DRAWER_ANIM_MS - 1); });
      expect(shown()).toBe("A");
      act(() => { vi.advanceTimersByTime(1); });
      expect(shown()).toBe("gone");
      expect(closing()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The item changes identity on every host post while a drawer sits open, and
  // the slide-out should paint the last of those, not the one it opened on.
  it("freezes the item as it last was, not as it was when it opened", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Host openKey="a" item="A" />);
      rerender(<Host openKey="a" item="A-renamed" />);
      rerender(<Host openKey={null} item={null} />);
      expect(shown()).toBe("A-renamed");
    } finally {
      vi.useRealTimers();
    }
  });

  // The whole reason the hook takes two arguments. The key still names a record
  // the board no longer has, so there is no dismissal to animate — and nothing
  // may come back when the caller then drops the stale key.
  it("leaves nothing to slide out when the item vanishes under a live key", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Host openKey="a" item="A" />);
      rerender(<Host openKey="a" item={null} />);
      expect(shown()).toBe("gone");
      expect(closing()).toBe(false);

      rerender(<Host openKey={null} item={null} />);
      expect(shown()).toBe("gone");
      act(() => { vi.advanceTimersByTime(DRAWER_ANIM_MS * 2); });
      expect(shown()).toBe("gone");
    } finally {
      vi.useRealTimers();
    }
  });

  // Reopening mid-slide is a real gesture — click a second card while the first
  // drawer is still leaving. The live item wins immediately, and the pending
  // timer must not then blank it.
  it("hands the drawer straight back when a new item opens mid-slide", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Host openKey="a" item="A" />);
      rerender(<Host openKey={null} item={null} />);
      expect(closing()).toBe(true);
      rerender(<Host openKey="b" item="B" />);
      expect(shown()).toBe("B");
      expect(closing()).toBe(false);
      act(() => { vi.advanceTimersByTime(DRAWER_ANIM_MS * 2); });
      expect(shown()).toBe("B");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops its timer when the drawer's owner unmounts", () => {
    vi.useFakeTimers();
    try {
      const { rerender, unmount } = render(<Host openKey="a" item="A" />);
      rerender(<Host openKey={null} item={null} />);
      expect(vi.getTimerCount()).toBe(1);
      unmount();
      // Asserted BEFORE advancing, and that ordering is the whole test: a timer
      // that is merely allowed to fire into an unmounted tree also leaves a
      // count of zero afterwards, so checking it later would pass with no
      // cleanup at all. React swallows the resulting `setExiting` warning, so
      // the pending timer is the only observable.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The regression this refactor exists to prevent: two drawers on one surface
// drifting apart because each declared its own geometry. The shell is one rule
// in one sheet; a surface class carrying any of it again fails here.
describe("the two drawers share one shell", () => {
  const SHELL = ["position", "top", "right", "bottom", "z-index", "background", "border-left", "box-shadow", "animation"];

  it("declares the shell once, on .drawer", () => {
    const shell = bodyOf(DECK_CSS, ".drawer");
    for (const prop of SHELL) expect(shell).toContain(`${prop}:`);
    expect(shell).toContain(`animation: drawer-in ${DRAWER_ANIM_MS}ms`);
  });

  it.each([
    [".dd", () => DECK_CSS],
    [".orch", () => ORCH_CSS],
  ])("leaves %s carrying nothing the shell already states", (selector, sheet) => {
    const body = bodyOf(sheet(), selector);
    expect(SHELL.filter((prop) => body.includes(`${prop}:`))).toEqual([]);
    // What each one IS allowed to differ on.
    expect(body).toContain("width:");
  });

  // Two slide lengths on one surface was half the drift. The Orchestrator's
  // sheet keeps the name its own tests speak in; it must not keep a number.
  it("runs both drawers off one duration", () => {
    expect(ORCH_ANIM_MS).toBe(DRAWER_ANIM_MS);
    expect(ORCH_CSS).not.toContain("@keyframes orch-in");
    expect(ORCH_CSS).not.toContain("@keyframes orch-out");
  });
});
