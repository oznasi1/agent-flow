// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as React from "react";
import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// This repo's pinned jsdom has no PointerEvent constructor. Without it, a
// fireEvent.pointer* call falls through to a bare Event with no clientX, and
// every drag assertion in the "resizing" describe below would see NaN. jsdom's
// MouseEvent does honour clientX via its init dict, so a thin PointerEvent-
// shaped subclass of it is enough for the resize handlers under test, which
// only read that one field. Same polyfill OrchestratorDrawer.test.tsx already
// carries for its own grip's drag tests — duplicated rather than shared for
// now, alongside the ~45 lines of resize wiring itself that the two drawers
// don't yet share (a recorded, deliberately deferred follow-up).
if (typeof window !== "undefined" && !window.PointerEvent) {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    constructor(type: string, params: MouseEventInit & { pointerId?: number; pointerType?: string } = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 0;
      this.pointerType = params.pointerType ?? "mouse";
    }
  }
  // @ts-expect-error — jsdom's lib.dom types still declare PointerEvent even though
  // the runtime lacks it, so this assignment looks redundant to tsc; it is not.
  window.PointerEvent = PointerEventPolyfill;
}

// Same shape OrchestratorDrawer.test.tsx mocks vscodeApi with: `getState`/
// `setState` are real spies (not just `send`), so the resizing tests below can
// assert exactly what gets persisted and under which key — the whole point of
// the two-drawer, two-key hazard this module exists to prevent.
vi.mock("../../src/webview/vscodeApi", () => ({
  send: vi.fn(),
  vscodeApi: { getState: vi.fn(() => undefined), setState: vi.fn() },
}));

import { DeckDetail, type DeckDetailProps } from "../../src/webview/DeckDetail";
import { DECK_CSS } from "../../src/webview/deckStyles";
import { send, vscodeApi } from "../../src/webview/vscodeApi";
import type { DeckCard } from "../../src/webview/deckCards";
import type { FlowTemplate, PrEntryMap, PrFacts, RunStatus } from "../../src/types";
import type { UsageTotals } from "../../src/engine/usage";
import type { Flow, FlowEdge, FlowNode } from "../../src/engine/orchestrator/model";

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
      key: "PROJ-1", summary: "Export fails", url: "https://jira/PROJ-1", createdAt: 1,
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
//
// `wf` is a 5th, optional positional covering the workflow-block props Task 11
// added: every one of this file's 60-odd pre-existing calls omits it, which is
// what proves "ships inert" — `orchEnabled` defaults false here exactly as it
// does on a real install, and none of those tests had to change to keep the
// Workflow section absent.
const render1 = (
  card: DeckCard,
  onClose = vi.fn(),
  onForget = vi.fn(),
  usage?: UsageTotals | null,
  wf: Partial<Pick<DeckDetailProps, "flows" | "templates" | "runs" | "branchCi" | "orchEnabled" | "onOpenWorkflow">> = {},
) =>
  render(<DeckDetail
    card={card} sourceLabel="Jira" usage={usage} onClose={onClose} onForget={onForget}
    flows={wf.flows ?? []}
    templates={wf.templates ?? []}
    runs={wf.runs ?? []}
    branchCi={wf.branchCi ?? {}}
    orchEnabled={wf.orchEnabled ?? false}
    onOpenWorkflow={wf.onOpenWorkflow ?? vi.fn()}
  />);

// Same minimal fixture shapes test/unit/engine/orchestrator/attach.test.ts and
// workflowBlock.test.tsx already use: a place feeding a notify terminal is
// enough for every rule this file's own tests read.
const place = (id: string, runKey: string): FlowNode =>
  ({ id, x: 0, y: 0, join: "any", kind: "place", runKey, repo: "svc" });
const notify = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "notify", message: "" });
const edge = (over: Partial<FlowEdge> & { id: string }): FlowEdge =>
  ({ from: "n1", to: "n2", cond: { kind: "pr-merged" }, ...over });

const shipItOn = (runKey: string, over: Partial<Flow> = {}): Flow => ({
  id: "f1", name: "Ship it", armed: true, createdAt: 100,
  nodes: [place("n1", runKey), notify("n2")],
  edges: [edge({ id: "e1" })],
  ...over,
});

