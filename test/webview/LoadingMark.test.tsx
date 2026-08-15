// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { LoadingMark } from "../../src/webview/LoadingMark";

describe("LoadingMark", () => {
  it("draws the mark's eight outer dots", () => {
    const { container } = render(<LoadingMark />);
    expect(container.querySelectorAll("circle.ldot")).toHaveLength(8);
  });

  it("keeps the texture dots at sidebar size and up", () => {
    const { container } = render(<LoadingMark size={15} />);
    expect(container.querySelectorAll("circle.tex")).toHaveLength(8);
  });

  it("drops the texture dots below 14px, where they smear into the ring", () => {
    const { container } = render(<LoadingMark size={12} />);
    expect(container.querySelectorAll("circle.tex")).toHaveLength(0);
    expect(container.querySelectorAll("circle.ldot")).toHaveLength(8);
  });

  it("staggers each dot round the ring, so the lit dot travels", () => {
    const { container } = render(<LoadingMark />);
    const delays = [...container.querySelectorAll<SVGCircleElement>("circle.ldot")].map(
      (c) => c.style.animationDelay,
    );
    // Every dot on its own offset — dots sharing one delay would blink together
    // as a pulse instead of running round the ring.
    expect(new Set(delays).size).toBe(8);
    expect(delays.every((d) => d !== "")).toBe(true);
  });

  it("runs the lit dot clockwise, the way every spinner it replaces turned", () => {
    const { container } = render(<LoadingMark />);
    const ms = [...container.querySelectorAll<SVGCircleElement>("circle.ldot")].map((c) =>
      Math.abs(parseInt(c.style.animationDelay, 10)),
    );
    // Dots are in clockwise ring order from twelve o'clock, and a dot is bright as
    // its cycle wraps. Later wraps need SHORTER negative offsets, so walking the ring
    // clockwise must walk the offsets down. Reversing this spins it anticlockwise.
    for (let i = 1; i < ms.length; i++) expect(ms[i]).toBeLessThan(ms[i - 1]);
  });

  it("names itself for screen readers when it stands alone", () => {
    render(<LoadingMark label="Loading tickets" />);
    expect(screen.getByRole("img", { name: "Loading tickets" })).toBeInTheDocument();
  });

  it("hides itself when adjacent text already says what is happening", () => {
    const { container } = render(<LoadingMark />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders at the size asked for", () => {
    const { container } = render(<LoadingMark size={28} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "28");
    expect(svg).toHaveAttribute("height", "28");
  });
});
