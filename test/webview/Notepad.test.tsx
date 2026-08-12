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
    render(<Notepad notes={[note({ id: "a", title: "open" }), note({ id: "b", title: "shut", done: true })]} ordered={false} />);
    expect(screen.getByRole("button", { name: "Active" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.queryByText("shut")).toBeNull();
  });

  it("shows done notes under the Done filter and everything under All", () => {
    render(<Notepad notes={[note({ id: "a", title: "open" }), note({ id: "b", title: "shut", done: true })]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("open")).toBeNull();
    expect(screen.getByText("shut")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("open")).toBeTruthy();
    expect(screen.getByText("shut")).toBeTruthy();
  });

  it("sends notepad:add with the typed title and body, then clears the form", () => {
    render(<Notepad notes={[]} ordered={false} />);
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
    render(<Notepad notes={[]} ordered={false} />);
    expect(screen.getByRole("button", { name: "Add note" })).toBeDisabled();
  });

  it("sends notepad:toggleDone from the checkbox", () => {
    render(<Notepad notes={[note()]} ordered={false} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Ship the thing/ }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:toggleDone", id: "n1" });
  });

  it("sends notepad:run from Start", () => {
    render(<Notepad notes={[note()]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:run", id: "n1" });
  });

  it("still renders a clickable Start on a done note", () => {
    render(<Notepad notes={[note({ done: true })]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:run", id: "n1" });
  });

  it("sends notepad:delete from Delete", () => {
    render(<Notepad notes={[note()]} ordered={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:delete", id: "n1" });
  });

  it("hides Clear completed until something is done", () => {
    const { rerender } = render(<Notepad notes={[note()]} ordered={false} />);
    expect(screen.queryByRole("button", { name: "Clear completed" })).toBeNull();
    rerender(<Notepad notes={[note({ done: true })]} ordered={false} />);
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
    ]} ordered={false} />);
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
    ]} ordered={false} />);
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
    render(<Notepad notes={[note()]} ordered={false} />);
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
    render(<Notepad notes={[note()]} ordered={false} />);
    const acts = screen.getByRole("button", { name: "Start" }).parentElement!;
    expect(acts).toHaveClass("np-acts");
    expect(acts.querySelector(".spacer")).toBeNull();
    expect(within(acts as HTMLElement).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim()))
      .toEqual(["Start", "Edit note", "Delete note"]);
  });

  it("says so when the filter hides everything", () => {
    render(<Notepad notes={[note({ done: true })]} ordered={false} />);
    expect(screen.getByText("Nothing active. Add a note above.")).toBeTruthy();
  });
});

describe("drag to reorder", () => {
  const dt = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" });
  const three = () => [
    note({ id: "n1", title: "first" }),
    note({ id: "n2", title: "second" }),
    note({ id: "n3", title: "third" }),
  ];

  it("renders notes in the order given, not by createdAt", () => {
    const { container } = render(
      <Notepad ordered notes={[note({ id: "old", title: "old", createdAt: 1 }),
                               note({ id: "new", title: "new", createdAt: 99 })]} />,
    );
    const titles = [...container.querySelectorAll(".np-title")].map((e) => e.textContent);
    expect(titles).toEqual(["old", "new"]);
  });

  it("commits a grip drag as notepad:reorder", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    const first = items[0] as HTMLElement;
    const second = items[1] as HTMLElement;
    const dataTransfer = dt();

    fireEvent.mouseDown(first.querySelector(".grip") as HTMLElement); // arm the drag
    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(second, { dataTransfer, clientY: 5 });
    fireEvent.drop(second, { dataTransfer, clientY: 5 });

    // getBoundingClientRect is 0×0 in jsdom → the drop resolves to "after".
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:reorder", order: ["n2", "n1", "n3"] });
  });

  it("does not arm a drag that did not start on the grip", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    fireEvent.dragStart(items[0] as HTMLElement, { dataTransfer: dt() });
    fireEvent.drop(items[1] as HTMLElement, { dataTransfer: dt(), clientY: 5 });
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notepad:reorder" }));
  });

  it("sends only the visible ids when a filter hides notes", () => {
    const { container } = render(
      <Notepad ordered={false} notes={[note({ id: "n1", title: "first" }),
                                       note({ id: "n2", title: "done one", done: true }),
                                       note({ id: "n3", title: "third" })]} />,
    );
    // Default filter is Active, so only n1 and n3 are on screen.
    const items = container.querySelectorAll(".np-item");
    expect(items.length).toBe(2);
    const dataTransfer = dt();
    fireEvent.mouseDown(items[0].querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(items[0], { dataTransfer });
    fireEvent.dragOver(items[1], { dataTransfer, clientY: 5 });
    fireEvent.drop(items[1], { dataTransfer, clientY: 5 });
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:reorder", order: ["n3", "n1"] });
  });

  it("marks the dragged row and the drop edge", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    const dataTransfer = dt();
    fireEvent.mouseDown(items[0].querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(items[0], { dataTransfer });
    fireEvent.dragOver(items[1], { dataTransfer, clientY: 5 });
    expect(items[0].className).toContain("dragging");
    expect(items[1].className).toContain("drop-after");
    fireEvent.dragEnd(items[0]);
    expect(items[0].className).not.toContain("dragging");
  });

  it("shows Reset order only once an order exists, and sends it", () => {
    const { rerender } = render(<Notepad ordered={false} notes={three()} />);
    expect(screen.queryByRole("button", { name: "Reset order" })).toBeNull();
    rerender(<Notepad ordered notes={three()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset order" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:resetOrder" });
  });

  it("does not offer a grip while a note is being edited", () => {
    const { container } = render(<Notepad ordered={false} notes={[note({ id: "n1" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    expect(container.querySelector(".grip")).toBeNull();
  });
});
