// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import * as React from "react";

const sendSpy = vi.fn();
vi.mock("../../src/webview/vscodeApi", () => ({ send: (m: unknown) => sendSpy(m) }));

import { Notepad } from "../../src/webview/Notepad";
import type { NotepadItemView } from "../../src/types";

const note = (over: Partial<NotepadItemView> = {}): NotepadItemView => ({
  id: "n1", title: "Ship the thing", body: "body", done: false, createdAt: 1, ...over,
});

beforeEach(() => sendSpy.mockClear());

describe("Notepad", () => {
  it("defaults the filter to Active", () => {
    render(<Notepad notes={[note({ id: "a", title: "open" }), note({ id: "b", title: "shut", done: true })]} />);
    expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.queryByText("shut")).toBeNull();
  });

  it("shows done notes under the Done filter and everything under All", () => {
    render(<Notepad notes={[note({ id: "a", title: "open" }), note({ id: "b", title: "shut", done: true })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("open")).toBeNull();
    expect(screen.getByText("shut")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("shut")).toBeTruthy();
  });

  it("sends notepad:add with the typed title and body, then clears the form", () => {
    render(<Notepad notes={[]} />);
    const title = screen.getByPlaceholderText("What needs doing?");
    const body = screen.getByPlaceholderText("Any detail the agent should know (optional)");
    fireEvent.change(title, { target: { value: "New task" } });
    fireEvent.change(body, { target: { value: "with detail" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:add", title: "New task", body: "with detail" });
    expect((title as HTMLInputElement).value).toBe("");
    expect((body as HTMLTextAreaElement).value).toBe("");
  });

  it("will not add a note with nothing in it", () => {
    render(<Notepad notes={[]} />);
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
  });

  it("sends notepad:toggleDone from the checkbox", () => {
    render(<Notepad notes={[note()]} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Ship the thing/ }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:toggleDone", id: "n1" });
  });

  it("sends notepad:run from Start", () => {
    render(<Notepad notes={[note()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:run", id: "n1" });
  });

  it("still renders a clickable Start on a done note", () => {
    render(<Notepad notes={[note({ done: true })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:run", id: "n1" });
  });

  it("sends notepad:delete from Delete", () => {
    render(<Notepad notes={[note()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:delete", id: "n1" });
  });

  it("hides Clear completed until something is done", () => {
    const { rerender } = render(<Notepad notes={[note()]} />);
    expect(screen.queryByRole("button", { name: "Clear completed" })).toBeNull();
    rerender(<Notepad notes={[note({ done: true })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear completed" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:clearCompleted" });
  });

  it("renders each run status as its own badge and none when absent", () => {
    render(<Notepad notes={[
      note({ id: "a", title: "r", runStatus: "running" }),
      note({ id: "b", title: "s", runStatus: "stale" }),
      note({ id: "c", title: "f", runStatus: "finished" }),
      note({ id: "d", title: "n" }),
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getAllByText(/Running|Stale|Finished/)).toHaveLength(3);
  });

  it("gives each run status its own rail class, and no rail when there is no status", () => {
    render(<Notepad notes={[
      note({ id: "a", title: "r", runStatus: "running" }),
      note({ id: "b", title: "s", runStatus: "stale" }),
      note({ id: "c", title: "f", runStatus: "finished" }),
      note({ id: "d", title: "n" }),
    ]} />);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    const rowFor = (t: string) => screen.getByText(t).closest("li")!;
    expect(rowFor("r")).toHaveClass("r-running");
    expect(rowFor("s")).toHaveClass("r-stale");
    expect(rowFor("f")).toHaveClass("r-done");
    const noStatusRow = rowFor("n");
    expect(noStatusRow.className).not.toMatch(/r-running|r-stale|r-done/);
    expect(within(noStatusRow).queryByText(/Running|Stale|Finished/)).toBeNull();
  });

  it("edits a note and sends notepad:update", () => {
    render(<Notepad notes={[note()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    const title = screen.getByDisplayValue("Ship the thing");
    fireEvent.change(title, { target: { value: "Ship it better" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:update", id: "n1", title: "Ship it better", body: "body" });
  });

  // The cluster is a two-column grid (Start on top, edit + delete below). The flex
  // spacer that used to push the pair right would become a phantom grid item there,
  // taking a cell and breaking the two rows apart.
  it("holds only the three action buttons, with no leftover flex spacer", () => {
    render(<Notepad notes={[note()]} />);
    const acts = screen.getByRole("button", { name: "Start" }).parentElement!;
    expect(acts).toHaveClass("np-acts");
    expect(acts.querySelector(".spacer")).toBeNull();
    expect(within(acts as HTMLElement).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim()))
      .toEqual(["Start", "Edit note", "Delete note"]);
  });

  it("says so when the filter hides everything", () => {
    render(<Notepad notes={[note({ done: true })]} />);
    expect(screen.getByText("Nothing active. Add a note above.")).toBeTruthy();
  });
});
