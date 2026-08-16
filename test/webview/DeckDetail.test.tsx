// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { DeckDetail } from "../../src/webview/DeckDetail";
import { send } from "../../src/webview/vscodeApi";
import type { DeckCard } from "../../src/webview/deckCards";
import type { PrEntryMap, PrFacts, RunStatus } from "../../src/types";

const sent = vi.mocked(send);
beforeEach(() => sent.mockClear());

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 10, url: "https://gh/pr/10", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 3, pending: 0, failing: [] },
  review: "none", unresolved: null, mergeable: "clean", ciAdvisory: false, ...over,
});

const mkCard = (over: Partial<RunStatus> = {}, agent: DeckCard["agent"] = null): DeckCard => {
  const status: RunStatus = {
    run: {
      key: "ASM-1", summary: "Export fails", url: "https://jira/ASM-1", createdAt: 1,
      mode: "per-window",
      repos: [{ name: "svc", path: "/r/svc", isGit: true, branch: "feat/x" }], briefPaths: [],
    },
    column: "review", ticketStatus: "In Review", ticketCategory: "indeterminate",
    repos: [{ name: "svc", path: "/r/svc", branch: "feat/x", dirty: false, ahead: 0,
      added: 5, removed: 1, files: 2 }],
    agent: { state: "unknown", lastActivityMs: null, slug: null },
    windowOpen: false, prs: {} as PrEntryMap, agents: [], shelf: "board", ...over,
  };
  return { id: `p:${status.run.key}`, status, agent, agents: status.agents,
    column: status.column, lane: "waiting" };
};

const render1 = (card: DeckCard, onClose = vi.fn(), onForget = vi.fn()) =>
  render(<DeckDetail card={card} sourceLabel="Jira" onClose={onClose} onForget={onForget} />);

describe("DeckDetail", () => {
  it("names the run in its header", () => {
    render1(mkCard());
    const hd = document.querySelector(".dd-hd")!;
    expect(hd.textContent).toContain("ASM-1");
    expect(hd.textContent).toContain("Export fails");
  });

  it("relocates the branch, launched time and repo chips", () => {
    render1(mkCard());
    expect(document.querySelector(".dd .c-branch .bn")!.textContent).toContain("feat/x");
    expect(document.querySelector(".dd .c-repos .repo")!.textContent).toContain("svc");
  });

  it("relocates the PR block", () => {
    render1(mkCard({ prs: { svc: { facts: facts({ number: 77 }), fetchedAt: 1 } } as PrEntryMap }));
    expect(document.querySelector(".dd .pr-block")!.textContent).toContain("#77");
  });

  it("says so rather than rendering an empty section when there is no PR", () => {
    render1(mkCard());
    expect(document.querySelector(".dd .pr-block")).toBeNull();
    expect(screen.getByText(/no pull request yet/i)).toBeTruthy();
  });

  it("opens the workspace", () => {
    render1(mkCard());
    fireEvent.click(screen.getByRole("button", { name: /open workspace/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "ASM-1", action: "open" });
  });

  it("scopes a per-repo diff to that repo", () => {
    const card = mkCard({
      repos: [
        { name: "svc", path: "/r/svc", branch: "feat/x", dirty: false, ahead: 0, added: 1, removed: 0, files: 1 },
        { name: "web", path: "/r/web", branch: "feat/x", dirty: false, ahead: 0, added: 2, removed: 0, files: 1 },
      ],
    });
    render1(card);
    fireEvent.click(screen.getByRole("button", { name: /diff — web/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "ASM-1", action: "diff", repo: "web" });
  });

  it("offers no per-repo diff on a single-repo card — the all-repos one already is it", () => {
    render1(mkCard());
    expect(screen.queryByRole("button", { name: /diff — svc/i })).toBeNull();
  });

  it("offers Address PR on the waiting lane", () => {
    const { container } = render1(mkCard());
    expect(within(container).getByRole("button", { name: /address pr/i })).toBeTruthy();
  });

  it("offers no Address PR on the ready lane", () => {
    const { container } = render1({ ...mkCard(), lane: "ready" });
    expect(within(container).queryByRole("button", { name: /address pr/i })).toBeNull();
  });

  it("offers no Address PR on a local card, whatever the lane", () => {
    const card = mkCard({ run: { ...mkCard().status.run, key: "local-abc", url: "", kind: "local" } as never });
    const { container } = render1(card);
    expect(within(container).queryByRole("button", { name: /address pr/i })).toBeNull();
  });

  it("offers no Address PR outside the review column, even in the waiting lane", () => {
    // deriveLane only ever answers "waiting" under the review column, so this
    // combination cannot occur from projectCards/laneOf today — but DeckDetail
    // takes a plain DeckCard and enforces nothing about how its column and lane
    // were derived, so the column conjunct earns its own case regardless.
    const { container } = render1(mkCard({ column: "progress" }));
    expect(within(container).queryByRole("button", { name: /address pr/i })).toBeNull();
  });

  it("links each failing check by name", () => {
    render1(mkCard({
      prs: { svc: { facts: facts({ ci: { passing: 0, pending: 0, failing: [{ name: "e2e", url: "https://ci/e2e" }] } }), fetchedAt: 1 } } as PrEntryMap,
    }));
    fireEvent.click(screen.getByRole("button", { name: /open failing check — e2e/i }));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://ci/e2e" });
  });

  it("offers no action for a failing check with no url — there is nothing to open", () => {
    render1(mkCard({
      prs: { svc: { facts: facts({ ci: { passing: 0, pending: 0, failing: [{ name: "lint", url: "" }] } }), fetchedAt: 1 } } as PrEntryMap,
    }));
    expect(screen.queryByRole("button", { name: /open failing check — lint/i })).toBeNull();
  });

  it("copies the branch name without touching the host", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(mkCard());
    fireEvent.click(screen.getByRole("button", { name: /copy branch name/i }));
    expect(writeText).toHaveBeenCalledWith("feat/x");
    expect(sent).not.toHaveBeenCalled();
  });

  it("forgets through the callback, not a raw post", () => {
    const onForget = vi.fn();
    render1(mkCard(), vi.fn(), onForget);
    fireEvent.click(screen.getByRole("button", { name: /^forget$/i }));
    expect(onForget).toHaveBeenCalledWith("ASM-1");
  });

  it("offers Track it instead of Forget on a local card", () => {
    render1(mkCard({ run: { ...mkCard().status.run, key: "local-abc", url: "", kind: "local" } as never }));
    expect(screen.queryByRole("button", { name: /^forget$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /track it/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:track", key: "local-abc" });
  });

  it("prints how many actions it is offering", () => {
    render1(mkCard());
    const n = document.querySelectorAll(".dd-act").length;
    expect(document.querySelector(".dd-count")!.textContent).toContain(String(n));
  });

  it("closes on its close button", () => {
    const onClose = vi.fn();
    render1(mkCard(), onClose);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
