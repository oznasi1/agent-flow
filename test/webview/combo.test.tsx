// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MultiCombo } from "../../src/webview/combo";

// The component's own contract, tested away from the Orchestrator drawer that
// mounts it. OrchestratorDrawer.test.tsx covers what a pick DOES to a flow; this
// file covers the picker: what it filters, what it remembers, and what it emits.
const OPTIONS = [
  { value: "deploy", label: "Deploy to staging", detail: "Ship the built artifact" },
  { value: "smoke", label: "Smoke test" },
  { value: "verify", label: "Verify on dev", detail: "Example — replace with your own check" },
];

const mount = (over: Partial<React.ComponentProps<typeof MultiCombo>> = {}) => {
  const onCommit = vi.fn();
  render(
    <MultiCombo
      trigger="+ Add thing…"
      ariaLabel="Add a thing"
      searchPlaceholder="Filter things…"
      options={OPTIONS}
      emptyLabel="(nothing configured)"
      onCommit={onCommit}
      {...over}
    />,
  );
  return { onCommit };
};

const open = (): HTMLElement => {
  fireEvent.click(screen.getByRole("button", { name: "Add a thing" }));
  return screen.getByRole("listbox", { name: "Add a thing" });
};

const rowNamed = (list: HTMLElement, text: string): HTMLElement => {
  const row = within(list).getAllByRole("option").find((r) => (r.textContent ?? "").includes(text));
  expect(row, `no row containing ${text}`).toBeTruthy();
  return row!;
};

const search = (): HTMLElement => screen.getByPlaceholderText("Filter things…");

