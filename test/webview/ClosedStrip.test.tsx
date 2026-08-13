// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClosedRow, ClosedStrip } from "../../src/webview/ClosedStrip";

const NOW = Date.now();
const row = (over: Partial<ClosedRow> = {}): ClosedRow => ({
  key: "notepad-a", title: "Add drag and drop to the notepad", label: "notepad",
  closedAt: NOW - 2 * 3_600_000, ...over,
});

const props = (over: Partial<React.ComponentProps<typeof ClosedStrip>> = {}) => ({
  rows: [row()], collapsed: true, onCollapse: vi.fn(),
  onReopen: vi.fn(), onForget: vi.fn(), onClearAll: vi.fn(), ...over,
});

describe("ClosedStrip", () => {
  it("renders nothing when nothing has closed", () => {
    const { container } = render(<ClosedStrip {...props({ rows: [] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("heads the strip with the count when collapsed", () => {
    render(<ClosedStrip {...props({ rows: [row(), row({ key: "b" })] })} />);
    expect(screen.getByText("Recently closed")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("hides the rows when collapsed", () => {
    render(<ClosedStrip {...props()} />);
    expect(screen.queryByText(/Add drag and drop/)).not.toBeInTheDocument();
  });

  it("shows a row per closed run when expanded", () => {
    render(<ClosedStrip {...props({ collapsed: false })} />);
    expect(screen.getByText("Add drag and drop to the notepad")).toBeInTheDocument();
    expect(screen.getByText("notepad")).toBeInTheDocument();
    expect(screen.getByText(/closed 2h ago/)).toBeInTheDocument();
  });

  it("asks to toggle rather than toggling itself — the parent owns the state", () => {
    const onCollapse = vi.fn();
    render(<ClosedStrip {...props({ onCollapse })} />);
    fireEvent.click(screen.getByText("Recently closed"));
    expect(onCollapse).toHaveBeenCalledWith(false);
  });

  it("asks to collapse again when it is already open", () => {
    const onCollapse = vi.fn();
    render(<ClosedStrip {...props({ collapsed: false, onCollapse })} />);
    fireEvent.click(screen.getByText("Recently closed"));
    expect(onCollapse).toHaveBeenCalledWith(true);
  });

  it("reopens a row by its run key", () => {
    const onReopen = vi.fn();
    render(<ClosedStrip {...props({ collapsed: false, onReopen })} />);
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    expect(onReopen).toHaveBeenCalledWith("notepad-a");
  });

  it("forgets a row by its run key", () => {
    const onForget = vi.fn();
    render(<ClosedStrip {...props({ collapsed: false, onForget })} />);
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    expect(onForget).toHaveBeenCalledWith("notepad-a");
  });

  it("offers Clear all only when expanded", () => {
    const { rerender } = render(<ClosedStrip {...props()} />);
    expect(screen.queryByRole("button", { name: "Clear all" })).not.toBeInTheDocument();
    rerender(<ClosedStrip {...props({ collapsed: false })} />);
    expect(screen.getByRole("button", { name: "Clear all" })).toBeInTheDocument();
  });

  it("clears every listed run at once", () => {
    const onClearAll = vi.fn();
    render(<ClosedStrip {...props({ collapsed: false, onClearAll })} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClearAll).toHaveBeenCalled();
  });

  it("omits the age on a row with no closedAt rather than rendering an empty gap", () => {
    // Asserted on the element, not on its text: `timeAgo(null)` is "", so a
    // rendered-but-empty span reads as the string "closed" once the DOM matcher
    // normalizes whitespace — indistinguishable from a matcher's near miss.
    const { container } = render(<ClosedStrip {...props({ collapsed: false, rows: [row({ closedAt: null })] })} />);
    expect(container.querySelector(".rc-when")).toBeNull();
  });

  it("does render the age when there is one", () => {
    const { container } = render(<ClosedStrip {...props({ collapsed: false })} />);
    expect(container.querySelector(".rc-when")?.textContent).toBe("closed 2h ago");
  });
});