const shipItTemplate: FlowTemplate = {
  schema: 1, id: "k1", name: "Ship it", params: {}, savedAt: 0,
  flow: { id: "", name: "Ship it", armed: false, createdAt: 0,
    nodes: [{ id: "n1", x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: ["svc"], mode: "plan", dest: "worktree" }],
    edges: [] },
};
const reviewOnlyTemplate: FlowTemplate = {
  schema: 1, id: "k2", name: "Review only", params: {}, savedAt: 0,
  flow: { id: "", name: "Review only", armed: false, createdAt: 0,
    nodes: [{ id: "n1", x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: ["svc"], mode: "plan", dest: "worktree" }],
    edges: [] },
};

/** A real, posed-and-unanswered gate — same shape
 * test/unit/engine/orchestrator/attach.test.ts's own `withGate` builds — for
 * the one test below that needs a genuine `waiting-on-you` status rather than
 * a hand-built `WorkflowState`. */
const gateNode = (id: string): FlowNode => ({ id, x: 0, y: 0, join: "any", kind: "gate", question: "Proceed?" });
const withGateOn = (runKey: string): Flow => ({
  id: "f1", name: "Ship it", armed: true, createdAt: 100,
  nodes: [place("n1", runKey), gateNode("g1"), notify("n2")],
  edges: [
    edge({ id: "e-ask", from: "n1", to: "g1", performed: true, firedAt: 1, firedNote: "asked" }),
    edge({ id: "e-gate", from: "g1", to: "n2", cond: { kind: "gate-approved" } }),
  ],
});

/** `render1` with the onClose/onForget/usage positionals left at their
 * defaults — every test below is only ever exercising the Workflow section. */
const renderWf = (
  card: DeckCard,
  wf: Partial<Pick<DeckDetailProps, "flows" | "templates" | "runs" | "branchCi" | "orchEnabled" | "onOpenWorkflow">>,
) => render1(card, undefined, undefined, undefined, wf);

/** A card whose run key is `key` — every test below binds a workflow by run
 * key, and `mkCard`'s own default ("PROJ-1") is never it. Same
 * override-the-nested-run idiom this file's own `mkCard` callers already use
 * (see the "explore-tenant-config" and "local-abc" cases above). */
const cardWithKey = (key: string, over: Partial<RunStatus> = {}): DeckCard =>
  mkCard({ run: { ...mkCard().status.run, key }, ...over });

// Copy, per-repo diffs, the spend table and Forget/Track it all moved behind
// the `More` disclosure — its body renders only once open (see DeckDetail.tsx's
// own comment on why it does not lean on the browser's native
// `details:not([open])` hiding, which jsdom does not implement anyway). The
// `toggle` event fires asynchronously even in jsdom, so this needs a real
// `waitFor`, never a bare click-then-assert — the same rule this file's own
// header comment already states for an async `FileReader` post.
// Waits for "Spend" specifically, not the `<details>`'s own `open` attribute:
// the browser sets that attribute as part of the click's default action, a
// tick BEFORE the "toggle" event (which is what actually flips `moreOpen` and
// renders the body) fires — waiting on the attribute alone was found to
// resolve before React had re-rendered, leaving the body still absent. Spend's
// own heading is unconditional inside the body, so it is there the instant the
// body renders at all, whatever the card's own PR/local/tracked state.
const openMore = async () => {
  fireEvent.click(screen.getByRole("button", { name: /^More/ }));
  await waitFor(() => expect(screen.getByText("Spend")).toBeTruthy());
};

