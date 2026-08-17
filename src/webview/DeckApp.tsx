import * as React from "react";
import { send } from "./vscodeApi";
import { BranchCiStatus, CardAgent, DeckColumn, DeckLane, FlowCommand, FlowPromptMode, OutboundMessage, PendingResume, PrEntryMap, PrFacts, ReviewDetail, ReviewRequest, ReviewSort, RunStatus, isTicketRun, runKind } from "../types";
import { ClosedRow, ClosedStrip } from "./ClosedStrip";
import type { Flow } from "../engine/orchestrator/model";
import { DeckCard, laneOf, projectCards } from "./deckCards";
// Same import deckCards.ts makes, and safe for the same reason: bucket.ts is kept
// free of fs-touching imports, which bucket.test.ts enforces.
import { prSignals } from "../engine/bucket";
import { DRAG_SEP, OrchestratorDrawer } from "./OrchestratorDrawer";
import { ReviewStrip } from "./ReviewStrip";
import { LoadingMark } from "./LoadingMark";
import { timeAgo } from "./helpers";
import { type Tone } from "./deckParts";
import { DeckDetail } from "./DeckDetail";
import { cardActions, cardSignal } from "./deckSignal";
// src/engine/usage.ts imports NOTHING — this is what makes it legal in a
// browser bundle. npm run build is the only gate that would catch a violation
// here; neither tsc nor the test suite resolves real module graphs.
import { formatEq, weightedEq } from "../engine/usage";

/** The Orchestrator's mark: one node on the left feeding two on the right
 * through elbow connectors — the drawer's own object, drawn. It replaced a ⚡
 * emoji, which rendered in the platform's own colour and weight (so it could
 * not take the chip's tint) and said "fast" about a surface whose whole point
 * is a graph.
 *
 * Squares, not circles: a node in this product is a place on disk, and a
 * rectangle reads as a thing rather than a state. Orthogonal connectors rather
 * than diagonals, matching the canvas's own edges. 1.3px strokes on a 16-unit
 * grid at 14px, which is the weight the sidebar's glyphs already use, and
 * `currentColor` throughout so the mark inherits whatever the chip resolves to
 * — including the armed state and the hover.
 *
 * Local to this file rather than in icons.tsx: that file is the SIDEBAR's
 * shared glyphs (see its own header), and this is the Deck's first and so far
 * only one. It moves there the moment a second surface needs it. */
const OrchestratorIcon = (): JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="1.2" y="6.1" width="4" height="3.8" rx="1.1" stroke="currentColor" strokeWidth="1.3" />
    <rect x="10.8" y="1.6" width="4" height="3.8" rx="1.1" stroke="currentColor" strokeWidth="1.3" />
    <rect x="10.8" y="10.6" width="4" height="3.8" rx="1.1" stroke="currentColor" strokeWidth="1.3" />
    <path d="M5.2 8h2.6a1 1 0 0 0 1-1V4.5a1 1 0 0 1 1-1h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <path d="M5.2 8h2.6a1 1 0 0 1 1 1v2.5a1 1 0 0 0 1 1h1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

let toastSeq = 0;

// Everything on, and the shipped Jira label — what a first paint renders before
// `deck:runs` arrives. `deck:runs` is asynchronous (a real round-trip through the
// extension host), so there is always a gap between mount and the first message;
// defaulting to "Jira" means that gap renders exactly today's UI rather than a
// flash of nameless copy ("parked · git + only") before the truth arrives a
// moment later. Same reasoning, same default, as App.tsx's DEFAULT_SOURCE_LABEL.
const DEFAULT_SOURCE_LABEL = "Jira";

// `needs` stays the column id — it is the engine's vocabulary (DeckColumn, deriveBucket)
// and never reaches a user. "Action required" is what the board says, in the summary
// tile, the column header and the legend alike: one name for one thing.
const COLUMNS: { id: DeckColumn; label: string; varName: string }[] = [
  { id: "progress", label: "In progress", varName: "--c-progress" },
  { id: "needs", label: "Action required", varName: "--c-attn" },
  { id: "review", label: "In review", varName: "--c-review" },
  { id: "done", label: "Done", varName: "--c-done" },
];

// Bands inside the two columns that hold visibly different news, most actionable
// first. Sidebar width has no room for a fifth column, and neither split earns
// one: they are the same stage of the same work, read differently.
//
// Lowercase, because a lane is a sub-header under a column and should not compete
// with it. `up` marks the lane that is good news — the only lane with any colour.
// A column with a lane list renders no unlaned cards: deriveLane answers for every
// card `review` and `done` can hold, and deckCards.test.ts holds it to that.
const LANES: Partial<Record<DeckColumn, { id: DeckLane; label: string; up?: boolean }[]>> = {
  review: [
    { id: "ready", label: "ready to merge", up: true },
    { id: "waiting", label: "waiting on review" },
  ],
  done: [
    { id: "merged", label: "merged", up: true },
    { id: "unmerged", label: "done · not merged" },
  ],
};

