// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import * as React from "react";
import { CARD_KIND_LABEL, CardKindIcon } from "../../src/webview/icons";

const KINDS = ["task", "explore", "review", "local", "notepad"] as const;

describe("CardKindIcon", () => {
  it("names the kind in words, not in a class name", () => {
    const { getByRole } = render(<CardKindIcon kind="notepad" />);
    // The glyph is the only thing on the card that says which kind it is, so the
    // accessible name has to say it too.
    expect(getByRole("img").getAttribute("aria-label")).toBe("Notepad note");
    expect(getByRole("img").getAttribute("title")).toBe("Notepad note");
  });

  it("carries a per-kind hue class so one kind never reads as another", () => {
    const seen = new Set<string>();
    for (const kind of KINDS) {
      const { container, unmount } = render(<CardKindIcon kind={kind} />);
      const av = container.querySelector(".av")!;
      expect(av.className).toBe(`av k-${kind}`);
      seen.add(CARD_KIND_LABEL[kind]);
      unmount();
    }
    // Five kinds, five distinct names: a shared label would make two kinds
    // indistinguishable to a screen reader even though their glyphs differ.
    expect(seen.size).toBe(KINDS.length);
  });

  it("draws a distinct glyph for every kind", () => {
    const shapes = new Set<string>();
    for (const kind of KINDS) {
      const { container, unmount } = render(<CardKindIcon kind={kind} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe("14");
      expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
      shapes.add(svg.innerHTML);
      unmount();
    }
    expect(shapes.size).toBe(KINDS.length);
  });

  it("inherits its colour rather than hard-coding one", () => {
    // currentColor is what lets .av.k-<kind> set the hue from CSS, and what keeps
    // the glyph legible in both themes without a second copy of each path.
    const { container } = render(<CardKindIcon kind="task" />);
    expect(container.innerHTML).toContain("currentColor");
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