describe("DeckDetail", () => {
  it("names the run in its header", () => {
    render1(mkCard());
    const hd = document.querySelector(".dd-hd")!;
    expect(hd.textContent).toContain("PROJ-1");
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
    expect(document.querySelector(".dd-hd .k")!.getAttribute("title")).toBe("PROJ-1");
  });

  it("relocates the branch, launched time and repo chips", () => {
    render1(mkCard());
    expect(document.querySelector(".dd .c-branch .bn")!.textContent).toContain("feat/x");
    expect(document.querySelector(".dd .c-repos .repo")!.textContent).toContain("svc");
  });

  // Work is a single-line fact strip now: the "Work" label shares its row with
  // the branch/elapsed line instead of heading a block of rows above it.
  it("renders Work as a single-line strip — the label shares the branch/elapsed row", () => {
    render1(mkCard());
    const strip = document.querySelector(".dd-strip")!;
    expect(strip.querySelector(".dd-lbl")!.textContent).toBe("Work");
    expect(strip.querySelector(".c-branch .bn")!.textContent).toContain("feat/x");
    expect(strip.querySelector(".c-branch .elapsed")).toBeTruthy();
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
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "PROJ-1", action: "open" });
  });

  // Per-repo diffs moved into `More` — the plain "Diff" promoted above the fold
  // stays scoped to the whole task, exactly as "Diff — all repos" always was.
  it("scopes a per-repo diff to that repo", async () => {
    const card = mkCard({
      repos: [
        { name: "svc", path: "/r/svc", branch: "feat/x", dirty: false, ahead: 0, added: 1, removed: 0, files: 1 },
        { name: "web", path: "/r/web", branch: "feat/x", dirty: false, ahead: 0, added: 2, removed: 0, files: 1 },
      ],
    });
    render1(card);
    await openMore();
    fireEvent.click(screen.getByRole("button", { name: /diff — web/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:inspect", key: "PROJ-1", action: "diff", repo: "web" });
  });

  it("offers no per-repo diff on a single-repo card — the all-repos one already is it", async () => {
    render1(mkCard());
    await openMore();
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

  // The lead PR's own failing checks stay in `More` — `Open PR` itself is
  // promoted, but the per-check links never had a promoted equivalent even
  // before this rebuild.
  it("links each failing check by name", async () => {
    render1(mkCard({
      prs: { svc: { facts: facts({ ci: { passing: 0, pending: 0, failing: [{ name: "e2e", url: "https://ci/e2e" }] } }), fetchedAt: 1 } } as PrEntryMap,
    }));
    await openMore();
    fireEvent.click(screen.getByRole("button", { name: /open failing check — e2e/i }));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://ci/e2e" });
  });

  it("offers no action for a failing check with no url — there is nothing to open", async () => {
    render1(mkCard({
      prs: { svc: { facts: facts({ ci: { passing: 0, pending: 0, failing: [{ name: "lint", url: "" }] } }), fetchedAt: 1 } } as PrEntryMap,
    }));
    await openMore();
    expect(screen.queryByRole("button", { name: /open failing check — lint/i })).toBeNull();
  });

  it("copies the branch name without touching the host", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(mkCard());
    await openMore();
    fireEvent.click(screen.getByRole("button", { name: /copy branch name/i }));
    expect(writeText).toHaveBeenCalledWith("feat/x");
    expect(sent).not.toHaveBeenCalled();
  });

  it("copies the ticket key without touching the host", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(mkCard());
    await openMore();
    fireEvent.click(screen.getByRole("button", { name: /copy ticket key/i }));
    expect(writeText).toHaveBeenCalledWith("PROJ-1");
    expect(sent).not.toHaveBeenCalled();
  });

  it("copies the PR url without touching the host", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(mkCard({ prs: { svc: { facts: facts({ url: "https://gh/pr/77" }), fetchedAt: 1 } } as PrEntryMap }));
    await openMore();
    fireEvent.click(screen.getByRole("button", { name: /copy pr url/i }));
    expect(writeText).toHaveBeenCalledWith("https://gh/pr/77");
    expect(sent).not.toHaveBeenCalled();
  });

  it("copies the worktree path without touching the host", async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(mkCard());
    await openMore();
    fireEvent.click(screen.getByRole("button", { name: /copy worktree path/i }));
    expect(writeText).toHaveBeenCalledWith("/r/svc");
    expect(sent).not.toHaveBeenCalled();
  });

  it("forgets through the callback, not a raw post", async () => {
    const onForget = vi.fn();
    render1(mkCard(), vi.fn(), onForget);
    await openMore();
    fireEvent.click(screen.getByRole("button", { name: /^forget$/i }));
    expect(onForget).toHaveBeenCalledWith("PROJ-1");
  });

  it("offers Track it instead of Forget on a local card", async () => {
    render1(mkCard({ run: { ...mkCard().status.run, key: "local-abc", url: "", kind: "local" } as never }));
    await openMore();
    expect(screen.queryByRole("button", { name: /^forget$/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /track it/i }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:track", key: "local-abc" });
  });

  // The "N actions" counter is gone outright — `More`'s own summary names what
  // it holds instead of counting it.
  it("no longer prints an action count", () => {
    render1(mkCard());
    expect(screen.queryByText(/\d+ actions/)).toBeNull();
    expect(document.querySelector(".dd-count")).toBeNull();
  });

  it("promotes exactly four actions above the fold, in order", () => {
    render1(mkCard({ prs: { svc: { facts: facts({ number: 482 }), fetchedAt: 1 } } as PrEntryMap }));
    const promoted = screen.getByRole("group", { name: "Actions" });
    expect(within(promoted).getAllByRole("button").map((b) => b.textContent))
      .toEqual(["Open workspace", "Open PR #482", "Diff", "Address PR"]);
  });

  it("opens the lead PR externally from the promoted button", () => {
    render1(mkCard({ prs: { svc: { facts: facts({ number: 482, url: "https://gh/pr/482" }), fetchedAt: 1 } } as PrEntryMap }));
    fireEvent.click(screen.getByRole("button", { name: "Open PR #482" }));
    expect(sent).toHaveBeenCalledWith({ type: "openExternal", url: "https://gh/pr/482" });
  });

  // Fewer than four apply when there is no PR and no review to address: Open
  // workspace and Diff are unconditional, so those are the floor.
  it("promotes only what applies when there is no PR and nothing to address", () => {
    render1(mkCard({ column: "progress" }));
    const promoted = screen.getByRole("group", { name: "Actions" });
    expect(within(promoted).getAllByRole("button").map((b) => b.textContent))
      .toEqual(["Open workspace", "Diff"]);
  });

  it("hides every remaining action behind one disclosure", async () => {
    render1(mkCard());
    expect(screen.queryByText("Copy branch name")).toBeNull();
    await openMore();
    expect(screen.getByText("Copy branch name")).toBeTruthy();
  });

  // `role="button"` on the summary is needed for it to be queryable as one at
  // all (neither jsdom's nor a screen reader's role mapping treats a bare
  // `<summary>` as a button), but overriding the role also throws away its
  // native expanded/collapsed state — `aria-expanded` puts that back.
  it("reports its open state via aria-expanded on the summary", async () => {
    render1(mkCard());
    const more = screen.getByRole("button", { name: /^More/ });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await openMore();
    expect(more).toHaveAttribute("aria-expanded", "true");
  });

  // Enumerated on purpose: `More` is a disclosure, not a deletion. This test is
  // what stops a rebuild quietly dropping an affordance somebody used. Built
  // from what the drawer actually offers today (read off DeckDetail.tsx and
  // this file's own fixtures) — four of the old dozen (Open workspace, Diff —
  // all repos' promoted stand-in "Diff", Address PR, Open PR) moved above the
  // fold instead of into `More`, and are checked there via the two tests above
  // rather than repeated here, since a promoted button and a `More` row for
  // the very same action would give `getByRole` two matches for one name.
  it("keeps every action the old drawer had reachable", async () => {
    const { container } = render1(mkCard({ prs: { svc: { facts: facts({ number: 482 }), fetchedAt: 1 } } as PrEntryMap }));
    // Promoted, not in `More` — reachable already, before any click.
    for (const label of ["Open workspace", "Diff", "Open PR #482", "Address PR"]) {
      expect(within(container).getByRole("button", { name: label })).toBeTruthy();
    }
    await openMore();
    for (const label of [
      "Open in Jira", "Copy branch name", "Copy ticket key", "Copy PR url",
      "Copy worktree path", "Forget",
    ]) {
      await waitFor(() => expect(screen.getByRole("button", { name: label })).toBeTruthy());
    }
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
    expect(k.textContent).toBe("PROJ-1");
    expect(k.getAttribute("title")).toBe("PROJ-1");
  });
});

// The parent's drawer is where a run's child worktrees surface — they have no
// sessions of their own, so they get no card, only a row here.
describe("child worktrees", () => {
  const children = [
    { key: "PROJ-2", summary: "first bit", repo: "webapp", path: "/repos/webapp/.claude/worktrees/PROJ-2", branch: "PROJ-2-first-bit" },
    { key: "PROJ-3", summary: "second bit", repo: "webapp", path: "/repos/webapp/.claude/worktrees/PROJ-3", branch: "PROJ-3-second-bit" },
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
    expect(screen.getByText("PROJ-2")).toBeInTheDocument();
    expect(screen.getByText("first bit")).toBeInTheDocument();
    expect(screen.getByTitle("/repos/webapp/.claude/worktrees/PROJ-2")).toBeInTheDocument();
  });

  it("names the branch each child is on", () => {
    render1(withChildren(children));
    expect(screen.getByText("⎇ PROJ-2-first-bit")).toBeInTheDocument();
  });

  it("copies a child's worktree path on click", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render1(withChildren(children));
    fireEvent.click(screen.getByRole("button", { name: "Copy PROJ-2 worktree path in webapp" }));
    expect(writeText).toHaveBeenCalledWith("/repos/webapp/.claude/worktrees/PROJ-2");
  });

  it("renders one row per repo when a child spans two, each with its own accessible name", () => {
    // The repo has to be in the accessible name, not just the key: without it,
    // two rows for the same ticket key are indistinguishable to a screen reader
    // (and getByRole below would throw on an ambiguous match instead of finding
    // either one).
    render1(withChildren([
      children[0],
      { ...children[0], repo: "frontend", path: "/repos/frontend/.claude/worktrees/PROJ-2" },
    ]));
    expect(screen.getAllByText("PROJ-2")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Copy PROJ-2 worktree path in webapp" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy PROJ-2 worktree path in frontend" })).toBeInTheDocument();
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
    expect(bn.textContent).toBe("⎇ PROJ-2-first-bit");
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

  // The scroll/clip rule lives on `.dd-scroll` now, not `.dd` itself — `.dd`
  // carries only width, so the resize grip (a sibling of `.dd-scroll`,
  // positioned relative to `.dd`) is never clipped by this overflow rule or
  // carried away when the scrollable content scrolls.
  it("gives the drawer vertical scroll only", () => {
    const dd = block(".dd-scroll");
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

  // Spend moved a second time, into `More` alongside Copy, per-repo diffs and
  // Forget — every case here opens the disclosure first, since none of this
  // text exists in the DOM until it does (see DeckDetail.tsx's own comment on
  // why the body renders only while open, rather than leaning on the
  // browser's native `details:not([open])` hiding).
  it("reads as still-loading before the host answers", async () => {
    render1(mkCard(), undefined, undefined, undefined);
    await openMore();
    expect(screen.getByText(/Reading transcripts/)).toBeTruthy();
    expect(spend()).toBeNull();
  });

  it("says so when the host could not read the transcripts", async () => {
    render1(mkCard(), undefined, undefined, null);
    await openMore();
    expect(screen.getByText(/Couldn't read/)).toBeTruthy();
    expect(spend()).toBeNull();
  });

  // The invariant the card's tests existed to protect, relocated: a run that was
  // measured and genuinely cost nothing must not look like one still being read.
  it("distinguishes a genuine zero from an unread run", async () => {
    render1(mkCard(), undefined, undefined, totals());
    await openMore();
    expect(screen.getByText("No recorded usage")).toBeTruthy();
    expect(screen.queryByText(/Reading transcripts/)).toBeNull();
    expect(spend()).toBeNull();
  });

  it("breaks the four token classes out, each with its raw count", async () => {
    render1(mkCard(), undefined, undefined,
      totals({ input: 1_234, output: 5_678, cacheWrite: 90_123, cacheRead: 4_567_890 }));
    await openMore();
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

  it("labels the weighted total eq, never tok", async () => {
    render1(mkCard(), undefined, undefined, totals({ cacheRead: 3_804_000 }));
    await openMore();
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
  it("does not print the weighted total as the raw sum of its rows", async () => {
    render1(mkCard(), undefined, undefined, totals({ output: 1_000_000, cacheRead: 1_000_000 }));
    await openMore();
    const tot = spend()!.querySelector(".sp-tot .sp-v")!.textContent;
    // raw sum would be 2,000,000 → "2.0M"; weighted is 1_000_000*5 + 1_000_000*0.1 = 5,100,000
    expect(tot).toContain("5.1M");
  });
});

// Modeled on OrchestratorDrawer.test.tsx's own "resizing" describe (same shape,
// same drawerResize.ts arithmetic underneath) — none of it needs a real drag,
// only fireEvent's pointer/keyboard events and a manual act() around the
// move+up pair, the same split that file uses so the resize effect's window
// listeners are attached before the move they need to observe.
//
// The one real difference from that file's version: this drawer writes its
// live width onto `document.documentElement`, not an inline style on its own
// element (see deckStyles.ts's own comment on `.dd` for why — `.board.dd-open`
// is a sibling of the drawer in DeckApp.tsx, not its descendant, and a custom
// property only cascades to descendants of wherever it's declared). `widthOf`
// below reads it from there.
describe("resizing", () => {
  const grip = () => screen.getByRole("separator", { name: /resize/i });
  const widthOf = () => document.documentElement.style.getPropertyValue("--dd-w");

  it("exposes the grip as a focusable vertical separator", () => {
    render1(mkCard());
    const g = grip();
    expect(g).toHaveAttribute("aria-orientation", "vertical");
    expect(g.tabIndex).toBe(0);
  });

  it("starts at the 620px default when nothing is stored", () => {
    render1(mkCard());
    expect(widthOf()).toBe("620px");
  });

  it("writes the live width onto document.documentElement so a sibling of the drawer (.board) can read it too", () => {
    render1(mkCard());
    expect(document.documentElement.style.getPropertyValue("--dd-w")).toBe("620px");
  });

  it("removes --dd-w from document.documentElement once the drawer unmounts", () => {
    const { unmount } = render1(mkCard());
    expect(widthOf()).toBe("620px");
    unmount();
    expect(document.documentElement.style.getPropertyValue("--dd-w")).toBe("");
  });

  it("dragging the grip changes the width", () => {
    render1(mkCard());
    fireEvent.pointerDown(grip(), { clientX: 300 });
    act(() => {
      // Left border pulled 40px further left grows the (right-anchored) drawer
      // by 40px: 620 + (300 - 260) = 660.
      fireEvent.pointerMove(window, { clientX: 260 });
      fireEvent.pointerUp(window);
    });
    expect(widthOf()).toBe("660px");
  });

  it("persists the width via vscodeApi.setState once the drag ends, under ddWidth", () => {
    render1(mkCard());
    fireEvent.pointerDown(grip(), { clientX: 300 });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 260 });
      fireEvent.pointerUp(window);
    });
    expect(vscodeApi.setState).toHaveBeenCalledWith({ ddWidth: 660 });
  });

  // The precise hazard drawerResize.ts's merge exists to prevent: this
  // drawer's own resize must never clobber the Orchestrator drawer's
  // "orchWidth", stored in the same shared webview state object.
  it("merges into existing state rather than clobbering the Orchestrator drawer's own width", () => {
    // Two `.mockReturnValueOnce` rather than one `.mockReturnValue`, deliberately:
    // this component calls `getState` exactly twice (the initial `read()` at
    // mount, then `persist()`'s own internal read-before-merge) — scoping the
    // stub to exactly those two calls keeps `vscodeApi.getState`'s default
    // `() => undefined` in effect for every OTHER test in this file. A bare
    // `mockReturnValue` here was found to leak `orchWidth` into the very next
    // test below, since `clearMocks` (vitest.config.ts) resets call history but
    // not a scripted return value.
    vi.mocked(vscodeApi.getState)
      .mockReturnValueOnce({ orchWidth: 560 })
      .mockReturnValueOnce({ orchWidth: 560 });
    render1(mkCard());
    fireEvent.keyDown(grip(), { key: "ArrowLeft" });
    expect(vscodeApi.setState).toHaveBeenCalledWith({ orchWidth: 560, ddWidth: 636 });
  });

  it("clamps the width at the floor", () => {
    render1(mkCard());
    fireEvent.pointerDown(grip(), { clientX: 300 });
    act(() => {
      // Dragged hugely toward "narrower" — far past the 460px floor.
      fireEvent.pointerMove(window, { clientX: 900 });
      fireEvent.pointerUp(window);
    });
    expect(widthOf()).toBe("460px");
  });

  // The ceiling is read from window.innerWidth at drag time, so this shrinks
  // the viewport to 900 first (ceiling = max(460, 900 - 340) = 560, distinct
  // from the 460px floor) then drags hugely toward "wider".
  it("clamps the width at the ceiling, derived from the viewport", () => {
    render1(mkCard());
    const prevWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    try {
      fireEvent.pointerDown(grip(), { clientX: 300 });
      act(() => {
        fireEvent.pointerMove(window, { clientX: -900 });
        fireEvent.pointerUp(window);
      });
      expect(widthOf()).toBe("560px");
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: prevWidth });
    }
  });

  it("resizes with arrow keys — ArrowLeft grows, ArrowRight shrinks", () => {
    render1(mkCard());
    fireEvent.keyDown(grip(), { key: "ArrowLeft" });
    expect(widthOf()).toBe("636px");
    fireEvent.keyDown(grip(), { key: "ArrowRight" });
    fireEvent.keyDown(grip(), { key: "ArrowRight" });
    expect(widthOf()).toBe("604px");
    expect(vscodeApi.setState).toHaveBeenLastCalledWith({ ddWidth: 604 });
  });

  it("ignores keys other than the two arrow keys", () => {
    render1(mkCard());
    fireEvent.keyDown(grip(), { key: "Enter" });
    expect(widthOf()).toBe("620px");
  });

  it("honours a stored width from a previous session on mount", () => {
    vi.mocked(vscodeApi.getState).mockReturnValueOnce({ ddWidth: 650 });
    render1(mkCard());
    expect(widthOf()).toBe("650px");
  });

  it("falls back to the default width when the stored value is corrupt", () => {
    // A future version's shape, or a hand-edited value — either way, not the
    // number this version expects.
    vi.mocked(vscodeApi.getState).mockReturnValueOnce({ ddWidth: "wide" } as never);
    expect(() => render1(mkCard())).not.toThrow();
    expect(widthOf()).toBe("620px");
  });

  it("falls back to the default width when getState itself throws", () => {
    vi.mocked(vscodeApi.getState).mockImplementationOnce(() => {
      throw new Error("state store unavailable");
    });
    expect(() => render1(mkCard())).not.toThrow();
    expect(widthOf()).toBe("620px");
  });

  it("does not throw when persisting the width fails", () => {
    vi.mocked(vscodeApi.setState).mockImplementationOnce(() => {
      throw new Error("state store unavailable");
    });
    render1(mkCard());
    expect(() => fireEvent.keyDown(grip(), { key: "ArrowLeft" })).not.toThrow();
  });
});

describe("DeckDetail — Workflow section", () => {
  it("shows the workflow bound to this card", () => {
    renderWf(cardWithKey("PROJ-142"), { flows: [shipItOn("PROJ-142")], orchEnabled: true });
    // Paired with the inert test's own `queryByText("Workflow")` assertion —
    // without a positive counterpart somewhere, a heading rename could still
    // pass that test for the wrong reason.
    expect(screen.getByText("Workflow")).toBeTruthy();
    expect(screen.getByText("Ship it")).toBeTruthy();
  });

  it("shows no Workflow section at all when the orchestrator is off", () => {
    // New behaviour ships inert: agentFlow.orchestrator defaults to false, and
    // this whole surface — the "Workflow" heading, the block, the chip — must
    // be invisible, not merely un-armed.
    renderWf(cardWithKey("PROJ-142"), { flows: [shipItOn("PROJ-142")], orchEnabled: false });
    expect(screen.queryByText("Workflow")).toBeNull();
    expect(screen.queryByText("Ship it")).toBeNull();
  });

  it("picks the workflow that most needs a human when two bind the card", () => {
    const stopped: Flow = {
      ...shipItOn("PROJ-142"), id: "f-stop", name: "Hotfix", createdAt: 200,
      edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" }, error: "exit 1" }],
    };
    renderWf(cardWithKey("PROJ-142"), { flows: [shipItOn("PROJ-142"), stopped], orchEnabled: true });
    expect(screen.getByText("Hotfix")).toBeTruthy();
    expect(screen.getByText("+1 more")).toBeTruthy();
    expect(screen.queryByText("Ship it")).toBeNull();
  });

  it("shows the attach picker's trigger, and no picker, before it is opened", () => {
    renderWf(cardWithKey("PROJ-142"), { flows: [], templates: [shipItTemplate], orchEnabled: true });
    expect(screen.getByText("No workflow attached")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Choose a template for PROJ-142…")).toBeNull();
  });

  it("attaching sends flow:attach with the card's run key", async () => {
    renderWf(cardWithKey("PROJ-142"), { flows: [], templates: [shipItTemplate], orchEnabled: true });
    await userEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
    await userEvent.click(await screen.findByRole("button", { name: "Ship it" }));
    await waitFor(() => expect(sent).toHaveBeenCalledWith(
      { type: "flow:attach", runKey: "PROJ-142", templateId: "k1" },
    ));
  });

  it("the picker filters by name", async () => {
    renderWf(cardWithKey("PROJ-142"), { flows: [], templates: [shipItTemplate, reviewOnlyTemplate], orchEnabled: true });
    await userEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
    await userEvent.type(screen.getByPlaceholderText("Choose a template for PROJ-142…"), "review");
    await waitFor(() => expect(screen.queryByText("Ship it")).toBeNull());
    expect(screen.getByText("Review only")).toBeTruthy();
  });

  it("names a local card's inferred ticket in the picker's placeholder", async () => {
    // A local card's run key is a worktree slug, not a ticket — the picker asks
    // about the INFERRED ticket key (see DeckDetail.tsx's `boundTicketKey`),
    // same as `attachedWorkflows` itself binds a planned node by.
    renderWf(
      cardWithKey("local-fix-export", { run: { ...mkCard().status.run, key: "local-fix-export", url: "", kind: "local" } as never,
        inferredTicketKey: "PROJ-9" }),
      { flows: [], templates: [shipItTemplate], orchEnabled: true },
    );
    await userEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
    expect(screen.getByPlaceholderText("Choose a template for PROJ-9…")).toBeTruthy();
  });

  it("closes the picker without sending anything when cancelled", async () => {
    renderWf(cardWithKey("PROJ-142"), { flows: [], templates: [shipItTemplate], orchEnabled: true });
    await userEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("Choose a template for PROJ-142…")).toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });

  it("closes the picker on Escape too, and stops the key there", () => {
    // `DeckApp.test.tsx` has the full regression (Escape must not also close
    // the surrounding card drawer, since `DeckApp` listens for the same key on
    // `window`) — this is the narrower claim this file alone can prove: the
    // picker's own handler treats Escape as ITS dismissal and calls
    // `stopPropagation` rather than leaving the event to bubble untouched.
    renderWf(cardWithKey("PROJ-142"), { flows: [], templates: [shipItTemplate], orchEnabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
    const input = screen.getByPlaceholderText("Choose a template for PROJ-142…");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(event, "stopPropagation");
    fireEvent(input, event);
    expect(stopSpy).toHaveBeenCalled();
    expect(screen.queryByPlaceholderText("Choose a template for PROJ-142…")).toBeNull();
  });

  it("closes the picker when the selected card changes under it", () => {
    // `DeckApp.tsx` never remounts this component on a card switch (see
    // `DeckDetailProps.closing`'s own doc comment), so `pickerOpen` would
    // otherwise survive from card A onto card B — still open, re-placeholdered
    // for B, and a pick would attach to the card the user is now looking at
    // rather than the one they meant to when they opened it.
    const result = renderWf(cardWithKey("PROJ-142"), { flows: [], templates: [shipItTemplate], orchEnabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Attach workflow…" }));
    expect(screen.getByPlaceholderText("Choose a template for PROJ-142…")).toBeTruthy();
    result.rerender(<DeckDetail
      card={cardWithKey("PROJ-9")} sourceLabel="Jira" onClose={vi.fn()} onForget={vi.fn()}
      flows={[]} templates={[shipItTemplate]} runs={[]} branchCi={{}} orchEnabled onOpenWorkflow={vi.fn()}
    />);
    expect(screen.queryByPlaceholderText("Choose a template for PROJ-142…")).toBeNull();
    expect(screen.queryByPlaceholderText("Choose a template for PROJ-9…")).toBeNull();
  });

  it("Arm sends flow:arm for this card's own workflow id", async () => {
    const disarmed = shipItOn("PROJ-142", { armed: false });
    renderWf(cardWithKey("PROJ-142"), { flows: [disarmed], orchEnabled: true });
    await userEvent.click(screen.getByRole("button", { name: "Arm" }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:arm", id: "f1", armed: true });
  });

  it("Detach sends flow:detach for this card's own workflow id", async () => {
    const done = shipItOn("PROJ-142", { edges: [edge({ id: "e1", firedAt: 1, firedNote: "ran" })] });
    renderWf(cardWithKey("PROJ-142"), { flows: [done], orchEnabled: true });
    await userEvent.click(screen.getByRole("button", { name: "Detach" }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:detach", id: "f1" });
  });

  it("Approve sends flow:answerGate for this card's own workflow id", async () => {
    renderWf(cardWithKey("PROJ-142"), { flows: [withGateOn("PROJ-142")], orchEnabled: true });
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:answerGate", id: "f1", edgeId: "e-gate", answer: "approved" });
  });

  it("Reset sends flow:resetEdge for this card's own workflow id", async () => {
    const stopped = shipItOn("PROJ-142", { edges: [edge({ id: "e1", error: "exit 1" })] });
    renderWf(cardWithKey("PROJ-142"), { flows: [stopped], orchEnabled: true });
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(sent).toHaveBeenCalledWith({ type: "flow:resetEdge", id: "f1", edgeId: "e1" });
  });

  it("Open in Workflows calls onOpenWorkflow with this card's own workflow id, sending no host message", async () => {
    const onOpenWorkflow = vi.fn();
    renderWf(cardWithKey("PROJ-142"), { flows: [shipItOn("PROJ-142")], orchEnabled: true, onOpenWorkflow });
    await userEvent.click(screen.getByRole("button", { name: "Open in Workflows ↗" }));
    expect(onOpenWorkflow).toHaveBeenCalledWith("f1");
    expect(sent).not.toHaveBeenCalled();
  });
});
