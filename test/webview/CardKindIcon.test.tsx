// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import * as React from "react";
import { CARD_KIND_LABEL, CardKindIcon } from "../../src/webview/icons";
import { DECK_CSS } from "../../src/webview/deckStyles";

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

const PROVIDERS = ["claude-code", "copilot", "cursor", "codex"] as const;

describe("CardKindIcon provider badge", () => {
  it("shows no badge when no provider is known", () => {
    // Every run record written before the provider was recorded, with nothing running:
    // the tile must look exactly as it did before this feature existed.
    const { container } = render(<CardKindIcon kind="task" />);
    expect(container.querySelector(".pv")).toBeNull();
    expect(container.querySelector(".av")!.className).toBe("av k-task");
  });

  it("names the tool in words on the badge", () => {
    const { container } = render(<CardKindIcon kind="task" provider="copilot" />);
    expect(container.querySelector(".pv")!.getAttribute("title")).toBe("GitHub Copilot");
  });

  it("names both facts in the tile's accessible name", () => {
    // The mark is the only thing that says which tool this is, so the accessible name
    // has to say it too — and it must not lose the kind while gaining the tool.
    const { getByRole } = render(<CardKindIcon kind="notepad" provider="cursor" />);
    expect(getByRole("img").getAttribute("aria-label")).toBe("Notepad note · Cursor");
  });

  it("draws a distinct mark per provider", () => {
    const shapes = new Set<string>();
    for (const provider of PROVIDERS) {
      const { container, unmount } = render(<CardKindIcon kind="task" provider={provider} />);
      const badge = container.querySelector(".pv")!;
      expect(badge.className).toBe(`pv p-${provider}`);
      const svg = badge.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe("11");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      shapes.add(svg.innerHTML);
      unmount();
    }
    expect(shapes.size).toBe(PROVIDERS.length);
  });

  it("gives only Claude a brand hue; Copilot and Cursor stay theme ink", () => {
    // Copilot and Cursor are black-on-white marks that must read in the theme's own
    // ink, like every other neutral glyph on the card; only Claude's mark carries a
    // brand colour. That distinction lives in deckStyles.ts, not in the component
    // rendered above — a component test can't see it, since jsdom does not compute
    // color-mix() from a real stylesheet, so this checks the CSS text directly.
    const claudeRule = DECK_CSS.match(/\.pv\.p-claude-code\s*\{[^}]*\}/);
    expect(claudeRule).not.toBeNull();
    expect(claudeRule![0]).toContain("var(--p-claude)");
    expect(DECK_CSS).not.toMatch(/\.pv\.p-copilot\s*\{[^}]*color\s*:/);
    expect(DECK_CSS).not.toMatch(/\.pv\.p-cursor\s*\{[^}]*color\s*:/);
  });
});