/** A copy of `r` with `key` removed. Used to clear a per-row flag or body
 * without leaving a stale `false`/`""` entry sitting in the map forever. */
function drop<T>(r: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _omitted, ...rest } = r;
  return rest;
}

/** Did every PR this run has actually land? Mirrors prSignals' `merged` rule in
 * status.ts — a run whose backend merged and whose frontend has not is not merged. */
function allMerged(prs: PrEntryMap): boolean {
  const facts = Object.values(prs).map((e) => e.facts).filter((f): f is PrFacts => f !== null);
  return facts.length > 0 && facts.every((f) => f.state === "MERGED");
}

function stateView(r: RunStatus, sourceLabel: string): { text: string; tone: Tone } {
  if (r.column === "done") return { text: allMerged(r.prs) ? "merged" : "done", tone: "merged" };
  /* An Action required card with no agent open is there because a PR is blocked:
     deriveBucket has no other route into `needs` without an agent state to read.
     Reading the agent first told that card "nothing is happening" in the parked
     grey, on the one column that means act now — and a board with no agents open
     anywhere is *all* such cards, which is how a column of real work came to look
     uniformly disabled. So the column leads here, exactly as `done` leads above:
     where the column knows more than the agent read, it says so.

     The line names the reason rather than restating the specifics — the PR block
     directly beneath already enumerates the failing check, the review and the
     conflict. `blocked` is still required, not assumed from the column: `needs`
     with no agent and nothing blocking is a state the ladder should not produce,
     and announcing a block that no fact supports would be a lie on the card. */
  if (r.column === "needs" && r.agent.state === "unknown" && prSignals(r.prs).blocked) {
    return { text: "pr blocked", tone: "attn" };
  }
  if (r.agent.state === "unknown") return { text: `parked · git + ${sourceLabel} only`, tone: "parked" };
  switch (r.agent.state) {
    case "working": return { text: `working · ${timeAgo(r.agent.lastActivityMs)}`, tone: "working" };
    case "needs-you": return { text: `ended turn · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "stalled": return { text: `stalled · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "exited": return { text: `exited · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "idle": return { text: `idle · ${timeAgo(r.agent.lastActivityMs)}`, tone: "idle" };
    default: return { text: `parked · git + ${sourceLabel} only`, tone: "parked" };
  }
}

function Card({ r, agent, column, lane, sourceLabel, selected, onSelect }: {
  r: RunStatus;
  /** Non-null on the Agents board: this card is that one session, and its state
   * line and action target come from the agent rather than the run. */
  agent: CardAgent | null;
  column: DeckColumn;
  /** The band within `column`, or null where the column means one thing. No
   * longer read by this card — kept for callers (e.g. laneOf) and the
   * Workspaces lens's own bookkeeping. */
  lane: DeckLane | null;
  sourceLabel: string;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const col = COLUMNS.find((c) => c.id === column)!;
  const accent = `var(${col.varName})`;
  // The agent's own activity when this card is an agent; the run's reduction
  // otherwise. `column` is threaded in rather than read off `r` for the same
  // reason: on the Agents board both are per-session.
  const sv = stateView({ ...r, agent: agent ? agent.activity : r.agent, column }, sourceLabel);
  // A ticketless run has no tracked issue behind it: the key is a local slug, and
  // openExternal("") is a button that does nothing.
  const tracked = isTicketRun(r.run);
  // The short label is only honest for a real Explore session. isTicketRun keys off
  // an empty url and never inspects the key, so anything else untracked keeps its
  // key on the chip rather than being relabelled as something it is not. A Track'd
  // ticketless place is the one exception with an "explore-"-less key: its record
  // is kind: "explore" but Track it never renames it off its local- place-hash, so
  // that prefix reads as "explore" here too — it is exactly what the record now is.
  const explore = r.run.key.startsWith("explore-") || r.run.key.startsWith("local-");
  // Exact, not prefix-matched: unlike `explore` above (whose key prefix is the only
  // signal a Track'd place leaves behind), a notepad run always carries its kind.
  const notepad = runKind(r.run) === "notepad";
  // A place with an agent open in it that Agent Flow Deck never launched. It has no
  // record on disk, so there is nothing to Forget — closing its agents is what
  // removes it.
  const local = runKind(r.run) === "local";
  // Every reason to address a PR now has its own row and its own verb, so the
  // old single gated button could only ever duplicate one of them. The lane gate
  // goes with it: it put Address PR on cards with nothing to address, and
  // withheld it from cards with a failing check. The local guard is preserved:
  // a local card's ticket is inferred from a branch name that may belong to
  // somebody else's ticket, and seeding an agent against that inference on one
  // click is what this must never do. The host re-checks it anyway.
  const acts = local ? [] : cardActions(r);
  // The key came from the branch, not from a launch. Say so: the branch could
  // name a ticket somebody else owns, and the ticket status on this card would
  // then be theirs. Computed host-side (the webview has no connector to parse
  // r.run.url with) and sent as `inferredTicketKey` — absent whenever the host
  // found no ticket in the url, which for a non-local run is always.
  const inferredKey = local ? (r.inferredTicketKey ?? "") : "";
  // Only a card that names one run and one repo can become a node: a place node
  // resolves to exactly one repo so no condition is ever ambiguous about which
  // repo's git or PR it means.
  const dragRepo = agent?.repo ?? (r.repos.length === 1 ? r.repos[0].name : undefined);
  const cardDragKey = dragRepo ? `${r.run.key}${DRAG_SEP}${dragRepo}` : null;
  const sigBits = cardSignal(r, agent);
  // sigBits[0] is the lead PR's number whenever this card has a PR; cardActions
  // reads the same lead PR, so the two cannot disagree.
  const firstBit = sigBits[0];
  const leadPrNumber = firstBit?.kind === "text" && firstBit.text.startsWith("#") ? firstBit.text.slice(1) : null;
  // Absent and zero render identically as "no figure": a run the sweep has not
  // reached has not been measured, and printing 0 would assert it cost nothing.
  const eq = r.usage ? weightedEq(r.usage) : 0;
  const spend = eq > 0 ? formatEq(eq) : null;

  return (
    <div
      className={`card ${column === "needs" ? "attn" : ""} ${selected ? "sel" : ""}`}
      style={{ ["--accent" as any]: accent }}
      draggable={cardDragKey !== null}
      onClick={onSelect}
      onDragStart={(e) => {
        if (cardDragKey) e.dataTransfer.setData("text/plain", cardDragKey);
      }}
    >
      {/* State leads, identity trails: the dot sits at the same x on every card, so a column
          scans top-to-bottom as one strip of "who needs me". */}
      <div className="c-top" onClick={(e) => e.stopPropagation()}>
        <span className={`status tone-${sv.tone}`}>
          <span className={`sdot tone-${sv.tone} ${sv.tone === "working" ? "pulse" : ""}`} />
          {sv.text}
        </span>
        {inferredKey ? (
          <span className="key-wrap">
            <span className="chip" title="Read from the branch name — Agent Flow Deck did not launch this">~inferred</span>
            <button
              className="key"
              title={`Open ${inferredKey} in ${sourceLabel}`}
              onClick={() => send({ type: "openExternal", url: r.run.url })}
            >
              {inferredKey}
            </button>
          </span>
        ) : tracked ? (
          <button className="key" title={`Open ${r.run.key} in ${sourceLabel}`} onClick={() => send({ type: "openExternal", url: r.run.url })}>
            {r.run.key}
          </button>
        ) : (
          <span className="key untracked" title={r.run.key}>{local ? "local" : explore ? "explore" : notepad ? "notepad" : r.run.key}</span>
        )}
      </div>
      <div className="c-title" title={r.run.summary}>
        {local && inferredKey && <span className="chip">local</span>}
        {r.run.summary}
      </div>

      {acts.length > 0 ? (
        /* The failure rows REPLACE the signal line rather than joining it: the
           bits it would show (#pr, ✗ check, conflicts) name the very facts these
           rows name, and restating them above the actions is noise. A failing
           card therefore stops showing its branch and diff totals — the correct
           trade, since "how big" already loses to "what is wrong" in
           cardSignal's own cap, and both remain in the detail drawer. */
        <div className="c-rows" onClick={(e) => e.stopPropagation()}>
          {acts.map((a, i) => (
            <div className="c-row" key={a.reason}>
              {i === 0 && leadPrNumber !== null && <span className="m">#{leadPrNumber}</span>}
              <span className={`lbl ${a.tone}`}>{a.text}</span>
              <button
                className="act"
                title={`${a.label} — open this task's workspace and work through it`}
                onClick={() => send({ type: "deck:seedPrWork", key: r.run.key, reason: a.reason, ...(a.detail ? { detail: a.detail } : {}) })}
              >
                {a.label}
              </button>
            </div>
          ))}
        </div>
      ) : sigBits.length > 0 ? (
        <div className="c-sig">
          {sigBits.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="sep">·</span>}
              {b.kind === "diff"
                ? <span className="c-diff"><span className="add">+{b.added}</span><span className="del">−{b.removed}</span></span>
                // The truncated branch's own title: .c-sig .m ellipsizes by design,
                // so a long one is otherwise unrecoverable without opening the
                // drawer — the old .c-branch .bn carried the same title.
                : <span className={`${b.mono ? "m" : ""} ${b.tone ?? ""}`.trim()} title={b.mono ? b.text : undefined}>{b.text}</span>}
            </React.Fragment>
          ))}
        </div>
      ) : null}

      <div className="c-foot2" onClick={(e) => e.stopPropagation()}>
        <button
          className={`act primary ${r.windowOpen ? "live" : ""}`}
          title={r.windowOpen ? "Open now — Open focuses the window already running this task" : "Open this task's workspace"}
          onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "open", ...(agent?.repo ? { repo: agent.repo } : {}) })}
        >
          Open
        </button>
        <button className="act" title="Show everything this task changed, file by file"
          onClick={() => send({ type: "deck:inspect", key: r.run.key, action: "diff", ...(agent?.repo ? { repo: agent.repo } : {}) })}>
          Diff
        </button>
        {spend && (
          <span className="spend" title="Effort-weighted tokens across every session in this task's directories (input×1, cache-write×1.25, cache-read×0.1, output×5)">
            {spend}<span className="u">eq</span>
          </span>
        )}
      </div>
    </div>
  );
}

