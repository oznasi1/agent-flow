// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import * as React from "react";
import { render, screen } from "@testing-library/react";
import { GaugeMark } from "../../src/webview/GaugeMark";

const lit = (c: HTMLElement) => c.querySelectorAll("circle.lit").length;

describe("GaugeMark", () => {
  it("lights one outer dot per live window", () => {
    const { container } = render(<GaugeMark live={3} />);
    expect(lit(container)).toBe(3);
  });

  it("lights nothing when nothing is in flight", () => {
    const { container } = render(<GaugeMark live={0} />);
    expect(lit(container)).toBe(0);
  });

  it("clamps at the eight outer dots", () => {
    const { container } = render(<GaugeMark live={19} />);
    expect(lit(container)).toBe(8);
  });

  it("names the count for screen readers, singular and plural", () => {
    render(<GaugeMark live={1} />);
    expect(screen.getByRole("img", { name: "1 Agent Flow Deck window open" })).toBeInTheDocument();
    render(<GaugeMark live={4} />);
    expect(screen.getByRole("img", { name: "4 Agent Flow Deck windows open" })).toBeInTheDocument();
  });

  it("falls back to the static six-lit lockup and hides itself when there is no count", () => {
    const { container } = render(<GaugeMark />);
    expect(lit(container)).toBe(6);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("always draws the eight texture dots", () => {
    const { container } = render(<GaugeMark live={2} />);
    expect(container.querySelectorAll("circle.tex").length).toBe(8);
  });
});
