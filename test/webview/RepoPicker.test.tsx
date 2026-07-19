// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";

// App.tsx transitively loads vscodeApi, whose module init calls the host-only
// acquireVsCodeApi(); stub it so the module can load under jsdom.
vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { RepoPicker } from "../../src/webview/App";

const open = (available: string[]) => {
  const onAdd = vi.fn();
  render(<RepoPicker available={available} onAdd={onAdd} />);
  fireEvent.click(screen.getByText(/add repo/i));
  const input = screen.getByPlaceholderText(/Filter repos/i) as HTMLInputElement;
  return { onAdd, input };
};

describe("RepoPicker", () => {
  it("renders nothing when there are no available repos", () => {
    const { container } = render(<RepoPicker available={[]} onAdd={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens the combo on click and lists every repo", () => {
    open(["centaur", "account-service"]);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("filters as you type", () => {
    const { input } = open(["centaur", "account-service"]);
    fireEvent.change(input, { target: { value: "acc" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(within(options[0]).getByText("account-service")).toBeInTheDocument();
  });

  it("shows an empty state when nothing matches", () => {
    const { input } = open(["centaur"]);
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/No repos match/i)).toBeInTheDocument();
  });

  it("chooses the first match on Enter", () => {
    const { onAdd, input } = open(["centaur", "account-service"]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith("centaur");
  });

  it("moves the active row with ArrowDown before Enter", () => {
    const { onAdd, input } = open(["centaur", "account-service"]);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith("account-service");
  });

  it("clamps ArrowUp at the top of the list", () => {
    const { onAdd, input } = open(["centaur", "account-service"]);
    fireEvent.keyDown(input, { key: "ArrowUp" }); // already at 0
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onAdd).toHaveBeenCalledWith("centaur");
  });

  it("chooses a repo on row mousedown and clears the query", () => {
    const { onAdd, input } = open(["centaur", "account-service"]);
    fireEvent.change(input, { target: { value: "acc" } });
    fireEvent.mouseDown(screen.getByText("account-service"));
    expect(onAdd).toHaveBeenCalledWith("account-service");
    expect(input.value).toBe("");
  });

  it("closes on Escape", () => {
    const { input } = open(["centaur"]);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByPlaceholderText(/Filter repos/i)).not.toBeInTheDocument();
    expect(screen.getByText(/add repo/i)).toBeInTheDocument();
  });
});