export function DeckApp(): JSX.Element {
  const [runs, setRuns] = React.useState<RunStatus[]>([]);
  const [ghNote, setGhNote] = React.useState<string | null>(null);
  const [syncedAt, setSyncedAt] = React.useState<number | null>(null);
  const [, forceTick] = React.useState(0);
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string; action?: { label: string; url: string } }[]>([]);
  const [busy, setBusy] = React.useState(false);
  // False until the very first deck:runs post. Runs starts as [] the same as a
  // genuinely empty board would look, so without this flag the deck's first
  // paint — before the host has read anything at all — is indistinguishable
  // from "you have nothing in flight."
  const [hasLoaded, setHasLoaded] = React.useState(false);
  const [grouping, setGrouping] = React.useState<"agents" | "workspaces">("agents");
  const [staleCount, setStaleCount] = React.useState(0);
  // See DEFAULT_SOURCE_LABEL's own comment for why "Jira" rather than "".
  const [sourceLabel, setSourceLabel] = React.useState(DEFAULT_SOURCE_LABEL);
  const [reviews, setReviews] = React.useState<{ requests: ReviewRequest[]; issueCount: number; sort: ReviewSort; stale: boolean; reviewWrites: boolean; loading: boolean }>(
    { requests: [], issueCount: 0, sort: "oldest", stale: false, reviewWrites: false, loading: false },
  );
  const [reviewsCollapsed, setReviewsCollapsed] = React.useState(false);
  // Collapsed is the point: a closed run should cost one line, not a card.
  const [closedCollapsed, setClosedCollapsed] = React.useState(true);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  // `null` means the host tried this id's per-PR detail call and it failed —
  // distinct from absent (never asked yet), which is what lets the row show
  // "couldn't load checks" instead of "loading…" forever.
  const [details, setDetails] = React.useState<Record<string, ReviewDetail | null>>({});
  const [bodies, setBodies] = React.useState<Record<string, string>>({});
  /** Set when a row's box is filled by "Load agent's review" and stays set
   * through any amount of editing — the disclosure it drives ("an agent read
   * a teammate's code") stays true however much the wording changes. It clears
   * only when the box goes back to empty, since at that point nothing of the
   * agent's text is left to disclose. */
  const [fromDraft, setFromDraft] = React.useState<Record<string, boolean>>({});
  /** Mid-flight for this id: a submit has been posted and no
   * `deck:reviewSubmitDone` has come back for it yet. Cleared only by that
   * explicit, id-carrying message — never by a `toast` or a `deck:reviews`
   * post, both of which arrive constantly for reasons unrelated to any one
   * row's submit and carry no id to match against. */
  const [submitting, setSubmitting] = React.useState<Record<string, boolean>>({});
  /** The last submit for this id came back `"failed"`. Drives the strip's
   * inline "check the PR before trying again" line; cleared on `"ok"`, left
   * alone on `"cancelled"` (nothing was attempted, so nothing to warn about). */
  const [submitFailed, setSubmitFailed] = React.useState<Record<string, boolean>>({});
  const [flows, setFlows] = React.useState<Flow[]>([]);
  const [pendingResume, setPendingResume] = React.useState<PendingResume[]>([]);
  const [promptModes, setPromptModes] = React.useState<FlowPromptMode[]>([]);
  /** `agentFlow.commands`, carried on the same post as `promptModes` and held
   * the same way: configuration the drawer builds a command node out of, which
   * a webview cannot read for itself. */
  const [commands, setCommands] = React.useState<FlowCommand[]>([]);
  /** Branch-CI verdicts, keyed `repo#branch`, as the host last fetched them. The
   * drawer needs them to say what a `branch-ci-passed` rule is waiting on;
   * nothing else on the board reads a branch. */
  const [branchCi, setBranchCi] = React.useState<Record<string, BranchCiStatus>>({});
  const [orchEnabled, setOrchEnabled] = React.useState(false);
  const [openFlowId, setOpenFlowId] = React.useState<string | null>(null);
  /** The selected card's `DeckCard.id`, not a run key: the Agents lens renders
   * one card per session, so two cards can share a run and a key could not tell
   * them apart. */
  const [selId, setSelId] = React.useState<string | null>(null);
  /** The flow list the last `deck:flows` post carried. The message handler below is
   * registered once (`[]` deps, because re-running it would re-post `deck:ready`), so
   * the `flows` state variable it closes over never advances past `[]` — and telling
   * a newly created flow from one we already had needs the previous list. Mirrors
   * `flows` exactly; it is never a second source of truth for rendering. */
  const flowsRef = React.useRef<Flow[]>([]);
  /** True once a `deck:flows` post has landed. Before that, every flow looks
   * "fresh" against an empty previous list, which would pop the drawer open for
   * anyone with a saved flow the moment they open the Deck. */
  const seenFlowsRef = React.useRef(false);

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "deck:runs") {
        setRuns(m.runs);
        setStaleCount(m.staleCount);
        setGhNote(m.ghNote);
        setSourceLabel(m.sourceLabel);
        setSyncedAt(Date.now());
        setHasLoaded(true);
      } else if (m.type === "deck:grouping") {
        setGrouping(m.grouping);
      } else if (m.type === "toast") {
        const id = ++toastSeq;
        setToasts((t) => [...t.slice(-2), { id, level: m.level, message: m.message, action: m.action }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
      } else if (m.type === "deck:loading") {
        setBusy(m.loading);
      } else if (m.type === "deck:reviews") {
        // No auto-collapse. A long queue is bounded by .rv-rows' capped height and its
        // own scroller, so the board keeps its share of the window without the queue
        // ever being hidden — which also means the collapse state is purely the user's,
        // with no seeded-once ref and no setState nested inside another's updater.
        setReviews({ requests: m.requests, issueCount: m.issueCount, sort: m.sort, stale: m.stale, reviewWrites: m.reviewWrites, loading: m.loading });
      } else if (m.type === "deck:reviewDetail") {
        setDetails((d) => ({ ...d, [m.id]: m.detail }));
      } else if (m.type === "deck:reviewDraft") {
        setBodies((b) => ({ ...b, [m.id]: m.body }));
        setFromDraft((f) => ({ ...f, [m.id]: true }));
      } else if (m.type === "deck:reviewSubmitDone") {
        // The one signal that releases a row's disable — see `submitting`'s own doc
        // comment for why a toast or a routine deck:reviews poll (both far more
        // frequent, and idless) must not be trusted to mean the same thing.
        setSubmitting((s) => (m.id in s ? drop(s, m.id) : s));
        if (m.outcome === "failed") {
          setSubmitFailed((f) => ({ ...f, [m.id]: true }));
        } else if (m.outcome === "ok") {
          setSubmitFailed((f) => (m.id in f ? drop(f, m.id) : f));
          // Nothing of this row's box survives a successful write: a comment does
          // not evict the row, so a stale, re-enabled "lgtm" sitting in the
          // textarea would make the next click a real second review, with only the
          // confirmation modal in the way.
          setBodies((b) => (m.id in b ? drop(b, m.id) : b));
          setFromDraft((f) => (m.id in f ? drop(f, m.id) : f));
        }
        // "cancelled": nothing was attempted — only the disable above lifts. The
        // body, any draft flag, and any earlier failure warning are left exactly
        // as the user last saw them.
      } else if (m.type === "deck:flows") {
        // A create posts a flow we did not have — open it, since pressing the chip
        // with none is a request for exactly that. A flow deleted elsewhere must not
        // leave the drawer open on nothing.
        //
        // The comparison needs the previous list, and this listener is registered
        // once with `[]` deps so the `flows` state variable in scope is permanently
        // the initial `[]`. Hence the ref. What it must NOT be is `setOpenFlowId`
        // nested inside `setFlows`'s updater, which is what shipped: React's contract
        // is that an updater is pure, because React reserves the right to replay one.
        // (Measured, for the record: React 18.3.1's eager-state path happens to run
        // that updater exactly once per post, so the nested version was not producing
        // a wrong open flow today — this is closing the hole, not fixing a live
        // symptom. The same shape in the drawer's drag handler DID double-write.)
        // Reading the ref once, before overwriting it, keeps this block idempotent no
        // matter how many times React runs the updater below.
        const old = flowsRef.current;
        // Only ever "fresh" against a post we have actually seen — the very
        // first post's previous list is `[]`, which would otherwise make every
        // saved flow look newly created.
        const seenBefore = seenFlowsRef.current;
        // Every list on this message is defaulted, and the reason is the blast
        // radius rather than a live symptom: the host and this webview ship in
        // one .vsix, so a real post always carries all of them — but there is no
        // error boundary anywhere in `src/`, and each of these lands in a prop
        // the drawer dereferences (`.map`, `.some`, `.find`) on its next render.
        // One absent field therefore throws out of render and leaves `#root`
        // with NO CHILDREN AT ALL: no board, no drawer, nothing to click, and no
        // hint of why. Measured, not inferred — a `deck:flows` payload with no
        // `commands` (a harness whose `postFlows` predates that field) blanks the
        // whole panel, and adding `commands: []` brings it straight back.
        //
        // `store.ts`'s `coerceFlow` already spells out this exact posture for the
        // same panel ("one malformed edge thrown out of render blanks the whole
        // Deck panel"), so tolerating a missing list here is the house rule, not
        // a new indulgence. An empty list is also the honest reading of an absent
        // one: a build that did not send `commands` had none to send.
        // `posted`, not `flows`: the `flows` STATE variable is in scope here and is
        // permanently `[]` (this listener is registered once with `[]` deps — see
        // `flowsRef`'s own doc comment), so a local shadow of that name would be an
        // invitation to the exact confusion that ref exists to prevent.
        const posted = m.flows ?? [];
        flowsRef.current = posted;
        seenFlowsRef.current = true;
        setFlows(posted);
        // A pure read of `posted`/`old`/`seenBefore` — computed here, outside the
        // updater below, rather than inside it. React's contract is that an
        // updater is pure and may be replayed; a fresh flow auto-opening the
        // Orchestrator is a one-time side effect (clearing `selId`) that must
        // happen exactly once per post, not once per replay.
        const fresh = seenBefore ? posted.find((f) => !old.some((o) => o.id === f.id)) : undefined;
        // The two drawers share the same fixed slot at z-index 40 (see .dd and
        // .orch in deckStyles.ts) — a fresh flow auto-opening the Orchestrator
        // must close any open card detail, or both mount at once.
        if (fresh) setSelId(null);
        setOpenFlowId((cur) => {
          if (cur && posted.some((f) => f.id === cur)) return cur;
          return fresh ? fresh.id : null;
        });
        setOrchEnabled(m.enabled);
        setPendingResume(m.pendingResume ?? []);
        setPromptModes(m.promptModes ?? []);
        setCommands(m.commands ?? []);
        // The one field here that is NOT dereferenced unguarded downstream —
        // `describeCond` reads it as `c.branchCi?.[key]` — but defaulted with its
        // siblings anyway: the prop is typed non-optional, and leaving one member
        // of a defended set undefended is how the next reader learns the wrong
        // rule from the surrounding code.
        setBranchCi(m.branchCi ?? {});
      }
    };
    window.addEventListener("message", handler);
    send({ type: "deck:ready" });
    // keep "synced Ns ago" and relative times ticking
    const tick = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => {
      window.removeEventListener("message", handler);
      clearInterval(tick);
    };
  }, []);

  React.useEffect(() => {
    if (selId === null) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSelId(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selId]);

  // One list either way, so the columns, counts, stat tiles and sort all read
  // from the same shape. Workspaces mode is today's board exactly: one card per
  // run, agent nested, bucketed by the run's own column.
  // A closed run is not a card. Partitioning here rather than filtering the
  // columns keeps the stat tiles, the column counts and the board reading from
  // one list, which is what they already promise each other.
  const live = runs.filter((r) => r.shelf !== "closed");
  const closed = runs.filter((r) => r.shelf === "closed");
  const cards: DeckCard[] = grouping === "agents"
    ? projectCards(live)
    : live.map((r) => ({
        id: `w:${r.run.key}`, status: r, agent: null, agents: r.agents,
        column: r.column, lane: laneOf(r, r.column),
      }));
  // The label mirrors the card's own key chip, so the strip and the board name
  // the same run the same way.
  const closedRows: ClosedRow[] = closed.map((r) => ({
    key: r.run.key,
    title: r.run.summary,
    label: isTicketRun(r.run) ? r.run.key : runKind(r.run) === "notepad" ? "notepad" : "explore",
    closedAt: r.run.closedAt ?? null,
  }));
  // Resolved from the freshly projected list, so a selection whose run was
  // forgotten, closed, or re-bucketed into a different card id clears itself
  // rather than leaving the drawer rendering against a card that is no longer
  // on the board.
  const selected = selId === null ? null : cards.find((c) => c.id === selId) ?? null;
  React.useEffect(() => {
    if (selId !== null && selected === null) setSelId(null);
  }, [selId, selected]);
  const needs = cards.filter((c) => c.column === "needs").length;
  // With arming real, the count that matters on the chip is how many flows are
  // armed — that is the thing quietly spending your attention while the drawer
  // is closed, not how many flows merely exist.
  const armedCount = flows.filter((f) => f.armed).length;
  // The board's own total, not "today": a day figure would need per-line
  // timestamps and would print a number that disagrees with the cards under it.
  const boardEq = runs.reduce((s, x) => s + (x.usage ? weightedEq(x.usage) : 0), 0);

  const forget = React.useCallback((key: string) => {
    // Optimistic: the card leaves now rather than after a full refresh (a connector
    // round trip per run, plus git per repo). The next deck:runs post is
    // authoritative, so a delete that somehow failed brings the card straight back.
    setRuns((rs) => rs.filter((r) => r.run.key !== key));
    send({ type: "deck:forget", key });
  }, []);

  // One card, wherever it lands — a lane renders exactly what an unlaned column
  // does, so a lane can never quietly grow its own kind of card.
  const card = (c: DeckCard): JSX.Element => (
    <Card key={c.id} r={c.status} agent={c.agent} column={c.column} lane={c.lane} sourceLabel={sourceLabel}
      selected={c.id === selId}
      onSelect={() => { setOpenFlowId(null); setSelId((cur) => (cur === c.id ? null : c.id)); }} />
  );

  return (
    <>
      <div className="hd">
        <div className="title">In-flight<span className="sub">everything you've launched</span></div>
        {/* The three board columns and nothing else. "To review" lived here too,
            six pixels above the review strip that renders its own count; "Total"
            was the sum of these three, over a board showing every card it counted. */}
        <div className="stats">
          <div className="stat"><span className="n">{cards.filter((c) => c.column === "progress").length}</span><span className="l">In progress</span></div>
          <div className={`stat ${needs > 0 ? "attn" : ""}`}><span className="n">{needs}</span><span className="l">Action required</span></div>
          <div className="stat"><span className="n">{cards.filter((c) => c.column === "review").length}</span><span className="l">In review</span></div>
          {boardEq > 0 && (
            <div className="stat">
              <span className="n">{formatEq(boardEq)}</span>
              <span className="l">Tokens on board</span>
            </div>
          )}
        </div>
        <div className="sp" />
        {orchEnabled && (
          <button
            type="button"
            className={`ctl orch-chip${armedCount > 0 ? " armed" : ""}`}
            onClick={() => {
              setSelId(null);
              if (flows.length === 0) send({ type: "flow:create" });
              else setOpenFlowId((cur) => (cur ? null : flows[0].id));
            }}
          >
            <OrchestratorIcon />
            <span>Orchestrator</span>
            {armedCount > 0
              ? <span className="ct">{armedCount} armed</span>
              : flows.length > 0 && <span className="ct">{flows.length}</span>}
          </button>
        )}
        {/* A lens, not a trust toggle: both sides show everything, one card per
            agent or one per launched task. Persisted, so it survives a reload. */}
        <div className="ctls seg">
          {(["agents", "workspaces"] as const).map((g) => (
            <button
              key={g}
              type="button"
              className={`ctl ${grouping === g ? "on" : ""}`}
              title={g === "agents"
                ? "One card per Claude Code agent, with the repo, ticket and PR it belongs to"
                : "One card per launched task, with its agents nested underneath"}
              onClick={() => { setGrouping(g); send({ type: "deck:setGrouping", grouping: g }); }}
            >
              {g === "agents" ? "Agents" : "Workspaces"}
            </button>
          ))}
        </div>
        {staleCount > 0 && (
          <button
            type="button"
            className="ctl"
            title="Retire run records that are only waiting out their window. Worktrees, branches and commits are left untouched."
            onClick={() => send({ type: "deck:clearStale" })}
          >
            Clear stale ({staleCount})
          </button>
        )}
        <button type="button" className="ctl" title={`Re-read git, ${sourceLabel} and PR state now`} onClick={() => send({ type: "deck:refresh" })}>
          {/* At rest this stays the ⟳: a static logo sitting on a button reads as
              branding rather than as something you can press. In flight the mark
              takes over, and its motion is the same motion every other wait uses. */}
          {busy ? <LoadingMark size={12} /> : <span className="spin">⟳</span>}
          <span className="synced">{busy ? "syncing…" : syncedAt ? `synced ${timeAgo(syncedAt)}` : "refresh"}</span>
        </button>
      </div>

      <ReviewStrip
        requests={reviews.requests}
        issueCount={reviews.issueCount}
        sort={reviews.sort}
        stale={reviews.stale}
        loading={reviews.loading}
        collapsed={reviewsCollapsed}
        expanded={expanded}
        details={details}
        reviewWrites={reviews.reviewWrites}
        bodies={bodies}
        submitting={submitting}
        submitFailed={submitFailed}
        onCollapse={setReviewsCollapsed}
        onSort={(sort) => { setReviews((r) => ({ ...r, sort })); send({ type: "deck:setReviewSort", sort }); }}
        onExpand={(id) => {
          setExpanded((cur) => (cur === id ? null : id));
          // Once per session per row: the strip re-renders constantly (the 1s
          // clock tick), and a fetch on every render would spawn a gh call a second.
          if (!details[id]) send({ type: "deck:reviewExpand", id });
        }}
        onOpen={(url) => send({ type: "openExternal", url })}
        onLaunch={(id) => send({ type: "deck:reviewLaunch", id })}
        onLoadDraft={(id) => send({ type: "deck:reviewLoadDraft", id })}
        onBody={(id, body) => {
          setBodies((b) => ({ ...b, [id]: body }));
          // Editing a loaded draft does NOT clear the flag: the line tells a
          // teammate an agent read their code, which stays true however much you
          // reword it. Only emptying the box does — at that point nothing of the
          // agent's text is left to disclose.
          if (!body.trim()) setFromDraft((f) => (f[id] ? { ...f, [id]: false } : f));
        }}
        onSubmit={(id, verb) => {
          setSubmitting((s) => ({ ...s, [id]: true }));
          send({ type: "deck:reviewSubmit", id, verb, body: bodies[id] ?? "", fromDraft: !!fromDraft[id] });
        }}
      />

      {!hasLoaded ? (
        <div className="empty">
          <LoadingMark size={28} />
          <div className="big">Loading…</div>
        </div>
      ) : live.length === 0 && closed.length === 0 ? (
        <div className="empty">
          <div className="big">No tasks in flight</div>
          <div>Take a task from the Agent Flow Deck Tasks pool and it shows up here.</div>
        </div>
      ) : (
        <div className={`board${selected ? " dd-open" : ""}`}>
          {COLUMNS.map((col) => {
            // Sorting reads the agent's own activity on an agent card and the run's
            // reduction on a parked one, so a column still orders by "most
            // recently alive" whichever lens is up.
            const list = cards
              .filter((c) => c.column === col.id)
              .sort((a, b) =>
                ((b.agent?.activity ?? b.status.agent).lastActivityMs ?? 0) -
                ((a.agent?.activity ?? a.status.agent).lastActivityMs ?? 0) ||
                b.status.run.createdAt - a.status.run.createdAt);
            return (
              <section className="col" key={col.id}>
                <div className="col-hd">
                  <span className="dot" style={{ background: `var(${col.varName})` }} />
                  <span className="nm">{col.label}</span>
                  <span className="ct">{list.length}</span>
                  <span className="rule" />
                </div>
                <div className="col-body">
                  {LANES[col.id]
                    ? LANES[col.id]!.flatMap((lane) => {
                        const inLane = list.filter((c) => c.lane === lane.id);
                        if (inLane.length === 0) return [];
                        return [
                          <div className={`lane-hd${lane.up ? " up" : ""}`} key={`h:${lane.id}`}>
                            <span className="nm">{lane.label}</span>
                            <span className="ct">{inLane.length}</span>
                            <span className="rule" />
                          </div>,
                          ...inLane.map(card),
                        ];
                      })
                    : list.map(card)}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <ClosedStrip
        rows={closedRows}
        collapsed={closedCollapsed}
        onCollapse={(c) => setClosedCollapsed(c)}
        onReopen={(key) => send({ type: "deck:inspect", key, action: "open" })}
        onForget={forget}
        onClearAll={() => closedRows.forEach((r) => forget(r.key))}
      />

      <div className="legend">
        {COLUMNS.map((c) => (
          <span className="lg" key={c.id}><span className="dot" style={{ background: `var(${c.varName})` }} />{c.label}</span>
        ))}
        {ghNote && <span className="note warn">{ghNote}</span>}
        <span className="note">{`git + ${sourceLabel} backbone · best-effort live from `}<span className="path">~/.claude/projects</span></span>
      </div>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            <span className="toast-msg">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => send({ type: "openExternal", url: t.action!.url })}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>

      {orchEnabled && (
        <OrchestratorDrawer
          flows={flows}
          openId={openFlowId}
          // The full list, not `live`: a flow's place node binds a run key, and a
          // run shelving as closed must not make its own node unresolvable.
          runs={runs}
          pendingResume={pendingResume}
          promptModes={promptModes}
          commands={commands}
          branchCi={branchCi}
          onClose={() => setOpenFlowId(null)}
          onCreate={() => send({ type: "flow:create" })}
          onOpen={(id) => setOpenFlowId(id)}
          onRename={(id, name) => send({ type: "flow:rename", id, name })}
          onSave={(flow) => send({ type: "flow:save", flow })}
          onDelete={(id) => send({ type: "flow:delete", id })}
          onArm={(id, armed) => send({ type: "flow:arm", id, armed })}
          onResumeApprove={(id) => send({ type: "flow:resumeApprove", id })}
          onResumeDisarm={(id) => send({ type: "flow:resumeDisarm", id })}
          onResetEdge={(id, edgeId) => send({ type: "flow:resetEdge", id, edgeId })}
        />
      )}

      {selected && (
        <DeckDetail
          card={selected}
          sourceLabel={sourceLabel}
          onClose={() => setSelId(null)}
          onForget={forget}
        />
      )}
    </>
  );
}
