// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { TypeIcon } from "../../src/webview/icons";
import type { TicketKind } from "../../src/webview/helpers";

const KINDS: TicketKind[] = ["story", "epic", "task", "subtask", "bug", "other"];

describe("TypeIcon", () => {
  // The glyph is the only carrier of the type on a card, so it needs an accessible
  // name — an icon with none is invisible to a screen reader.
  it("names itself with the source's own type name", () => {
    render(<TypeIcon kind="bug" label="Bug" />);
    const icon = screen.getByRole("img", { name: "Type: Bug" });
    expect(icon).toHaveClass("ty", "ty-bug");
    expect(icon).toHaveAttribute("title", "Type: Bug");
  });

  it("shows the raw name even when the kind fell to other", () => {
    render(<TypeIcon kind="other" label="Spike" />);
    const icon = screen.getByRole("img", { name: "Type: Spike" });
    expect(icon).toHaveClass("ty-other");
  });

  it("renders a 12px glyph for every kind", () => {
    for (const kind of KINDS) {
      const { container, unmount } = render(<TypeIcon kind={kind} label={kind} />);
      const svg = container.querySelector("svg")!;
      expect(svg, kind).not.toBeNull();
      expect(svg.getAttribute("width"), kind).toBe("12");
      expect(svg.getAttribute("viewBox"), kind).toBe("0 0 12 12");
      unmount();
    }
  });

  // Six kinds with the same drawing would render as one undifferentiated dot.
  it("draws a different glyph for each kind", () => {
    const drawings = KINDS.map((kind) => {
      const { container, unmount } = render(<TypeIcon kind={kind} label={kind} />);
      const markup = container.querySelector("svg")!.innerHTML;
      unmount();
      return markup;
    });
    expect(new Set(drawings).size).toBe(KINDS.length);
  });
});
