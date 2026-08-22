// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { AgentsRow } from "../../src/webview/deckParts";
import type { CardAgent } from "../../src/types";

const mkAgent = (name: string, state: CardAgent["activity"]["state"]): CardAgent => ({
  session: { pid: 1, sessionId: name, cwd: "/r/svc", startedAt: Date.now() - 3_600_000, name },
  activity: { state, lastActivityMs: Date.now(), slug: null },
});

const withModel = (a: CardAgent, model: string | null, modelCount = 1): CardAgent =>
  ({ ...a, activity: { ...a.activity, model, modelCount } });

describe("AgentsRow", () => {
  // The drawer is the one caller with room to spare, and it passes defaultOpen
  // explicitly (see DeckDetail.tsx). Every other/future caller must keep getting
  // the card's original fold — nothing else about AgentsRow's call sites should
  // change just because the drawer now wants it expanded.
  it("stays collapsed by default when defaultOpen is omitted", () => {
    render(<AgentsRow agents={[mkAgent("svc-7e", "working"), mkAgent("svc-fa", "idle")]} />);
    expect(screen.getByRole("button", { name: /2 sessions/ })).toBeTruthy();
    expect(screen.queryByText("svc-fa")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /2 sessions/ }));
    expect(screen.getByText("svc-fa")).toBeTruthy();
  });

  it("starts expanded when defaultOpen is passed", () => {
    render(<AgentsRow agents={[mkAgent("svc-7e", "working"), mkAgent("svc-fa", "idle")]} defaultOpen />);
    expect(screen.getByText("svc-fa")).toBeTruthy();
  });
});

describe("AgentsRow model", () => {
  it("shows the model the session is answering with", () => {
    render(<AgentsRow agents={[withModel(mkAgent("svc-7e", "working"), "claude-opus-5")]} defaultOpen />);
    expect(screen.getByText("opus-5")).toBeTruthy();
  });

  it("shows nothing where there is no model to show", () => {
    // A transcript that yielded no main-chain model must leave the row exactly as it
    // was — never a dash, never "unknown".
    const { container } = render(<AgentsRow agents={[withModel(mkAgent("svc-7e", "working"), null)]} defaultOpen />);
    expect(container.querySelector(".ag-model")).toBeNull();
  });

  it("marks a session that used more than one model", () => {
    const { container } = render(
      <AgentsRow agents={[withModel(mkAgent("svc-7e", "working"), "claude-opus-5", 2)]} defaultOpen />,
    );
    expect(container.querySelector(".ag-model .plus")!.textContent).toBe("+1");
  });

  it("does not mark a session that used exactly one", () => {
    const { container } = render(
      <AgentsRow agents={[withModel(mkAgent("svc-7e", "working"), "claude-opus-5", 1)]} defaultOpen />,
    );
    expect(container.querySelector(".ag-model .plus")).toBeNull();
  });
});
