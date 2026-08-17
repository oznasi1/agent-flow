// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { DeckDetail } from "../../src/webview/DeckDetail";
import { send } from "../../src/webview/vscodeApi";
import type { DeckCard } from "../../src/webview/deckCards";
import type { PrEntryMap, PrFacts, RunStatus } from "../../src/types";
import type { UsageTotals } from "../../src/engine/usage";

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

// `usage` is threaded as a 4th positional so every pre-existing call renders with
// it undefined — the "still reading" state, which is what a drawer genuinely shows
// before the host answers.
const render1 = (
  card: DeckCard,
  onClose = vi.fn(),
  onForget = vi.fn(),
  usage?: UsageTotals | null,
) =>
  render(<DeckDetail card={card} sourceLabel="Jira" usage={usage} onClose={onClose} onForget={onForget} />);

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
    // An actual open PR behind it — canAddressPr also requires prSignals(r.prs).open,
    // which mkCard()'s default `prs: {}` does not satisfy (see the "no PR at all"
    // case below).
    const { container } = render1(mkCard({ prs: { svc: { facts: facts(), fetchedAt: 1 } } as PrEntryMap }));
    expect(within(container).getByRole("button", { name: /address pr/i })).toBeTruthy();
  });

  it("offers no Address PR on the ready lane", () => {
    const { container } = render1({ ...mkCard(), lane: "ready" });
    expect(within(container).queryByRole("button", { name: /address pr/i })).toBeNull();
  });

  // A run can reach the review column's waiting lane off its Jira status alone
  // (deriveBucket's isReviewStatus), with no PR entries behind it at all —
  // mkCard()'s default `prs: {}` is exactly that. Without prSignals(r.prs).open
  // in canAddressPr, the button would offer to seed an agent against a PR that
  // does not exist.
  it("offers no Address PR on the waiting lane with no PR at all (prs: {})", () => {
    const { container } = render1(mkCard());
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

  it("copies the ticket key without touching the host", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(mkCard());
    fireEvent.click(screen.getByRole("button", { name: /copy ticket key/i }));
    expect(writeText).toHaveBeenCalledWith("ASM-1");
    expect(sent).not.toHaveBeenCalled();
  });

  it("copies the PR url without touching the host", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(mkCard({ prs: { svc: { facts: facts({ url: "https://gh/pr/77" }), fetchedAt: 1 } } as PrEntryMap }));
    fireEvent.click(screen.getByRole("button", { name: /copy pr url/i }));
    expect(writeText).toHaveBeenCalledWith("https://gh/pr/77");
    expect(sent).not.toHaveBeenCalled();
  });

  it("copies the worktree path without touching the host", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(mkCard());
    fireEvent.click(screen.getByRole("button", { name: /copy worktree path/i }));
    expect(writeText).toHaveBeenCalledWith("/r/svc");
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

// Spend moved here from the card in response to a direct request: the drawer is the
// only place it appears now. These tests carry over the invariants the card's own
// spend tests protected — the `eq` unit label, and the rule that "not measured" and
// "cost nothing" must never render alike — plus the two states the card never had.
describe("DeckDetail — Spend", () => {
  const totals = (over: Partial<UsageTotals> = {}): UsageTotals =>
    ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, ...over });

  const spend = () => document.querySelector(".dd-spend") as HTMLElement | null;

  it("reads as still-loading before the host answers", () => {
    render1(mkCard(), undefined, undefined, undefined);
    expect(screen.getByText(/Reading transcripts/)).toBeTruthy();
    expect(spend()).toBeNull();
  });

  it("says so when the host could not read the transcripts", () => {
    render1(mkCard(), undefined, undefined, null);
    expect(screen.getByText(/Couldn't read/)).toBeTruthy();
    expect(spend()).toBeNull();
  });

  // The invariant the card's tests existed to protect, relocated: a run that was
  // measured and genuinely cost nothing must not look like one still being read.
  it("distinguishes a genuine zero from an unread run", () => {
    render1(mkCard(), undefined, undefined, totals());
    expect(screen.getByText("No recorded usage")).toBeTruthy();
    expect(screen.queryByText(/Reading transcripts/)).toBeNull();
    expect(spend()).toBeNull();
  });

  it("breaks the four token classes out, each with its raw count", () => {
    render1(mkCard(), undefined, undefined,
      totals({ input: 1_234, output: 5_678, cacheWrite: 90_123, cacheRead: 4_567_890 }));
    const rows = Array.from(spend()!.querySelectorAll(".sp-row")).map((el) => ({
      k: el.querySelector(".sp-k")!.textContent,
      v: el.querySelector(".sp-v")!.textContent,
    }));
    expect(rows.map((r) => r.k)).toEqual(["input", "output", "cache write", "cache read", "weighted"]);
    expect(rows[0].v).toBe("1,234");
    expect(rows[1].v).toBe("5,678");
    expect(rows[2].v).toBe("90,123");
    expect(rows[3].v).toBe("4,567,890");
  });

  it("labels the weighted total eq, never tok", () => {
    render1(mkCard(), undefined, undefined, totals({ cacheRead: 3_804_000 }));
    const tot = spend()!.querySelector(".sp-tot")!;
    // weightedEq({cacheRead: 3_804_000}) = 380,400 → formatEq → "380k"
    expect(tot.querySelector(".sp-v")!.textContent).toContain("380k");
    // Pinned on the unit element itself: asserting merely "no /tok/ anywhere" kept
    // passing with the unit span deleted outright, since deleting it introduces no
    // "tok" either. Same rot that was found on the card version of this test.
    expect(tot.querySelector(".u")!.textContent).toBe("eq");
    expect(screen.queryByText(/\btok\b/)).toBeNull();
  });

  // The weighted total is deliberately NOT the sum of the rows above it: cache
  // reads are ~96.7% of raw tokens at a tenth the rate, so a raw sum would rank
  // tasks by conversation length rather than by cost.
  it("does not print the weighted total as the raw sum of its rows", () => {
    render1(mkCard(), undefined, undefined, totals({ output: 1_000_000, cacheRead: 1_000_000 }));
    const tot = spend()!.querySelector(".sp-tot .sp-v")!.textContent;
    // raw sum would be 2,000,000 → "2.0M"; weighted is 1_000_000*5 + 1_000_000*0.1 = 5,100,000
    expect(tot).toContain("5.1M");
  });
});
