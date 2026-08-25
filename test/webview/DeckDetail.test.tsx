// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("../../src/webview/vscodeApi", () => ({ send: vi.fn() }));

import { DeckDetail } from "../../src/webview/DeckDetail";
import { DECK_CSS } from "../../src/webview/deckStyles";
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
    column: status.column, lane: null };
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

  it("opens with the same mark the card does, so the two read as one object", () => {
    render1(mkCard({ run: { ...mkCard().status.run, key: "explore-tenant-config", kind: "explore" } }));
    const hd = document.querySelector(".dd-hd")!;
    // First thing in the header, same class as the card's own avatar: a selected card
    // and its drawer must not look like two different objects. Read through .dd-id —
    // the header is two rows now (identity, then the title) and the mark leads the
    // first — but it is still the first thing in the header, which is the point.
    expect(hd.firstElementChild!.className).toBe("dd-id");
    expect(hd.querySelector(".dd-id")!.firstElementChild!.className).toBe("av k-explore");
    expect(hd.querySelector(".av")!.getAttribute("aria-label")).toBe("Explore place");
  });

  it("opens the drawer with the same mark the card carries", () => {
    render1(mkCard({ provider: "claude-code" }));
    expect(document.querySelector(".dd-hd .pv.p-claude-code")).toBeTruthy();
  });

  // The reported bug: at 460px a long title shared the header row with the status
  // pill, both shrank, and neither was readable. The title now owns the row below the
  // identity — these assert the structure that makes that true, since jsdom does no
  // layout and cannot see the widths themselves.
  it("puts the title on its own row, below the identity", () => {
    const long = "[spike] Plan the EDR asset type — map the classification pipeline end to end";
    render1(mkCard({ run: { ...mkCard().status.run, summary: long }, ticketStatus: "Ready for Dev" }));
    const hd = document.querySelector(".dd-hd")!;
    // Two rows, in this order: everything that names the run, then the title.
    expect([...hd.children].map((c) => c.className)).toEqual(["dd-id", "t"]);
    // The key, the status and the close button share the first — not the title.
    const id = hd.querySelector(".dd-id")!;
    expect(id.querySelector(".k")).toBeTruthy();
    expect(id.querySelector(".pill")!.textContent).toBe("Ready for Dev");
    expect(id.querySelector(".dd-x")).toBeTruthy();
    expect(id.querySelector(".t")).toBeNull();
    // In full. A title is never shortened on the way into the DOM — the old header
    // relied on CSS to cut it, and the whole point of the second row is that nothing
    // has to.
    expect(hd.querySelector(".t")!.textContent).toBe(long);
  });

  // The tooltip existed because the title was cut and hovering was the only way to
  // read the rest. It wraps now, so a tooltip would just repeat text already on screen.
  it("drops the title's tooltip, which the wrap makes redundant", () => {
    render1(mkCard());
    expect(document.querySelector(".dd-hd .t")!.hasAttribute("title")).toBe(false);
    // The key keeps its own: that one IS still truncated, at 50% of the row.
    expect(document.querySelector(".dd-hd .k")!.getAttribute("title")).toBe("ASM-1");
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

  it("offers Address PR in the In review column", () => {
    // An actual open PR behind it — canAddressPr also requires prSignals(r.prs).open,
    // which mkCard()'s default `prs: {}` does not satisfy (see the "no PR at all"
    // case below).
    const { container } = render1(mkCard({ prs: { svc: { facts: facts(), fetchedAt: 1 } } as PrEntryMap }));
    expect(within(container).getByRole("button", { name: /address pr/i })).toBeTruthy();
  });

  it("offers no Address PR in Merge — there is nothing left to address", () => {
    const { container } = render1(mkCard({
      column: "merge", prs: { svc: { facts: facts({ review: "approved" }), fetchedAt: 1 } } as PrEntryMap,
    }));
    expect(within(container).queryByRole("button", { name: /address pr/i })).toBeNull();
  });

  // A run can reach the review column off its Jira status alone (deriveBucket's
  // isReviewStatus), with no PR entries behind it at all — mkCard()'s default
  // `prs: {}` is exactly that. Without prSignals(r.prs).open in canAddressPr, the
  // button would offer to seed an agent against a PR that does not exist.
  it("offers no Address PR in In review with no PR at all (prs: {})", () => {
    const { container } = render1(mkCard());
    expect(within(container).queryByRole("button", { name: /address pr/i })).toBeNull();
  });

  it("offers no Address PR on a local card, whatever the column", () => {
    const card = mkCard({ run: { ...mkCard().status.run, key: "local-abc", url: "", kind: "local" } as never });
    const { container } = render1(card);
    expect(within(container).queryByRole("button", { name: /address pr/i })).toBeNull();
  });

  it("offers no Address PR outside the review column, open PR or not", () => {
    // DeckDetail takes a plain DeckCard and enforces nothing about how its column
    // was derived, so the column conjunct earns its own case even though
    // deriveBucket would not put an open, unblocked PR here with no live agent.
    const { container } = render1(mkCard({
      column: "progress", prs: { svc: { facts: facts(), fetchedAt: 1 } } as PrEntryMap,
    }));
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

  // A notepad key is ~64 characters of mono at 12px — 462px, wider than the drawer's
  // 436px content box. As a nowrap flex item it could not shrink, so the header row
  // pushed the whole drawer into horizontal scroll: the summary collapsed to zero
  // width, the status pill squashed, and the close button left the viewport
  // entirely. The card's own key chip has always printed the short word instead.
  it("names an untracked run by its kind rather than its unusable key", () => {
    render1(mkCard({ run: { ...mkCard().status.run, key: "notepad-fix-the-drawer-mswzvshg-41dwha", url: "", kind: "notepad" } as never }));
    const k = document.querySelector(".dd-hd .k")!;
    expect(k.textContent).toBe("notepad");
    // The full key stays reachable — the drawer is where you go to copy it.
    expect(k.getAttribute("title")).toBe("notepad-fix-the-drawer-mswzvshg-41dwha");
  });

  it("still prints a ticket key in full, with no tooltip fallback needed", () => {
    render1(mkCard());
    const k = document.querySelector(".dd-hd .k")!;
    expect(k.textContent).toBe("ASM-1");
    expect(k.getAttribute("title")).toBe("ASM-1");
  });
});

// The parent's drawer is where a run's child worktrees surface — they have no
// sessions of their own, so they get no card, only a row here.
describe("child worktrees", () => {
  const children = [
    { key: "ASM-2", summary: "first bit", repo: "centaur", path: "/repos/centaur/.claude/worktrees/ASM-2", branch: "ASM-2-first-bit" },
    { key: "ASM-3", summary: "second bit", repo: "centaur", path: "/repos/centaur/.claude/worktrees/ASM-3", branch: "ASM-3-second-bit" },
  ];

  const withChildren = (over: unknown[]) => mkCard({ run: { ...mkCard().status.run, children: over } as never });

  it("renders nothing for a run with no children field", () => {
    render1(mkCard());
    expect(screen.queryByText("Children")).not.toBeInTheDocument();
  });

  it("renders nothing for a run with an empty children array", () => {
    // Distinct from the case above, and the one that pins the `.length` guard: a
    // truthiness check would render an empty Children section here.
    render1(withChildren([]));
    expect(screen.queryByText("Children")).not.toBeInTheDocument();
  });

  it("lists a row per child worktree", () => {
    render1(withChildren(children));
    expect(screen.getByText("Children")).toBeInTheDocument();
    expect(screen.getByText("ASM-2")).toBeInTheDocument();
    expect(screen.getByText("first bit")).toBeInTheDocument();
    expect(screen.getByTitle("/repos/centaur/.claude/worktrees/ASM-2")).toBeInTheDocument();
  });

  it("names the branch each child is on", () => {
    render1(withChildren(children));
    expect(screen.getByText("⎇ ASM-2-first-bit")).toBeInTheDocument();
  });

  it("copies a child's worktree path on click", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(withChildren(children));
    fireEvent.click(screen.getByRole("button", { name: "Copy ASM-2 worktree path in centaur" }));
    expect(writeText).toHaveBeenCalledWith("/repos/centaur/.claude/worktrees/ASM-2");
  });

  it("renders one row per repo when a child spans two, each with its own accessible name", () => {
    // The repo has to be in the accessible name, not just the key: without it,
    // two rows for the same ticket key are indistinguishable to a screen reader
    // (and getByRole below would throw on an ambiguous match instead of finding
    // either one).
    render1(withChildren([
      children[0],
      { ...children[0], repo: "frontend", path: "/repos/frontend/.claude/worktrees/ASM-2" },
    ]));
    expect(screen.getAllByText("ASM-2")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Copy ASM-2 worktree path in centaur" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy ASM-2 worktree path in frontend" })).toBeInTheDocument();
  });

  // jsdom does no layout, so this cannot prove the branch chip actually shrinks
  // or ellipsizes on a real screen — only that the element the shrink-safe CSS
  // (.dd-child .bn, see deckStyles.ts) targets is really the one rendered here.
  // A future change that renamed the class without updating the CSS (or vice
  // versa) would silently reopen the drawer's known horizontal-scroll bug with
  // nothing here to catch it visually; this at least catches the wiring.
  it("puts the branch on the element the shrink-safe CSS class targets", () => {
    render1(withChildren(children));
    const bn = document.querySelector(".dd-child .bn")!;
    expect(bn).toBeInTheDocument();
    expect(bn.textContent).toBe("⎇ ASM-2-first-bit");
  });
});