describe("MultiCombo", () => {
  it("starts closed, showing its trigger and nothing else", () => {
    mount();
    const trigger = screen.getByRole("button", { name: "Add a thing" });
    expect(trigger.textContent).toContain("+ Add thing…");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on press and lists every option", () => {
    mount();
    const list = open();
    expect(within(list).getAllByRole("option").map((r) => (r.textContent ?? "").slice(0, 6))).toEqual([
      "Deploy",
      "Smoke ",
      "Verify",
    ]);
    // Multi-select is announced, not merely implemented: a listbox that admits
    // several ticks and does not say so reads to a screen reader as single-choice.
    expect(list.getAttribute("aria-multiselectable")).toBe("true");
  });

  it("prints a second line when an option has a detail, and nothing when it does not", () => {
    mount();
    const list = open();
    expect(rowNamed(list, "Deploy to staging").textContent).toContain("Ship the built artifact");
    expect(rowNamed(list, "Smoke test").querySelector(".d")).toBeNull();
  });

  it("marks a mono option's label as an identifier, and leaves prose alone", () => {
    // The sheet gives `.l.k` the mono family; jsdom never loads it, so what is
    // pinned here is the class the rule keys on — and that it is per option, not
    // per control. A command label in mono would be the drift this guards.
    mount({
      options: [
        { value: "a", label: "ASM-1", detail: "agent-flow", mono: true },
        { value: "b", label: "Deploy to staging" },
      ],
    });
    const list = open();
    expect(rowNamed(list, "ASM-1").querySelector(".l")!.className).toBe("l k");
    expect(rowNamed(list, "Deploy to staging").querySelector(".l")!.className).toBe("l");
  });

  it("filters on the label as you type", () => {
    mount();
    const list = open();
    fireEvent.change(search(), { target: { value: "smo" } });
    expect(within(list).getAllByRole("option")).toHaveLength(1);
    expect(within(list).getAllByRole("option")[0].textContent).toContain("Smoke test");
  });

  it("filters on the detail line too", () => {
    // The second line is on screen, so it has to be typeable — a filter that
    // ignored it would hide a row by a word the user can read on it.
    mount();
    const list = open();
    fireEvent.change(search(), { target: { value: "artifact" } });
    expect(within(list).getAllByRole("option").map((r) => (r.textContent ?? "").slice(0, 6))).toEqual([
      "Deploy",
    ]);
  });

  it("says nothing matched, in a line that is not an option", () => {
    mount();
    const list = open();
    fireEvent.change(search(), { target: { value: "zzz" } });
    expect(within(list).queryAllByRole("option")).toEqual([]);
    expect(within(list).getByText(/No match for/)).toBeTruthy();
  });

  it("distinguishes an empty list from an empty search", () => {
    // Two silences that mean different things: nothing is configured at all, or
    // nothing matches what was typed. One message for both would tell a user with
    // no options that their query was wrong.
    mount({ options: [] });
    const list = open();
    expect(within(list).getByText("(nothing configured)")).toBeTruthy();
    expect(within(list).queryByText(/No match for/)).toBeNull();
  });

  it("ticks and un-ticks a row", () => {
    mount();
    const list = open();
    const row = rowNamed(list, "Smoke test");
    fireEvent.mouseDown(row);
    expect(row.getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseDown(row);
    expect(row.getAttribute("aria-selected")).toBe("false");
  });

  it("counts what is ticked", () => {
    mount();
    const list = open();
    expect(screen.getByText("0 selected")).toBeTruthy();
    fireEvent.mouseDown(rowNamed(list, "Smoke test"));
    fireEvent.mouseDown(rowNamed(list, "Verify on dev"));
    expect(screen.getByText("2 selected")).toBeTruthy();
  });

  it("commits every ticked value in one call, ordered by the option list", () => {
    // Click order deliberately reversed. A caller folding these into one save
    // needs the batch to be a function of WHAT was ticked, not of the order the
    // pointer happened to visit.
    const { onCommit } = mount();
    const list = open();
    fireEvent.mouseDown(rowNamed(list, "Verify on dev"));
    fireEvent.mouseDown(rowNamed(list, "Deploy to staging"));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Add" }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(["deploy", "verify"]);
  });

  it("closes on commit", () => {
    const { onCommit } = mount();
    const list = open();
    fireEvent.mouseDown(rowNamed(list, "Smoke test"));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onCommit).toHaveBeenCalledWith(["smoke"]);
  });

  it("disables Add rather than hiding it while nothing is ticked", () => {
    // Visible before it is available, so the gesture is discoverable. `disabled`
    // is what makes the press inert — a mousedown on a disabled button never
    // reaches the handler at all, which is why the empty commit is pinned through
    // the keyboard path below instead (that one really does reach it).
    mount();
    open();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("commits nothing when the modifier fires with no row ticked", () => {
    // The one path that reaches the commit with an empty set: the keyboard
    // shortcut has no disabled state to stop it. Without the guard this reports
    // an "add" of zero things, and the caller folds an empty batch into a save.
    const { onCommit } = mount();
    open();
    fireEvent.keyDown(search(), { key: "Enter", metaKey: true });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("forgets ticks and the query when it closes without committing", () => {
    const { onCommit } = mount();
    const list = open();
    fireEvent.change(search(), { target: { value: "smo" } });
    fireEvent.mouseDown(rowNamed(list, "Smoke test"));
    fireEvent.keyDown(search(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();

    const reopened = open();
    // Every row back (the query is gone) and none of them ticked.
    expect(within(reopened).getAllByRole("option")).toHaveLength(3);
    expect(
      within(reopened).getAllByRole("option").filter((r) => r.getAttribute("aria-selected") === "true"),
    ).toEqual([]);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("closes on a click outside itself", () => {
    mount();
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ticks the active row with Enter, without closing", () => {
    // Enter toggles rather than commits, because the whole point of this control
    // is picking more than one thing before committing.
    const { onCommit } = mount();
    const list = open();
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(rowNamed(list, "Deploy to staging").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("listbox", { name: "Add a thing" })).toBeTruthy();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("walks the rows with the arrow keys", () => {
    const { onCommit } = mount();
    const list = open();
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(rowNamed(list, "Smoke test").getAttribute("aria-selected")).toBe("true");
    // Up again, and Enter lands on the first row rather than re-toggling the second.
    fireEvent.keyDown(search(), { key: "ArrowUp" });
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(rowNamed(list, "Deploy to staging").getAttribute("aria-selected")).toBe("true");
    expect(rowNamed(list, "Smoke test").getAttribute("aria-selected")).toBe("true");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits from the keyboard with the modifier", () => {
    // Enter is spent on toggling, so committing needs its own gesture — otherwise
    // the whole control is mouse-only past the first tick.
    const { onCommit } = mount();
    open();
    fireEvent.keyDown(search(), { key: "Enter" });
    fireEvent.keyDown(search(), { key: "Enter", metaKey: true });
    expect(onCommit).toHaveBeenCalledWith(["deploy"]);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("commits with Ctrl+Enter as well, for a keyboard that has no meta key", () => {
    const { onCommit } = mount();
    open();
    fireEvent.keyDown(search(), { key: "Enter" });
    fireEvent.keyDown(search(), { key: "Enter", ctrlKey: true });
    expect(onCommit).toHaveBeenCalledWith(["deploy"]);
  });

  it("renders no footer action unless one is given", () => {
    mount();
    open();
    expect(screen.queryByRole("button", { name: "Free-text thing…" })).toBeNull();
  });

  it("fires the footer action immediately, and closes", () => {
    // An action, not an option: there is nothing to batch about it, so ticking
    // would be a lie about what pressing it does.
    const onPick = vi.fn();
    const { onCommit } = mount({ extra: { label: "Free-text thing…", onPick } });
    open();
    fireEvent.mouseDown(screen.getByRole("button", { name: "Free-text thing…" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not carry ticked rows into the footer action", () => {
    // Pressing "free text" after ticking two commands means the one thing it
    // says, not three nodes.
    const onPick = vi.fn();
    const { onCommit } = mount({ extra: { label: "Free-text thing…", onPick } });
    const list = open();
    fireEvent.mouseDown(rowNamed(list, "Smoke test"));
    fireEvent.mouseDown(screen.getByRole("button", { name: "Free-text thing…" }));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("closes again when the trigger is pressed a second time", () => {
    mount();
    open();
    fireEvent.click(screen.getByRole("button", { name: "Add a thing" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("focuses the search box on open, so typing filters without a further click", () => {
    mount();
    open();
    expect(document.activeElement).toBe(search());
  });
});
