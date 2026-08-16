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

describe("AgentsRow", () => {
  // The drawer is the one caller with room to spare, and it passes defaultOpen
  // explicitly (see DeckDetail.tsx). Every other/future caller must keep getting
  // the card's original fold — nothing else about AgentsRow's call sites should
  // change just because the drawer now wants it expanded.
  it("stays collapsed by default when defaultOpen is omitted", () => {
    render(<AgentsRow agents={[mkAgent("svc-7e", "working"), mkAgent("svc-fa", "idle")]} />);
    expect(screen.getByRole("button", { name: /2 agents/ })).toBeTruthy();
    expect(screen.queryByText("svc-fa")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /2 agents/ }));
    expect(screen.getByText("svc-fa")).toBeTruthy();
  });

  it("starts expanded when defaultOpen is passed", () => {
    render(<AgentsRow agents={[mkAgent("svc-7e", "working"), mkAgent("svc-fa", "idle")]} defaultOpen />);
    expect(screen.getByText("svc-fa")).toBeTruthy();
  });
});