// Layout guards for the same bug. jsdom does no layout, so these assert the two
// rules that make the drawer structurally incapable of scrolling sideways —
// whatever a future header, hint or PR block puts inside it.
describe("DeckDetail CSS", () => {
  const block = (selector: string): string => {
    const at = DECK_CSS.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return DECK_CSS.slice(at, DECK_CSS.indexOf("}", at));
  };

  it("gives the drawer vertical scroll only", () => {
    const dd = block(".dd");
    expect(dd).toMatch(/overflow:\s*hidden auto/);
    expect(dd).not.toMatch(/overflow:\s*auto\s*;/);
  });

  // Still capped — a nowrap flex item with no cap cannot shrink at all, since its
  // automatic minimum size is its own text width — but shrinkable past the cap now
  // that the title has left this row. Both halves matter: the cap keeps the key from
  // claiming more than half the row, and min-width:0 is what lets it give ground to
  // the pill instead of overflowing.
  it("caps the header key AND lets it shrink past the cap", () => {
    const k = block(".dd-hd .k");
    expect(k).toMatch(/max-width:\s*50%/);
    expect(k).toMatch(/text-overflow:\s*ellipsis/);
    expect(k).toMatch(/min-width:\s*0/);
  });

  // The bug this pair was written for: the title and the pill were both shrinkable, so
  // a long title split the row's shortfall between them and "Ready for Dev" came out
  // as "Read…" while the title was cut anyway. The pill is now the row's rigid item
  // and the key is the one that yields, so a status keeps its words whatever the key.
  it("lets the status pill hold its text, so the key is what yields", () => {
    const pill = block(".dd-hd .pill");
    expect(pill).toMatch(/flex:\s*none/);
    // Capped all the same: a pathological status must not squeeze the key to nothing.
    expect(pill).toMatch(/max-width:/);
  });

  // The title takes a row of its own and wraps onto as many as it needs. Asserted as
  // the absence of every truncating property, because that is the actual regression
  // risk: one `text-overflow: ellipsis` copied back onto this rule brings the bug back.
  it("wraps the title instead of ellipsizing it", () => {
    const t = block(".dd-hd .t");
    expect(t).toMatch(/white-space:\s*normal/);
    // Unbroken slugs — a notepad title is one 60-character token — must break rather
    // than run past 460px and be clipped by .dd's own overflow: hidden.
    expect(t).toMatch(/overflow-wrap:\s*anywhere/);
    expect(t).not.toMatch(/text-overflow/);
    expect(t).not.toMatch(/white-space:\s*nowrap/);
    expect(t).not.toMatch(/line-clamp/);
  });

  // A row that cannot break, and a title below it. Deliberately NOT flex-wrap on
  // .dd-hd: flexbox breaks lines from the items' unshrunk sizes, so a long key beside
  // a long status wrapped the pill and the close button onto a line of their own and
  // pushed the title to a third.
  it("keeps the identity row unwrappable", () => {
    const id = block(".dd-id");
    expect(id).toMatch(/display:\s*flex/);
    expect(id).not.toMatch(/flex-wrap/);
    expect(block(".dd-hd")).not.toMatch(/flex-wrap/);
  });

  // Same bug, same fix, on the child row: .k/.bn are flex:none (no shrink at
  // all), so without a cap they would render at their full natural width no
  // matter how long the branch name is — and .t (the summary) would be the one
  // squeezed, potentially to nothing, exactly like the header key once crushed
  // the summary beside it. The cap is what keeps a long branch chip from ever
  // taking more than its own bounded share.
  it("caps the child row's branch chip too, so a long branch name can't crush the summary beside it", () => {
    const bn = block(".dd-child .bn");
    expect(bn).toMatch(/flex:\s*none/);
    expect(bn).toMatch(/max-width:/);
    expect(bn).toMatch(/white-space:\s*nowrap/);
    expect(bn).toMatch(/text-overflow:\s*ellipsis/);
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
