// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, createEvent } from "@testing-library/react";
import * as React from "react";

const sendSpy = vi.fn();
vi.mock("../../src/webview/vscodeApi", () => ({ send: (m: unknown) => sendSpy(m) }));

import { Notepad } from "../../src/webview/Notepad";
import type { NotepadItemView, NotepadSectionView } from "../../src/types";

const note = (over: Partial<NotepadItemView> = {}): NotepadItemView => ({
  id: "n1", title: "Ship the thing", body: "body", done: false, createdAt: 1, ...over,
});

const section = (over: Partial<NotepadSectionView> = {}): NotepadSectionView => ({
  id: "s1", name: "Bugs", createdAt: 1, collapsed: false, ...over,
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
  // jsdom has no DragEvent global, so @testing-library/dom's fireEvent.dragOver /
  // .drop / .dragLeave fall back to a plain Event constructor — which silently
  // drops any MouseEvent-only init field. `dataTransfer` survives only because
  // testing-library patches it on specially (events.js's dataTransferProperties
  // loop); `clientY` and `relatedTarget` do not, so e.clientY reads back
  // `undefined` and e.relatedTarget reads back `undefined` no matter what the
  // call site passes. `undefined < anything` is always false, which is the REAL
  // reason every drop below resolves to "after": not (only) jsdom's 0x0 rects,
  // but clientY never reaching the native event at all. These two helpers patch
  // the field onto the event object directly — the same technique testing-library
  // itself uses for dataTransfer — so a test can actually drive the "before" path
  // and the onDragLeave handler's relatedTarget check.
  const dragOverAt = (el: HTMLElement, dataTransfer: unknown, clientY: number) => {
    const event = createEvent.dragOver(el, { dataTransfer });
    Object.defineProperty(event, "clientY", { value: clientY, configurable: true });
    fireEvent(el, event);
  };
  const dropAt = (el: HTMLElement, dataTransfer: unknown, clientY: number) => {
    const event = createEvent.drop(el, { dataTransfer });
    Object.defineProperty(event, "clientY", { value: clientY, configurable: true });
    fireEvent(el, event);
  };
  const dragLeaveTo = (el: HTMLElement, dataTransfer: unknown, relatedTarget: EventTarget | null) => {
    const event = createEvent.dragLeave(el, { dataTransfer });
    Object.defineProperty(event, "relatedTarget", { value: relatedTarget, configurable: true });
    fireEvent(el, event);
  };
  const stubRect = (el: HTMLElement, top: number, height: number) => {
    el.getBoundingClientRect = () => ({
      top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top,
      toJSON() { return this; },
    });
  };

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

    // e.clientY is undefined here (see the block comment above) — the drop
    // resolves to "after" no matter what "clientY: 5" above claims to pass.
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:reorder", order: ["n2", "n1", "n3"] });
  });

  it("resolves a drop on the row's top half as before, both in the class and the order", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    const third = items[2] as HTMLElement; // dragged
    const first = items[0] as HTMLElement; // drop target
    const dataTransfer = dt();
    // A real row has real height; give the target one so a real clientY can
    // land above its midpoint (10).
    stubRect(first, 0, 20);

    fireEvent.mouseDown(third.querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(third, { dataTransfer });
    dragOverAt(first, dataTransfer, 2);
    expect(first.className).toContain("drop-before");

    dropAt(first, dataTransfer, 2);
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:reorder", order: ["n3", "n1", "n2"] });
  });

  it("does not arm a drag that did not start on the grip", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    const first = items[0] as HTMLElement;
    const dataTransfer = dt();

    // A mousedown with no grip involved — pressing the row's own body, e.g. its
    // title text — must not arm the drag. Firing dragStart with no mousedown at
    // all would pass even if the row itself armed on every mousedown, since
    // armed.current already starts false; pressing the row is what actually
    // exercises that guard.
    fireEvent.mouseDown(first);
    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(items[1] as HTMLElement, { dataTransfer, clientY: 5 });
    fireEvent.drop(items[1] as HTMLElement, { dataTransfer, clientY: 5 });
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notepad:reorder" }));
  });

  it("is not draggable at rest, so mouse text-selection inside the row is never pre-empted", () => {
    // A real browser only lets `preventDefault()` on dragstart cancel a drag it has
    // already decided to start — it never hands the gesture back to text selection
    // once dragstart has fired. Marking the row draggable unconditionally (with
    // dragstart doing the gating instead) breaks selecting text out of a note's
    // body at rest, which no fireEvent-level test can see: jsdom dispatches a
    // synthetic dragstart regardless of the draggable attribute's value. Only a
    // direct assertion on the attribute itself catches that regression.
    const { container } = render(<Notepad ordered={false} notes={[note({ id: "n1" })]} />);
    const row = container.querySelector(".np-item") as HTMLElement;
    expect(row).not.toHaveAttribute("draggable", "true");

    fireEvent.mouseDown(row.querySelector(".grip") as HTMLElement);
    expect(row).toHaveAttribute("draggable", "true");

    fireEvent.dragEnd(row);
    expect(row).not.toHaveAttribute("draggable", "true");
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

  it("does not draw a drop edge on the row being dragged, even when the pointer drifts back over it", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    const first = items[0] as HTMLElement;
    const dataTransfer = dt();
    fireEvent.mouseDown(first.querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(first, { dataTransfer, clientY: 5 });
    expect(first.className).not.toMatch(/drop-before|drop-after/);
  });

  it("clears the drop hint only once the drag truly leaves the list, not when it crosses between rows", () => {
    const { container } = render(<Notepad ordered={false} notes={three()} />);
    const items = container.querySelectorAll(".np-item");
    const list = container.querySelector(".np-list") as HTMLElement;
    const dataTransfer = dt();
    fireEvent.mouseDown(items[0].querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(items[0], { dataTransfer });
    fireEvent.dragOver(items[1], { dataTransfer, clientY: 5 });
    expect(items[1].className).toContain("drop-after");

    // Moving from one row to another is still inside the list — the hint stays.
    dragLeaveTo(list, dataTransfer, items[2]);
    expect(items[1].className).toContain("drop-after");

    // Leaving the list altogether (e.g. drifting up over the compose box) clears it.
    dragLeaveTo(list, dataTransfer, document.body);
    expect(items[1].className).not.toContain("drop-after");
  });

  it("shows Reset order only once an order exists, and sends it", () => {
    const { rerender } = render(<Notepad ordered={false} notes={three()} />);
    expect(screen.queryByRole("button", { name: "Reset order" })).toBeNull();
    rerender(<Notepad ordered notes={three()} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset order" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:resetOrder" });
  });

  it("puts Clear completed and Reset order in the same content-width row, not two stacked bars", () => {
    // jsdom does no layout, so it cannot see a button stretch to the panel's
    // width — that part is verified by rendering the harness (see the fix
    // report). What jsdom CAN pin is the DOM shape the CSS depends on: both
    // controls must share one .lens (a flex row), not sit as .lenses's direct
    // children (a flex column, which is what stretched each one full-width).
    const { rerender } = render(
      <Notepad ordered notes={[note({ id: "n1" }), note({ id: "n2", done: true })]} />,
    );
    const clear = screen.getByRole("button", { name: "Clear completed" });
    const reset = screen.getByRole("button", { name: "Reset order" });
    expect(clear.parentElement).toBe(reset.parentElement);
    expect(clear.parentElement).toHaveClass("lens");

    // With only one of the two visible, that lone button still sits inside a
    // .lens rather than directly under .lenses — the case the finding named
    // ("the layout must still be right when only one of them is visible").
    rerender(<Notepad ordered={false} notes={[note({ id: "n1" }), note({ id: "n2", done: true })]} />);
    const clearAlone = screen.getByRole("button", { name: "Clear completed" });
    expect(clearAlone.parentElement).toHaveClass("lens");
    expect(screen.queryByRole("button", { name: "Reset order" })).toBeNull();
  });

  it("does not offer a grip while a note is being edited", () => {
    const { container } = render(<Notepad ordered={false} notes={[note({ id: "n1" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    expect(container.querySelector(".grip")).toBeNull();
  });
});

describe("sections", () => {
  it("groups a note under its section's header and leaves an unsectioned note headerless", () => {
    render(
      <Notepad
        ordered={false}
        notes={[note({ id: "a", title: "in a section", sectionId: "s1" }), note({ id: "b", title: "no section" })]}
        sections={[section()]}
      />,
    );
    expect(screen.getByText("Bugs")).toBeInTheDocument();
    expect(screen.getByText("in a section")).toBeInTheDocument();
    expect(screen.getByText("no section")).toBeInTheDocument();
  });

  it("hides a collapsed section's notes but keeps its header", () => {
    render(
      <Notepad
        ordered={false}
        notes={[note({ id: "a", title: "hidden note", sectionId: "s1" })]}
        sections={[section({ collapsed: true })]}
      />,
    );
    expect(screen.getByText("Bugs")).toBeInTheDocument();
    expect(screen.queryByText("hidden note")).toBeNull();
  });

  it("sends notepad:toggleSectionCollapsed from the section's chevron", () => {
    render(<Notepad ordered={false} notes={[]} sections={[section()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse Bugs" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:toggleSectionCollapsed", id: "s1" });
  });

  it("labels a collapsed section's toggle as Expand", () => {
    render(<Notepad ordered={false} notes={[]} sections={[section({ collapsed: true })]} />);
    expect(screen.getByRole("button", { name: "Expand Bugs" })).toBeInTheDocument();
  });

  it("adds a section from the Add section control and clears the input", () => {
    render(<Notepad ordered={false} notes={[]} sections={[]} />);
    const input = screen.getByPlaceholderText("New section name");
    fireEvent.change(input, { target: { value: "Ideas" } });
    fireEvent.click(screen.getByRole("button", { name: "Add section" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:addSection", name: "Ideas" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("disables Add section until a name is typed", () => {
    render(<Notepad ordered={false} notes={[]} sections={[]} />);
    expect(screen.getByRole("button", { name: "Add section" })).toBeDisabled();
  });

  it("renames a section from its header", () => {
    render(<Notepad ordered={false} notes={[]} sections={[section()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Rename section" }));
    const nameInput = screen.getByDisplayValue("Bugs");
    fireEvent.change(nameInput, { target: { value: "Bugs & fixes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save section name" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:renameSection", id: "s1", name: "Bugs & fixes" });
  });

  it("deletes a section from its header", () => {
    render(<Notepad ordered={false} notes={[]} sections={[section()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete section" }));
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:deleteSection", id: "s1" });
  });

  it("files a note into a section from the edit form's picker", () => {
    render(<Notepad ordered={false} notes={[note()]} sections={[section()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Section" }), { target: { value: "s1" } });
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:setSection", id: "n1", sectionId: "s1" });
  });

  it("clears a note's section from the edit form's picker", () => {
    render(<Notepad ordered={false} notes={[note({ sectionId: "s1" })]} sections={[section()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Section" }), { target: { value: "" } });
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:setSection", id: "n1", sectionId: undefined });
  });
});

describe("drag across sections", () => {
  const dt = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" });

  it("reassigns and reorders when dropped on a note in a different section", () => {
    const { container } = render(
      <Notepad
        ordered={false}
        notes={[note({ id: "a", title: "dragged" }), note({ id: "b", title: "target", sectionId: "s1" })]}
        sections={[section()]}
      />,
    );
    const dragged = screen.getByText("dragged").closest(".np-item") as HTMLElement;
    const target = screen.getByText("target").closest(".np-item") as HTMLElement;
    const dataTransfer = dt();

    fireEvent.mouseDown(dragged.querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(dragged, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientY: 5 });
    fireEvent.drop(target, { dataTransfer, clientY: 5 });

    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:reorder", order: ["b", "a"] });
    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:setSection", id: "a", sectionId: "s1" });
  });

  it("only reorders, without reassigning, when dropped within the same section", () => {
    render(
      <Notepad
        ordered={false}
        notes={[note({ id: "a", title: "first", sectionId: "s1" }), note({ id: "b", title: "second", sectionId: "s1" })]}
        sections={[section()]}
      />,
    );
    const first = screen.getByText("first").closest(".np-item") as HTMLElement;
    const second = screen.getByText("second").closest(".np-item") as HTMLElement;
    const dataTransfer = dt();

    fireEvent.mouseDown(first.querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(first, { dataTransfer });
    fireEvent.dragOver(second, { dataTransfer, clientY: 5 });
    fireEvent.drop(second, { dataTransfer, clientY: 5 });

    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:reorder", order: ["b", "a"] });
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notepad:setSection" }));
  });

  it("files a note into a section when dropped on its header, without reordering", () => {
    render(
      <Notepad ordered={false} notes={[note({ id: "a", title: "dragged" })]} sections={[section()]} />,
    );
    const dragged = screen.getByText("dragged").closest(".np-item") as HTMLElement;
    const header = screen.getByText("Bugs").closest(".np-section-head") as HTMLElement;
    const dataTransfer = dt();

    fireEvent.mouseDown(dragged.querySelector(".grip") as HTMLElement);
    fireEvent.dragStart(dragged, { dataTransfer });
    fireEvent.dragOver(header, { dataTransfer });
    fireEvent.drop(header, { dataTransfer });

    expect(sendSpy).toHaveBeenCalledWith({ type: "notepad:setSection", id: "a", sectionId: "s1" });
    expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: "notepad:reorder" }));
  });
});
