// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
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

  it("says so when the filter hides everything", () => {
    render(<Notepad notes={[note({ done: true })]} />);
    expect(screen.getByText("Nothing active. Add a note above.")).toBeTruthy();
  });
});

describe("Notepad dictation", () => {
  // A stand-in for the browser's SpeechRecognition: jsdom implements neither the
  // constructor nor the events, so the component is driven through this fake.
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    continuous = false;
    interimResults = false;
    lang = "";
    started = false;
    onresult: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { FakeRecognition.last = this; }
    start() { this.started = true; }
    stop() { this.started = false; this.onend?.(); }
  }

  beforeEach(() => {
    FakeRecognition.last = null;
    (window as unknown as Record<string, unknown>).SpeechRecognition = FakeRecognition;
  });

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  });

  it("hides the mic when the browser has no SpeechRecognition at all", () => {
    delete (window as unknown as Record<string, unknown>).SpeechRecognition;
    render(<Notepad notes={[]} />);
    expect(screen.queryByRole("button", { name: /Dictate/ })).toBeNull();
  });

  it("appends a final transcript into the body", () => {
    render(<Notepad notes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate the note body" }));
    act(() => {
      FakeRecognition.last!.onresult!({
        resultIndex: 0,
        results: [Object.assign([{ transcript: "check the retry path" }], { isFinal: true })],
      });
    });
    expect((screen.getByPlaceholderText("Any detail the agent should know (optional)") as HTMLTextAreaElement).value)
      .toContain("check the retry path");
  });

  it("stops listening on a second click", () => {
    render(<Notepad notes={[]} />);
    const mic = screen.getByRole("button", { name: "Dictate the note body" });
    fireEvent.click(mic);
    expect(FakeRecognition.last!.started).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop dictating the note body" }));
    expect(FakeRecognition.last!.started).toBe(false);
  });

  it("appends a final transcript into the title", () => {
    render(<Notepad notes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate the title" }));
    act(() => {
      FakeRecognition.last!.onresult!({
        resultIndex: 0,
        results: [Object.assign([{ transcript: "ship the retry fix" }], { isFinal: true })],
      });
    });
    expect((screen.getByPlaceholderText("What needs doing?") as HTMLInputElement).value)
      .toContain("ship the retry fix");
  });

  it("starting the other mic stops the first — only one microphone is ever live", () => {
    render(<Notepad notes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate the title" }));
    const titleRec = FakeRecognition.last!;
    expect(titleRec.started).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Dictate the note body" }));
    const bodyRec = FakeRecognition.last!;

    expect(titleRec.started).toBe(false); // the title's recogniser was stopped
    expect(bodyRec.started).toBe(true); // and only the body's is live
    expect(titleRec).not.toBe(bodyRec);
    // The title button reflects the switch too — it dropped back to "Dictate".
    expect(screen.getByRole("button", { name: "Dictate the title" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop dictating the note body" })).toBeTruthy();
  });

  it("recovers its idle label when recognition errors out", () => {
    render(<Notepad notes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate the note body" }));
    act(() => {
      FakeRecognition.last!.onerror!();
      FakeRecognition.last!.onend!();
    });
    expect(screen.getByRole("button", { name: "Dictate the note body" })).toBeTruthy();
  });

  it("stops the microphone when the view unmounts mid-dictation", () => {
    const { unmount } = render(<Notepad notes={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate the note body" }));
    expect(FakeRecognition.last!.started).toBe(true);
    unmount();
    expect(FakeRecognition.last!.started).toBe(false);
  });
});
