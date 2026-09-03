import * as React from "react";
import { send } from "./vscodeApi";
import { BranchCiStatus, CardAgent, DeckColumn, DeckLane, FlowCommand, FlowPromptMode, FlowTemplate, OutboundMessage, PendingResume, ReviewDetail, ReviewRequest, ReviewSort, RunStatus, isTicketRun, runKind } from "../types";
import type { AccountSlot } from "../types";
import { ClosedRow, ClosedStrip } from "./ClosedStrip";
import type { Flow } from "../engine/orchestrator/model";
import { bindsRun, boundTicketKeyOf, cardWorkflow, rankByState, type CardWorkflow, type WorkflowState, type WorkflowStatus } from "../engine/orchestrator/attach";
import { TEMPLATE_SCHEMA } from "../engine/orchestrator/templates";
import { DeckCard, laneOf, projectCards } from "./deckCards";
// Same import deckCards.ts makes, and safe for the same reason: bucket.ts is kept
// free of fs-touching imports, which bucket.test.ts enforces.
import { prSignals, type MergeTarget } from "../engine/bucket";
import { DRAG_SEP, OrchestratorDrawer, OrchTarget, OrchView } from "./OrchestratorDrawer";
import type { WorkflowRow } from "./WorkflowList";
import { ReviewStrip } from "./ReviewStrip";
import { LoadingMark } from "./LoadingMark";
import { CardKindIcon } from "./icons";
import { keyLabel, timeAgo } from "./helpers";
import { onTool, type Tone } from "./deckParts";
import { DeckDetail } from "./DeckDetail";
import { useDrawerExit } from "./Drawer";
import { cardActions, cardMerge, cardSignal } from "./deckSignal";
// src/engine/usage.ts imports NOTHING — this is what makes it legal in a
// browser bundle. npm run build is the only gate that would catch a violation
// here; neither tsc nor the test suite resolves real module graphs.
import { formatEq, weightedEq, type UsageTotals } from "../engine/usage";

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

// The webview renders before the extension's first deck:runs post on some paths,
// so this must be a real name and not "" — a tooltip that reads "undefined" is
// worse than one that briefly names the default agent. Same reasoning as
// DEFAULT_SOURCE_LABEL above. Also the fallback for a deck:runs message that
// omits `agentLabel` altogether — an in-flight message posted before this
// build's host reloads has no such field.
const DEFAULT_AGENT_LABEL = "Claude Code";

// `needs` stays the column id — it is the engine's vocabulary (DeckColumn,
// deriveBucket) and never reaches a user. "Action required" is what the board
// says, in the summary tile, the column header and the legend alike: one name for
// one thing. `merge` needs no translation: Merge is the label too.
//
// Board order is the attention ramp: something is running, a session is stuck, a
// pull request wants somebody, something is at the merge. Three of the four are
// stages rather than states and split into lanes below; Action required is the
// exception, and means exactly one thing — a session that cannot resume on its
// own, either waiting on your answer or dead holding the work. A session that
// merely ended its turn is NOT that, and lives in In progress's parked lane; see
// deriveBucket. There is no Done column: a ticket closed with nothing merged left
// no wrap-up, and leaves for the Recently closed strip.
//
// `glow` marks a zone where the dot means something is alive right now, and only
// those zones get the halo. In review deliberately does not. A live agent *can*
// land there — a blocked PR outranks the working signal, so an agent fixing red
// CI sits in `fixes needed` — but the column as a whole is a queue you cannot
// drain by watching it, and a pulsing dot over that would be the board's loudest
// lie.
const COLUMNS: { id: DeckColumn; label: string; varName: string; glow: boolean }[] = [
  { id: "progress", label: "In progress", varName: "--c-progress", glow: true },
  { id: "needs", label: "Action required", varName: "--c-attn", glow: true },
  { id: "review", label: "In review", varName: "--c-review", glow: false },
  { id: "merge", label: "Merge", varName: "--c-done", glow: true },
];

// Each laned column, most actionable band first. Lowercase, because a lane is a
// sub-header under a column and should not compete with it.
//
// No lane is marked as good news or bad news in its own colour: the column
// already carries the hue, and a lit lane header inside a lit column says nothing
// the column did not. A column with a lane list renders no unlaned cards —
// deriveLane answers for every route into all three, and deckCards.test.ts holds
// it to that.
//
// `needs` has no entry on purpose. It is the only column left that means exactly
// one thing — the session is stopped and cannot resume on its own — so a
// sub-header under it could only restate the header above it. Its two states are
// not two bands: the card's own state line already says which ("blocked · waiting
// on Edit" against "exited"), and both want the same click.
const LANES: Partial<Record<DeckColumn, { id: DeckLane; label: string }[]>> = {
  progress: [
    { id: "working", label: "working" },
    { id: "parked", label: "parked" },
  ],
  review: [
    { id: "fixes", label: "fixes needed" },
    { id: "waiting", label: "waiting on review" },
  ],
  merge: [
    { id: "ready", label: "ready to merge" },
    { id: "merged", label: "merged · wrap up" },
  ],
};

/** A copy of `r` with `key` removed. Used to clear a per-row flag or body
 * without leaving a stale `false`/`""` entry sitting in the map forever. */
function drop<T>(r: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _omitted, ...rest } = r;
  return rest;
}

function stateView(r: RunStatus, sourceLabel: string): { text: string; tone: Tone } {
  /* An In-review card with no agent open and a blocked PR is the fixes-needed
     lane's normal inhabitant: the PR wants something and there is nobody in the
     run to ask. Reading the agent first told that card "nothing is happening" in
     the parked grey — on the one lane that exists to say something is wrong — and
     a board with no agents open anywhere is *all* such cards, which is how a lane
     of real work came to look uniformly disabled. So the column leads here,
     exactly as `merge` does below: where the column knows more than the agent
     read, it says so.

     The line names the reason rather than restating the specifics — the PR block
     directly beneath already enumerates the failing check, the review and the
     conflict. `blocked` is required rather than assumed from the column, because
     unlike `needs` this column has plenty of other routes in: an unblocked PR
     waiting on somebody, or a ticket sitting in a review status with no PR at
     all. Announcing a block that no fact supports would be a lie on the card. */
  if (r.column === "review" && r.agent.state === "unknown" && prSignals(r.prs).blocked) {
    return { text: "pr blocked", tone: "attn" };
  }
  /* Same reasoning one column to the right: a Merge card with nobody home is not
     "parked", it is waiting on a press or on its wrap-up. The column and the PRs
     are the only things that know which — the agent read says nothing at all. */
  if (r.column === "merge" && r.agent.state === "unknown") {
    return { text: prSignals(r.prs).merged ? "merged" : "ready to merge", tone: "merged" };
  }
  if (r.agent.state === "unknown") return { text: `parked · git + ${sourceLabel} only`, tone: "parked" };
  switch (r.agent.state) {
    case "working": return { text: `working · ${timeAgo(r.agent.lastActivityMs)}`, tone: "working" };
    // An ended turn is as often a session that finished cleanly as one that asked
    // something, and `stalled` is a tool that is probably still running — neither
    // is a failure, so neither wears the attention colour. They are also no longer
    // in Action required (deriveBucket), and a red line in the parked lane would
    // be the card contradicting the column it sits in. `blocked` and `exited`
    // keep it: those two ARE stopped.
    case "needs-you": return { text: `ended turn · ${timeAgo(r.agent.lastActivityMs)}`, tone: "idle" };
    case "blocked": return { text: `blocked${onTool(r.agent.pendingTool)} · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "stalled": return { text: `stalled${onTool(r.agent.pendingTool)} · ${timeAgo(r.agent.lastActivityMs)}`, tone: "idle" };
    case "exited": return { text: `exited · ${timeAgo(r.agent.lastActivityMs)}`, tone: "attn" };
    case "idle": return { text: `idle · ${timeAgo(r.agent.lastActivityMs)}`, tone: "idle" };
    default: return { text: `parked · git + ${sourceLabel} only`, tone: "parked" };
  }
}

/** The glyph that borrows attention, one per status — only the two states that
 * genuinely want a human get one, echoing `WorkflowBlock.tsx`'s own per-step
 * `MARK`. Advancing, done and disarmed say nothing beyond their hue: a glyph on
 * every chip would put twenty exclamation points and checkmarks on an ordinary
 * board and drown out the two that matter. */
const CHIP_MARK: Partial<Record<WorkflowStatus, string>> = {
  "waiting-on-you": "!",
  stopped: "✕",
};

/** The trailing phrase after a chip's name, or `undefined` when no honest one
 * exists — never a sentence this function invents (see attach.ts's own doc
 * comment on `StepState.receipt`/`reason`).
 *
 * `stopped` names the failing edge's own recorded `error` — the same receipt
 * `WorkflowBlock.tsx`'s `stepText` reads for a `fail` step, spent here instead
 * of `reasonWhy` because an error string already IS the honest phrase; nothing
 * to derive.
 *
 * `waiting-on-you` names the gate's own `question`, read off the flow graph the
 * same way `runner.ts`'s `performedNote` reads a gate's question off an edge's
 * `to` for its "asked you: …" receipt — except the pending edge here points
 * AWAY from the gate (`evaluate.ts`'s `awaiting-answer` note is always posted
 * against the node an outgoing edge's `from` names), so the lookup runs on
 * `edge.from` instead of `edge.to`. `reasonWhy("awaiting-answer")` would give
 * "waiting for your answer" — true, but not what the flow is actually asking
 * for — so this reaches past it for the one thing that can honestly say that:
 * the gate's own words. A blank question falls back to the name alone rather
 * than printing an empty dash, and so does the `!gate || gate.kind !== "gate"`
 * guard: `evaluate.ts`'s own precondition for posting `awaiting-answer`
 * (`findNode(i.flow, e.from)?.kind === "gate"`) makes that branch unreachable
 * through the real `attach.ts` derivation — a "you" step's edge always starts
 * at a gate — but this function does not trust that from the outside; a
 * `WorkflowState` built any other way (a test, a future caller) gets the same
 * honest fallback rather than a crash or a fabricated phrase.
 *
 * Exported for exactly that: it is the only way to exercise the defensive
 * branch at all, since nothing REAL can construct a `WorkflowState` that trips
 * it — see `DeckApp.test.tsx`'s own `workflowChipTrailer` describe block. */
export function workflowChipTrailer(flow: Flow, state: WorkflowState): string | undefined {
  if (state.status === "stopped") {
    return state.steps.find((s) => s.state === "fail")?.receipt;
  }
  if (state.status === "waiting-on-you") {
    const step = state.steps.find((s) => s.state === "you");
    const edge = step && flow.edges.find((e) => e.id === step.edgeId);
    const gate = edge && flow.nodes.find((n) => n.id === edge.from);
    if (!gate || gate.kind !== "gate") return undefined;
    return gate.question || undefined;
  }
  return undefined;
}

/** Whether the currently open Orchestrator target survives an ordinary
 * `deck:flows` post — decided in the `deck:flows` handler before any
 * fresh-flow auto-open is considered (see that call site: a `null` here falls
 * through to the auto-open check, exactly like today's flow-only version
 * did).
 *
 * Kind-aware, deliberately — this is the one branch that must NOT treat a
 * `flow` and a `template` target alike:
 *  - A `flow` target's only evidence of still existing is `posted` (this very
 *    message), so it is dropped the moment its id falls out of that list — a
 *    flow deleted in another window must close the drawer. This is today's
 *    exact, unchanged behaviour.
 *  - A `template` target has no such evidence here: templates ride
 *    `m.templates`, a different field of the same message, never `posted`.
 *    A later task adds an unsaved draft template that exists on disk
 *    nowhere at all — for that draft, and for any template, there is no
 *    "was it in the list" check that means anything. The Deck posts
 *    `deck:flows` on every refresh (roughly every 6s), so applying `posted`
 *    membership to a template would close the drawer moments after it opened
 *    and silently discard an in-progress draft. So a template target is
 *    retained unconditionally: its presence is not `posted`'s to vouch for.
 *
 * Exported so the kind-aware branch can be pinned directly — see
 * `DeckApp.test.tsx`'s own `retainedOpenTarget` describe block, including the
 * mutation check that confirms this test fails without the `kind` guard. */
export function retainedOpenTarget(cur: OrchTarget | null, posted: Flow[]): OrchTarget | null {
  if (cur?.kind === "template") return cur;
  if (cur && posted.some((f) => f.id === cur.id)) return cur;
  return null;
}

/** How many drafts this session has minted — a monotonic counter, not a
 * wall-clock read, so two clicks landing in the same millisecond (a fast
 * double-click, or a test) still mint distinct ids. Same shape, same reason,
 * as `toastSeq` above. */
let draftTemplateSeq = 0;

/** A fresh, in-memory template for "＋ New template…" — held only in
 * `draftTemplate` state below, never written to `~/.agentflow/templates/`
 * and never added to `templates` (the list `deck:flows` posts, which is what
 * both the Templates screen and a card's attach picker read), until its own
 * Save sends `flow:writeTemplate`. See this component's own module comment
 * on why a draft-flow-on-disk approach was rejected: flows are global and
 * shared across windows behind a lock, so an interrupted edit would leave
 * another window looking at a workflow nobody made.
 *
 * Starts with exactly one `planned` node so `canBindTicket` (templates.ts)
 * passes the moment this is minted — that function's own doc comment is
 * explicit that a template built only of command/gate/notify nodes saves
 * cleanly and then fails `instantiate` at EVERY future attach, forever.
 * `repos: []` and `mode: ""` are not placeholders that need filling in
 * before this is usable — they are `instantiate`'s own documented fallback
 * (see `boundLaunch`, templates.ts): an empty `repos` takes the attaching
 * card's own repos, and a `mode` the config no longer has falls back to the
 * first configured one. `ticketKey: ""` is the same blank every demoted
 * place carries out of `toTemplate` — `instantiate` is what fills it in, at
 * attach time.
 *
 * The template's own `name` (and its inner flow's) both start blank,
 * mirroring `openSaveTemplate`'s identical choice below for the identical
 * reason: a name is asked for, never guessed — see the canvas's own Save
 * control for a template, which reads the typed name back off `flow.name`. */
export function mintDraftTemplate(): FlowTemplate {
  const id = `draft-${++draftTemplateSeq}`;
  return {
    schema: TEMPLATE_SCHEMA,
    id,
    name: "",
    params: {},
    savedAt: 0,
    flow: {
      id: "",
      name: "",
      armed: false,
      createdAt: 0,
      nodes: [
        { id: "n1", x: 24, y: 24, join: "any", kind: "planned", ticketKey: "", repos: [], mode: "", dest: "worktree" },
      ],
      edges: [],
    },
  };
}

/** The identifier text the board's own key chip prints for this run — the
 * inferred ticket key on a local card that has one, the tracked key
 * otherwise, and `keyLabel`'s short word for anything untracked. Mirrors
 * `Card`'s own three-way branch (below) so the Active list names a card by
 * the exact text the board itself already shows for it, rather than a second
 * hand-written guess at the same rule. */
function boardKeyLabel(r: RunStatus): string {
  const inferredKey = runKind(r.run) === "local" ? (r.inferredTicketKey ?? "") : "";
  if (inferredKey) return inferredKey;
  if (isTicketRun(r.run)) return r.run.key;
  return keyLabel(r.run);
}

function Card({ r, agent, column, sourceLabel, mergeWrites, merging, onMerge, selected, onSelect, workflow }: {
  r: RunStatus;
  /** Non-null on the Sessions lens: this card is that one session, and its state
   * line and action target come from the agent rather than the run. */
  agent: CardAgent | null;
  column: DeckColumn;
  sourceLabel: string;
  mergeWrites: boolean;
  merging: Record<string, true>;
  onMerge: (t: MergeTarget) => void;
  selected: boolean;
  onSelect: () => void;
  /** The one workflow this card shows a chip for, and where it stands —
   * `undefined` whenever `agentFlow.orchestrator` is off or nothing binds this
   * run, either of which must render no chip at all. Derived ONCE per card by
   * the caller (`DeckApp`'s own `card` closure), not here: `workflowState` runs
   * `previewFlow` internally, and doing that derivation inside every `Card`
   * instance would repeat it on every one of this component's own re-renders
   * rather than once per board pass — see that closure's own comment for the
   * numbers this was measured against. */
  workflow?: { flow: Flow; state: WorkflowState };
}): JSX.Element {
  // The agent's own activity when this card is an agent; the run's reduction
  // otherwise. `column` is threaded in rather than read off `r` for the same
  // reason: on the Sessions lens both are per-session.
  const sv = stateView({ ...r, agent: agent ? agent.activity : r.agent, column }, sourceLabel);
  // A ticketless run has no tracked issue behind it: the key is a local slug, and
  // openExternal("") is a button that does nothing.
  const tracked = isTicketRun(r.run);
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
  // The merge row and the problem rows are mutually exclusive by construction:
  // mergeTarget requires every fact cardActions reports as wrong to be absent.
  // The `acts.length === 0` guard below is therefore belt-and-braces, and cheap.
  // The `local` guard is the same one `acts` carries, for the same reason: a local
  // card's ticket is inferred from a branch name that may be someone else's, and
  // merging off that inference on one click is what must never ship. The host
  // re-checks it anyway.
  const merge = local || !mergeWrites ? null : cardMerge(r);
  const mergeBusy = merge ? merging[`${r.run.key}:${merge.repo}#${merge.number}`] === true : false;
  // The key came from the branch, not from a launch. Say so: the branch could
  // name a ticket somebody else owns, and the ticket status on this card would
  // then be theirs. Computed host-side (the webview has no connector to parse
  // r.run.url with) and sent as `inferredTicketKey` — absent whenever the url
  // named no ticket, or named the run's own key. A tracked Track-it card can
  // carry one too (its key stayed a place hash), which is why this reads the
  // run's KIND rather than the field's presence: "the key came from a branch,
  // not from a launch" is a statement about a local card, and a promoted one has
  // been through Track it since.
  const inferredKey = local ? (r.inferredTicketKey ?? "") : "";
  // Only a card that names one run and one repo can become a node: a place node
  // resolves to exactly one repo so no condition is ever ambiguous about which
  // repo's git or PR it means.
  const dragRepo = agent?.repo ?? (r.repos.length === 1 ? r.repos[0].name : undefined);
  const cardDragKey = dragRepo ? `${r.run.key}${DRAG_SEP}${dragRepo}` : null;
  // What this card IS, as its own mark. The run's kind, never the agent's: on the
  // Sessions lens the state comes from the session, but the object the card belongs
  // to is still the run.
  const kind = runKind(r.run);
  const sigBits = cardSignal(r, agent);
  // sigBits[0] is the lead PR's number whenever this card has a PR; cardActions
  // reads the same lead PR, so the two cannot disagree.
  const firstBit = sigBits[0];
  const leadPrNumber = firstBit?.kind === "text" && firstBit.text.startsWith("#") ? firstBit.text.slice(1) : null;

  // Name and state, no progress count — "2 of 5" is drawer information, and a
  // card already carries a kind mark, a key, a status pill and a lane rail.
  const wfTrailer = workflow ? workflowChipTrailer(workflow.flow, workflow.state) : undefined;
  const wfLabel = workflow ? (wfTrailer ? `${workflow.flow.name} — ${wfTrailer}` : workflow.flow.name) : undefined;
  const wfMark = workflow ? CHIP_MARK[workflow.state.status] : undefined;

  return (
    <div
      className={`card ${column === "needs" ? "attn" : ""} ${selected ? "sel" : ""}`}
      draggable={cardDragKey !== null}
      onClick={onSelect}
      onDragStart={(e) => {
        if (cardDragKey) e.dataTransfer.setData("text/plain", cardDragKey);
      }}
    >
      {/* The avatar leads, on the x the tone dot used to hold, so a column still
          scans from one left edge. The title is the anchor; the key trails it on the
          same line, flex: none, because a truncated ticket key is the one identifier
          on this card nobody can reconstruct.
          No stopPropagation on the header itself: clicking the summary has always
          selected the card, and the title now lives in here. Only the key slot
          swallows the click, because the key is the interactive part. */}
      <div className="c-hd">
        <CardKindIcon kind={kind} provider={r.provider} />
        <div className="hd-t">
          <div className="c-title" title={r.run.summary}>
            {local && inferredKey && <span className="chip">local</span>}
            {r.run.summary}
          </div>
        </div>
        <span className="hd-k" onClick={(e) => e.stopPropagation()}>
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
            <span className="key untracked" title={r.run.key}>{keyLabel(r.run)}</span>
          )}
        </span>
      </div>

      {acts.length > 0 || (merge && acts.length === 0) ? (
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
          {acts.length === 0 && merge && (
            <div className="c-row">
              <span className="m">#{merge.number}</span>
              <span className="lbl ok">approved · green · no open threads</span>
              <button
                className="act"
                disabled={mergeBusy}
                title={`Merge ${merge.repo}#${merge.number} — asks for confirmation first`}
                onClick={() => onMerge(merge)}
              >
                Merge
              </button>
            </div>
          )}
        </div>
      ) : sigBits.length > 0 ? (
        <div className="c-sig">
          {sigBits.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="sep">·</span>}
              {b.kind === "diff"
                ? <span className="c-diff"><span className="add">+{b.added}</span><span className="del">−{b.removed}</span></span>
                // A bit's own title wins — that is the repo names behind "4 repos".
                // The mono fallback is the truncated branch's: .c-sig .m ellipsizes by
                // design, so a long one is otherwise unrecoverable without opening the
                // drawer — the old .c-branch .bn carried the same title.
                : <span className={`${b.mono ? "m" : ""} ${b.tone ?? ""}`.trim()} title={b.title ?? (b.mono ? b.text : undefined)}>{b.text}</span>}
            </React.Fragment>
          ))}
        </div>
      ) : null}

      {/* One hairline, so it means one thing: identity and facts above it, live
          state below. */}
      <hr className="c-hr" />
      <div className="c-st">
        <span className={`sdot tone-${sv.tone} ${sv.tone === "working" ? "pulse" : ""}`} />
        <span className={`status tone-${sv.tone}`}>{sv.text}</span>
        {/* The age, and deliberately nothing else. Spend does NOT come back here:
            a66c543 took the card's figure away because a per-card number the reader
            cannot act on competed with the state line and the failure rows, which
            they can, and two tests in the suite pin that. The drawer owns spend.
            Its own title, in words, because the state text to the left also ends in
            a duration (the last activity) and these are different clocks. */}
        <span className="c-meta">
          <span className="age" title={`launched ${timeAgo(r.run.createdAt)}`}>{timeAgo(r.run.createdAt)}</span>
        </span>
      </div>

      <div className="c-foot2" onClick={(e) => e.stopPropagation()}>
        {/* `title` mirrors the visible text rather than carrying it alone: the
            label is already readable on the card and to a screen reader without
            it (a `title` is invisible to a keyboard user and absent from a
            screenshot), so it is here only as a hover affordance for the rare
            long gate question this chip's own `text-overflow: ellipsis`
            truncates. */}
        {workflow && (
          <span className={`c-wf ${workflow.state.status}`} title={wfLabel}>
            {/* Decoration, not information: the state is already carried by
                the visible words ("Ship it — approve deploy" already says
                waiting, "Ship it — smoke test failed" already says stopped),
                so the glyph is `aria-hidden` the same way `WorkflowBlock.tsx`'s
                own per-step `MARK` is — without it, a screen reader would
                announce a bare "!" or "✕" ahead of the sentence that already
                says the same thing in words. */}
            {wfMark && <span aria-hidden="true">{wfMark} </span>}{wfLabel}
          </span>
        )}
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
      </div>
    </div>
  );
}

export function DeckApp(): JSX.Element {
  const [runs, setRuns] = React.useState<RunStatus[]>([]);
  const [ghNote, setGhNote] = React.useState<string | null>(null);
  const [ghAccount, setGhAccount] = React.useState<AccountSlot | null>(null);
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
  // See DEFAULT_AGENT_LABEL's own comment for why "Claude Code" rather than "".
  const [agentLabel, setAgentLabel] = React.useState(DEFAULT_AGENT_LABEL);
  /** Mirrors `agentFlow.deck.showTokenTotal`. Starts false so the header tile is
   * absent on the very first paint, before any deck:runs has arrived — the
   * setting is off by default, and flashing a total that then vanishes would be
   * worse than never showing it. */
  const [showTokenTotal, setShowTokenTotal] = React.useState(false);
  /** `agentFlow.mergeWrites`. `?? false` is required, not defensive: the field is
   * optional on `deck:runs`, and an in-flight message from before this build's
   * host reloaded carries none — off is the safe reading of "I do not know" for
   * a write. Same shape as `agentLabel`'s fallback. */
  const [mergeWrites, setMergeWrites] = React.useState(false);
  /** PRs whose merge is in flight, keyed `${key}:${repo}#${number}` — the button
   * stays disabled until the host answers, so a double click cannot send twice. A
   * key is NOT dropped on a successful merge: see the `deck:mergeDone` handler. */
  const [merging, setMerging] = React.useState<Record<string, true>>({});
  /** run key → usage read on demand for its drawer, or null when unreadable.
   * A key absent from this map means "not asked yet or still waiting", which the
   * drawer renders differently from both a zero total and a failed read. */
  const [lazyUsage, setLazyUsage] = React.useState<Record<string, UsageTotals | null>>({});
  const [reviews, setReviews] = React.useState<{ requests: ReviewRequest[]; issueCount: number; sort: ReviewSort; stale: boolean; reviewWrites: boolean; loading: boolean; alwaysVisible: boolean }>(
    { requests: [], issueCount: 0, sort: "oldest", stale: false, reviewWrites: false, loading: false, alwaysVisible: false },
  );
  const [reviewsCollapsed, setReviewsCollapsed] = React.useState(false);
  /** The review strip's selection, for a batch launch. Opt-in and short-lived: it
   *  turns on from the strip's own `select` control and ends when the batch is sent
   *  or Done is pressed. Ids, not rows — the queue re-posts every poll. */
  const [selecting, setSelecting] = React.useState(false);
  const [selectedReviews, setSelectedReviews] = React.useState<string[]>([]);
  /** The last row toggled, as the anchor a shift-click extends from. A ref rather
   *  than state: it never renders anything, and a re-render per click would be one
   *  the selection itself already caused. */
  const selectAnchor = React.useRef<string | null>(null);
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
  /** Reusable workflow shapes, for the card drawer's attach picker. Rides
   * `deck:flows` alongside `flows` itself — see that message's own comment in
   * types.ts for why: with the orchestrator off there is nothing to attach,
   * and this is emptied on the same beat as `pendingResume`/`promptModes`. */
  const [templates, setTemplates] = React.useState<FlowTemplate[]>([]);
  const [orchEnabled, setOrchEnabled] = React.useState(false);
  const [openFlowId, setOpenFlowId] = React.useState<OrchTarget | null>(null);
  /** Which of the Orchestrator drawer's three top-level screens is showing —
   * see `OrchView`'s own doc comment for why this lives here rather than as
   * the drawer's own local state: the Workflows/Templates header buttons
   * below set this from outside the drawer, so `DeckApp` has to be the one
   * holding it. Defaults to "active", since that is what a first click on
   * either header button below shows (Workflows) or falls through to
   * (Templates does not touch this at all, but "active" is as good a rest
   * state as any for a drawer that starts closed — see `orchOpen`). */
  const [orchView, setOrchView] = React.useState<OrchView>("active");
  /** Is the Orchestrator drawer showing at all, independent of `orchView` and
   * of `openFlowId`. Needed only because those two stopped being enough
   * on their own: before OrchestratorDrawer.tsx learned to render Active and
   * Templates without a resolved flow, "no flow addressed" (`openFlowId ===
   * null`) WAS "nothing to show" — the drawer's own `if (!flow) return null`
   * closed it for free. Once Active/Templates stopped needing a flow, that
   * stopped being true, and with `orchView` defaulting to "active" the
   * drawer would otherwise show itself unasked on the very first render.
   *
   * Set alongside `openFlowId` everywhere a flow gets addressed (the
   * fresh-flow auto-open below, "Open in Workflows ↗", both header buttons),
   * and cleared alongside it everywhere the drawer is explicitly dismissed
   * (✕, selecting a card, opening a card from the Active list). Left ALONE
   * when a flow disappears out from under an open Canvas (deleted in another
   * window) — Canvas keeps its own separate guard for that
   * (`if (!flow) return null`, OrchestratorDrawer.tsx), and leaving this
   * flag as it is costs nothing: the drawer stays mounted but renders
   * nothing either way. */
  const [orchOpen, setOrchOpen] = React.useState(false);
  /** The one in-flight "＋ New template…" draft, or `null` — never on disk,
   * never in `templates` (so a card's attach picker can never offer it; see
   * `mintDraftTemplate`'s own doc comment). At most one at a time: pressing
   * "＋ New template…" again while a draft already exists reopens the SAME
   * draft rather than minting a second one and orphaning the first — there
   * is exactly one canvas to show it on. Cleared on Cancel and immediately
   * after a successful Save is sent (the real template then arrives on the
   * next `deck:flows` post) — see the drawer's own `onCancelTemplate` prop. */
  const [draftTemplate, setDraftTemplate] = React.useState<FlowTemplate | null>(null);
  /** The selected card's `DeckCard.id`, not a run key: the Sessions lens renders
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
        // `?? null` for the same reason `agentLabel` has a fallback: an in-flight
        // message posted before this build's host reloads carries no such field.
        setGhAccount(m.ghAccount ?? null);
        setSourceLabel(m.sourceLabel);
        // The `?? DEFAULT_AGENT_LABEL` is required, not defensive: an in-flight
        // message posted before this build's host reloads has no such field.
        setAgentLabel(m.agentLabel ?? DEFAULT_AGENT_LABEL);
        setShowTokenTotal(m.showTokenTotal);
        setMergeWrites(m.mergeWrites ?? false);
        setSyncedAt(Date.now());
        setHasLoaded(true);
      } else if (m.type === "deck:mergeDone") {
        // Deliberately asymmetric on `outcome`, and NOT to be tidied into matching
        // `deck:reviewSubmitDone`'s release-on-any-outcome below. A review leaves
        // the PR open, so its row must come back either way. A merge does not:
        // on "ok" the PR is merged, but `r.prs` still holds the pre-merge OPEN
        // facts until the next `deck:runs` — a poll window plus fetch latency —
        // so releasing here re-renders the same "approved · green · no open
        // threads" row with a live Merge button over a PR that is already gone.
        // Clicking it passes the host's re-check (the success path stales the
        // entry but leaves the facts saying OPEN) and fires a second merge that
        // only the forge refuses. The host's staling is what resolves this: the
        // next tick refetches, the refreshed facts say MERGED, and the row
        // disappears — taking its disabled button with it.
        if (m.outcome !== "ok") {
          // Keyed, not a single slot: the reply can land after the board re-rendered.
          setMerging((s) => {
            const next = { ...s };
            delete next[`${m.key}:${m.repo}#${m.number}`];
            return next;
          });
        }
      } else if (m.type === "deck:usage") {
        // Keyed rather than a single "current drawer" slot: a reply can land after
        // the user has moved to another card, and dropping it would leave the new
        // drawer showing a figure that belongs to the old one.
        setLazyUsage((u) => ({ ...u, [m.key]: m.usage }));
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
        // `?? false` because an older host's post has no alwaysVisible field at
        // all, and absent must read as the released hidden-when-empty behavior.
        setReviews({ requests: m.requests, issueCount: m.issueCount, sort: m.sort, stale: m.stale, reviewWrites: m.reviewWrites, loading: m.loading, alwaysVisible: m.alwaysVisible ?? false });
        // A merged PR leaves the queue on the next poll. Keeping its id selected would
        // let the launch ask the host to review a row that no longer exists — and the
        // host would silently drop it, so the count and the outcome would disagree.
        setSelectedReviews((cur) => {
          const live = cur.filter((id) => m.requests.some((r) => r.id === id));
          return live.length === cur.length ? cur : live;
        });
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
        // Suppressed when the fresh flow is the one just bound to the card
        // whose drawer is open right now — `flow:attach` mints a fresh flow
        // too, and treating it the same as "+ New flow" would slam the card
        // drawer shut on a workflow the user just attached to it before they
        // ever see it disarmed (design doc §3: attaching must show the shape
        // before anything can spend). `bindsRun` (attach.ts) is the exact
        // predicate `cardWorkflow` itself uses to decide whether a flow
        // belongs to a card, so this cannot drift from what the block and
        // chip already agree a card's workflow is.
        const openCard = openCardRef.current;
        const boundToOpenCard = fresh !== undefined && openCard !== null
          && bindsRun(fresh, openCard.runKey, openCard.ticketKey);
        const autoOpen = fresh !== undefined && !boundToOpenCard;
        // The two drawers share the same fixed slot at z-index 40 (see .dd and
        // .orch in deckStyles.ts) — a fresh flow auto-opening the Orchestrator
        // must close any open card detail, or both mount at once. Skipped
        // when `boundToOpenCard`: then nothing is about to open BUT the card
        // drawer already showing, so nothing needs to close under it.
        if (autoOpen) setSelId(null);
        // An auto-opened fresh flow must land on the Canvas screen, not
        // whichever of the three top-level views happened to be showing —
        // "+ New flow" means "start drawing", never "go look at the Active
        // list". Plain, unnested `setView`/`setOrchOpen` beside `setSelId`
        // above for the identical reason neither is folded into the
        // `setOpenFlowId` updater: React may replay a pure updater, and a
        // side effect belongs beside it, not inside it. `setOrchOpen` matters
        // here specifically for a flow created while the drawer was fully
        // closed (`orchOpen` false) — without it the fresh flow would resolve
        // and paint, but stay invisible behind the closed drawer's own gate.
        if (autoOpen) setOrchView("canvas");
        if (autoOpen) setOrchOpen(true);
        // `retainedOpenTarget` is the kind-aware guard — see its own doc
        // comment for why a `flow` and a `template` target cannot be treated
        // alike here. `null` means nothing survived, which is exactly when
        // the ordinary fresh-flow auto-open gets to decide instead.
        setOpenFlowId((cur) => retainedOpenTarget(cur, posted) ?? (autoOpen ? { kind: "flow", id: fresh!.id } : null));
        setOrchEnabled(m.enabled);
        setPendingResume(m.pendingResume ?? []);
        setPromptModes(m.promptModes ?? []);
        setCommands(m.commands ?? []);
        setTemplates(m.templates ?? []);
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
  /** The run key and ticket key of whichever card's drawer is open right now,
   * mirrored into a ref rather than read as state: the `deck:flows` message
   * handler above is registered once (`[]` deps — see `flowsRef`'s own doc
   * comment) and would otherwise only ever see `selected` as it was at mount.
   * `flow:attach` mints a fresh flow bound to exactly this card, and that
   * handler needs to recognise "this fresh flow is the one just attached to
   * the card already open" without waiting on a render — see its own comment
   * on why a fresh flow normally auto-opens the Orchestrator and closes this
   * drawer, and why that must be suppressed for this one case. `null`
   * whenever no card is selected. */
  // Theoretical, not reachable by anything this fix guards: a `message` event
  // could in principle land between a commit that changes `selected` and the
  // effect below flushing, reading one render stale. Not reachable for attach
  // itself — the click that produces `flow:attach`'s answering `deck:flows`
  // post is many ticks after the drawer already opened and this effect long
  // since flushed — noted here so the next reader does not rediscover it.
  const openCardRef = React.useRef<{ runKey: string; ticketKey: string } | null>(null);
  React.useEffect(() => {
    openCardRef.current = selected
      ? { runKey: selected.status.run.key, ticketKey: boundTicketKeyOf(selected.status) }
      : null;
  }, [selected?.status]);
  /** The card the detail drawer draws, and whether it is sliding out — the same
   * seam the Orchestrator drawer leaves the board through. It lives up here
   * rather than inside DeckDetail because the two signals it needs are this
   * component's: `selId` is what the user pointed at, `selected` is what that
   * still resolves to on the board. Dismissing drops the first and animates;
   * a card leaving the board drops the second, and unmounts at once (the
   * effect above then clears the stale id). */
  const { shown: shownCard, closing: ddClosing } = useDrawerExit(selId, selected);

  // Ask for the selected run's usage once per drawer opening. This is the only
  // thing that triggers a transcript read on a default install, which is the whole
  // point of it being here rather than on a timer: a session that never opens a
  // drawer parses nothing. Re-asking on each open is deliberate — the host's
  // reader is incremental, so a second open costs a stat per file, and a stale
  // figure on a task that has since burned more tokens would be worse.
  const selRunKey = selected?.status.run.key ?? null;
  React.useEffect(() => {
    if (selRunKey === null) return;
    send({ type: "deck:usageFor", key: selRunKey });
  }, [selRunKey]);

  const needs = cards.filter((c) => c.column === "needs").length;
  const mergeable = cards.filter((c) => c.column === "merge").length;
  // The board's own total, not "today": a day figure would need per-line
  // timestamps and would print a number that disagrees with the cards under it.
  const boardEq = live.reduce((s, x) => s + (x.usage ? weightedEq(x.usage) : 0), 0);

  const forget = React.useCallback((key: string) => {
    // Optimistic: the card leaves now rather than after a full refresh (a connector
    // round trip per run, plus git per repo). The next deck:runs post is
    // authoritative, so a delete that somehow failed brings the card straight back.
    setRuns((rs) => rs.filter((r) => r.run.key !== key));
    send({ type: "deck:forget", key });
  }, []);

  // One "now" for the whole board pass, read once and handed to every card's
  // workflow chip below — not one read per card, and not one read per card
  // PLUS a second inside `rankByState` and a third inside `workflowState`,
  // which is what `DeckDetail.tsx`'s own single `Date.now()` call already
  // guards against for one card. The reasoning carries over unchanged: `now` is
  // deliberately not memoized (a cached wall-clock reading is exactly the state
  // that goes stale), and `forceTick`'s own 1s interval already re-renders this
  // component regularly regardless of what this line does.
  const now = Date.now();

  // `cardWorkflow` (attach.ts) is the exact `attachedWorkflows` → `rankByState`
  // → `workflowState` chain, plus the ticket-key derivation, that
  // `DeckDetail.tsx`'s own drawer calls for the one selected card — the SAME
  // function, not a second hand-written copy of the same three-step chain: a
  // ticket-key rule that changed in one call site and not the other would let
  // a card's own chip and its own drawer disagree about which workflow it
  // carries, with nothing failing to say so. Computed ONCE per card, per board
  // pass, into the map below — not from `Card` itself, which re-renders
  // independently and would otherwise repeat the derivation on every one of
  // ITS OWN re-renders rather than once per pass over the board, and not a
  // second time for the Active list: that list's rows are built FROM this same
  // map (below), which is what makes a card's chip and its own row in that
  // list structurally unable to disagree — there is only one place either of
  // them could have come from.
  //
  // The cost actually measured: `workflowState` runs `previewFlow` internally,
  // which runs `evaluateFlow` twice, each rebuilding a `Map` over every run on
  // the board. For the common case — one armed workflow per card — `rankByState`
  // sorts a one-element array (zero comparisons, so it calls `workflowState`
  // zero times internally) and the one explicit call inside `cardWorkflow` is
  // the only one: a board of 30 cards each with one workflow costs 30
  // `workflowState` calls, i.e. 60 `evaluateFlow` calls, per second. Cheap. The
  // number only climbs where a card binds SEVERAL workflows at once (attach.ts's
  // escape hatch, not the common shape): `rankByState`'s sort then calls
  // `workflowState` twice per comparison, so a handful of 4-workflow cards on
  // the same board could reach into the hundreds of `evaluateFlow` calls a
  // second. That is a property of `rankByState` itself (unchanged here, and out
  // of this task's files), not of computing it once per card instead of once
  // per card per `Card` re-render — this fix removes the latter multiplier; it
  // does not remove the former.
  //
  // `now` is in the dep list for correctness, not for a cache hit: it is
  // deliberately unmemoized above (see that line's own comment) and
  // `forceTick`'s 1s interval is only one of several things that re-render
  // this component, so in practice this recomputes on nearly every render —
  // about as often as the old per-card call did. The memo is not buying a
  // cache here; the property it buys is the one paragraph up (one derivation,
  // not two), which holds regardless of how often the effect body reruns.
  const workflowByCard = React.useMemo(() => {
    const m = new Map<string, CardWorkflow>();
    if (!orchEnabled) return m;
    for (const c of cards) {
      const w = cardWorkflow(flows, c.status, runs, now, branchCi);
      if (w) m.set(c.id, w);
    }
    return m;
  }, [orchEnabled, cards, flows, runs, now, branchCi]);

  // The Active screen's rows — one per card carrying a workflow, read from the
  // exact same map the board's own chip reads below, so the two can never name
  // a different workflow or a different state for the same card. Ranked with
  // `rankByState` itself (not a second hand-written copy of `attach.ts`'s RANK
  // table): sorting the entries by where their own flow lands in that
  // function's own output keeps this list's precedence and the drawer's
  // canvas-screen precedence (which also calls `rankByState`) the same rule,
  // read once.
  const activeRows: WorkflowRow[] = React.useMemo(() => {
    const entries: { card: DeckCard; w: CardWorkflow }[] = [];
    for (const c of cards) {
      const w = workflowByCard.get(c.id);
      if (w) entries.push({ card: c, w });
    }
    const order = rankByState(entries.map((e) => e.w.flow), runs, now, branchCi);
    const rank = new Map(order.map((f, i) => [f, i]));
    return entries
      .slice()
      .sort((a, b) => (rank.get(a.w.flow) ?? 0) - (rank.get(b.w.flow) ?? 0))
      .map((e) => ({
        cardId: e.card.id,
        ticketKey: boardKeyLabel(e.card.status),
        title: e.card.status.run.summary,
        workflow: e.w,
      }));
  }, [cards, workflowByCard, runs, now, branchCi]);

  // How many rows on the Active list are genuinely waiting on the reader —
  // `waiting-on-you` (a gate asking a question) or `stopped` (a rule that
  // errored and will never fire again until Reset), the same two statuses
  // `RANK` (attach.ts) already ranks ahead of everything else. Read from
  // `activeRows` itself, not recomputed from `flows`/`runs` a second way, so
  // the Workflows chip's own badge can never name a different number than the
  // list underneath it renders.
  const needsYouCount = activeRows.filter((r) => {
    const s = r.workflow.state.status;
    return s === "waiting-on-you" || s === "stopped";
  }).length;

  // One card, wherever it lands — a lane renders exactly what an unlaned column
  // does, so a lane can never quietly grow its own kind of card.
  const card = (c: DeckCard): JSX.Element => (
    <Card key={c.id} r={c.status} agent={c.agent} column={c.column} sourceLabel={sourceLabel}
      mergeWrites={mergeWrites} merging={merging}
      onMerge={(t) => {
        setMerging((s) => ({ ...s, [`${c.status.run.key}:${t.repo}#${t.number}`]: true }));
        send({ type: "deck:mergePr", key: c.status.run.key, repo: t.repo, number: t.number });
      }}
      selected={c.id === selId}
      onSelect={() => { setOpenFlowId(null); setOrchOpen(false); setSelId((cur) => (cur === c.id ? null : c.id)); }}
      workflow={workflowByCard.get(c.id)} />
  );

  return (
    <>
      <div className="hd">
        <div className="title">In-flight<span className="sub">everything you've launched</span></div>
        {/* The board columns and nothing else. "To review" lived here too, six
            pixels above the review strip that renders its own count; "Total" was
            the sum of the rest, over a board showing every card it counted.
            Merge earns a tile for the same reason it earned a column: between
            the press and the wrap-up, it is the number here you can drive to
            zero today. */}
        <div className="stats">
          <div className="stat"><span className="n">{cards.filter((c) => c.column === "progress").length}</span><span className="l">In progress</span></div>
          <div className={`stat ${needs > 0 ? "attn" : ""}`}><span className="n">{needs}</span><span className="l">Action required</span></div>
          <div className="stat"><span className="n">{cards.filter((c) => c.column === "review").length}</span><span className="l">In review</span></div>
          <div className={`stat ${mergeable > 0 ? "up" : ""}`}><span className="n">{mergeable}</span><span className="l">Merge</span></div>
          {showTokenTotal && boardEq > 0 && (
            <div
              className="stat"
              title="Effort-weighted tokens across every session on the board (input×1, cache-write×1.25, cache-read×0.1, output×5)"
            >
              <span className="n">{formatEq(boardEq)}<span className="u">eq</span></span>
              <span className="l">Tokens on board</span>
            </div>
          )}
        </div>
        <div className="sp" />
        {/* Two sibling entry points, replacing the single "Orchestrator" chip.
            That one button's zero-flows click used to mint a blank flow
            (`flow:create`) instead of opening anything — with no flows yet,
            there was no way to reach Templates at all. Each button below
            always opens ITS OWN view; neither ever sends `flow:create`. */}
        {orchEnabled && (
          <>
            <button
              type="button"
              // Reusing `.orch-chip`'s existing `armed` escalation (bold, full-
              // strength brand hue) for "needs you" rather than borrowing the
              // board's own amber `.attn` — orchestratorStyles.ts's own comment
              // on `.orch-chip` is explicit that teal names this SURFACE and
              // amber is reserved for "a card needs you" elsewhere on the
              // board; painting this chip amber too would read as a second
              // alarm rather than the one place this feature lives.
              className={`ctl orch-chip${needsYouCount > 0 ? " armed" : ""}`}
              onClick={() => {
                setSelId(null);
                // Toggle only against ITS OWN view — clicking Workflows while
                // Templates is showing switches to Active rather than
                // closing, matching how a click on the drawer's own in-panel
                // tabs behaves (OrchestratorDrawer.tsx's "asks the caller to
                // change the view rather than changing it itself"). Neither
                // button ever touches `openFlowId`: Active and Templates are
                // surfaces over the whole workspace, not addressed at a flow.
                if (orchOpen && orchView === "active") { setOrchOpen(false); return; }
                setOrchView("active");
                setOrchOpen(true);
              }}
            >
              <OrchestratorIcon />
              <span>Workflows</span>
              {needsYouCount > 0
                ? <span className="ct">{needsYouCount} needs you</span>
                : activeRows.length > 0 && <span className="ct">{activeRows.length}</span>}
            </button>
            <button
              type="button"
              className="ctl orch-chip"
              onClick={() => {
                setSelId(null);
                if (orchOpen && orchView === "templates") { setOrchOpen(false); return; }
                setOrchView("templates");
                setOrchOpen(true);
              }}
            >
              <OrchestratorIcon />
              <span>Templates</span>
              {templates.length > 0 && <span className="ct">{templates.length}</span>}
            </button>
          </>
        )}
        {/* A lens, not a trust toggle: both sides show everything, one card per
            session or one per launched task. Persisted, so it survives a reload. */}
        <div className="ctls seg">
          {(["agents", "workspaces"] as const).map((g) => (
            <button
              key={g}
              type="button"
              className={`ctl ${grouping === g ? "on" : ""}`}
              title={g === "agents"
                ? `One card per ${agentLabel} session, with the repo, ticket and PR it belongs to`
                : "One card per launched task, with its sessions nested underneath"}
              onClick={() => { setGrouping(g); send({ type: "deck:setGrouping", grouping: g }); }}
            >
              {g === "agents" ? "Sessions" : "Workspaces"}
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
        showWhenEmpty={reviews.alwaysVisible}
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
        selecting={selecting}
        selected={selectedReviews}
        onSelectMode={(next) => {
          setSelecting(next);
          // Leaving selection mode drops the selection with it: a bar that is gone
          // cannot show what is still picked, and a hidden selection is a launch
          // waiting to surprise somebody.
          if (!next) { setSelectedReviews([]); selectAnchor.current = null; }
          // Nothing can be open while picking (the strip hides .rv-detail), so close
          // it here too rather than leaving state the UI is contradicting.
          if (next) setExpanded(null);
        }}
        onToggle={(id, shift) => {
          const order = reviews.requests.map((r) => r.id);
          // Read the anchor BEFORE moving it, and hold it in a local the updater
          // closes over: a functional updater runs at render time, by which point the
          // assignment below has already happened — so reading the ref inside it made
          // every anchor equal the row just clicked, and no range ever extended.
          const anchor = selectAnchor.current;
          selectAnchor.current = id;
          setSelectedReviews((cur) => {
            // A shift-click with a live anchor takes the whole span between them, in
            // queue order — the range the user drew, not the order they clicked in.
            if (shift && anchor && order.includes(anchor) && anchor !== id) {
              const [from, to] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
              const span = order.slice(from, to + 1);
              return [...cur.filter((x) => !span.includes(x)), ...span].sort((x, y) => order.indexOf(x) - order.indexOf(y));
            }
            return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id].sort((x, y) => order.indexOf(x) - order.indexOf(y));
          });
        }}
        onSelectAll={() => { setSelectedReviews(reviews.requests.map((r) => r.id)); selectAnchor.current = null; }}
        onLaunchBatch={() => {
          // One message for the batch: the host asks its questions — mode, destination
          // — once for all of them. The guard is belt-and-braces: the bar's own button
          // is disabled at zero, so nothing reaches here with an empty list today.
          if (!selectedReviews.length) return;
          send({ type: "deck:reviewBatch", ids: selectedReviews });
          setSelecting(false);
          setSelectedReviews([]);
          selectAnchor.current = null;
        }}
        agentLabel={agentLabel}
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
              // One custom property carries the zone's hue to every rule under it
              // — the dot, its halo, the header rule and the body's tint — so a
              // column's colour is set once here and never restated in the sheet.
              <section className="col" key={col.id} style={{ ["--zone" as string]: `var(${col.varName})` }}>
                <div className="col-hd">
                  <span className={`dot${col.glow ? " glow" : ""}`} />
                  <span className="nm">{col.label}</span>
                  <span className="rule" />
                  <span className="ct">{list.length}</span>
                </div>
                <div className="col-body">
                  {LANES[col.id]
                    ? LANES[col.id]!.flatMap((lane) => {
                        const inLane = list.filter((c) => c.lane === lane.id);
                        if (inLane.length === 0) return [];
                        return [
                          <div className="lane-hd" key={`h:${lane.id}`}>
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
        {/* One slot. `accountSlot` already returns null whenever a gap owns it,
            so this ternary is belt-and-braces rather than the rule — but a
            legend showing "gh is not signed in" beside "gh as oznasi1" would be
            self-contradicting, and this is the cheapest place to make that
            impossible. */}
        {ghNote
          ? <span className="note warn">{ghNote}</span>
          : ghAccount && (
              <span className="note acct">
                {`${ghAccount.cli} as `}
                <span className="who">{ghAccount.login}</span>
                {/* The count sits between the identity and the switch link on
                    purpose: it is the reason to press switch, so it reads as
                    "gh as oznasi1 · 6 runs unread · switch" — the fact, then the
                    remedy. Absent whenever every read succeeded. */}
                {!!ghAccount.unreadRuns && (
                  <span className="unread" title="The forge could not read these runs' pull requests — the cards say which repos">
                    {` · ${ghAccount.unreadRuns} run${ghAccount.unreadRuns === 1 ? "" : "s"} unread`}
                  </span>
                )}
                {ghAccount.canSwitch && (
                  <>
                    {" · "}
                    <button type="button" className="lnk" onClick={() => send({ type: "deck:switchAccount" })}>
                      switch
                    </button>
                  </>
                )}
              </span>
            )}
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
          // Independent of `openFlowId`/`view` — see `orchOpen`'s own doc
          // comment above for why Active/Templates need this said explicitly,
          // and why Canvas does not: leaving this component mounted whenever
          // `orchEnabled` (unconditionally, exactly as before this task) is
          // what lets its OWN `useDrawerExit` machinery animate Canvas's exit
          // when a flow closes — gating this render on `orchOpen` instead
          // would yank the component out of the tree the instant it flips,
          // with no chance to slide out.
          open={orchOpen}
          // The full list, not `live`: a flow's place node binds a run key, and a
          // run shelving as closed must not make its own node unresolvable.
          runs={runs}
          pendingResume={pendingResume}
          promptModes={promptModes}
          commands={commands}
          branchCi={branchCi}
          templates={templates}
          draftTemplate={draftTemplate}
          view={orchView}
          onView={setOrchView}
          // One row per card carrying a workflow, read from `workflowByCard` —
          // the SAME map the board's own chip reads above, so this list and
          // the board can never name a different workflow, or a different
          // state, for the same card.
          rows={activeRows}
          // Mirrors `DeckDetail`'s own `onOpenWorkflow` the other way: that
          // one opens a workflow FROM a card (closes the card, opens the
          // drawer); this one opens a card FROM its workflow row (closes the
          // drawer, opens the card), so the workflow is read where it lives.
          onOpenCard={(cardId) => { setOpenFlowId(null); setOrchOpen(false); setSelId(cardId); }}
          onClose={() => { setOpenFlowId(null); setOrchOpen(false); }}
          onCreate={() => send({ type: "flow:create" })}
          onOpen={(id) => setOpenFlowId({ kind: "flow", id })}
          onRename={(id, name) => send({ type: "flow:rename", id, name })}
          // Every graph edit on the canvas — drag, add a node, edit a
          // field — goes through this one prop. A `flow` target sends it
          // straight to the host, same as always; but the OPEN draft
          // template has no file on disk for `flow:save` to find (the host
          // silently refuses a write against an id it does not recognise —
          // see that handler's own membership check), and "silently refuse"
          // is not "nothing happened": the edit would vanish, since nothing
          // else holds it either. So an edit to the draft's own flow is kept
          // right here instead, in `draftTemplate` state, and never reaches
          // `send` at all — which is the same property "＋ New template…"
          // itself promises (see `mintDraftTemplate`'s own doc comment).
          onSave={(flow) => {
            if (draftTemplate && openFlowId?.kind === "template" && openFlowId.id === draftTemplate.id) {
              setDraftTemplate({ ...draftTemplate, flow });
              return;
            }
            send({ type: "flow:save", flow });
          }}
          onDelete={(id) => send({ type: "flow:delete", id })}
          onArm={(id, armed) => send({ type: "flow:arm", id, armed })}
          onResumeApprove={(id) => send({ type: "flow:resumeApprove", id })}
          onResumeDisarm={(id) => send({ type: "flow:resumeDisarm", id })}
          onResetEdge={(id, edgeId) => send({ type: "flow:resetEdge", id, edgeId })}
          // "＋ New template…", on the Templates screen and on Canvas's own
          // blank-flow empty state alike (Task 13; see that empty state's own
          // comment). Reopens the SAME in-flight draft rather than minting a
          // second one — see `draftTemplate`'s own doc comment for why only
          // one exists at a time. NOT `onCreate`: that mints an ordinary
          // WORKFLOW and used to sit here under a "＋ New template" label
          // (see the git history on the Templates screen's own comment) —
          // the wrong verb, since the panel would close, Templates would
          // stay empty, and an untitled entry would appear on the board
          // instead. This mints a TEMPLATE, in memory, and sends nothing.
          onNewTemplate={() => {
            setSelId(null);
            const draft = draftTemplate ?? mintDraftTemplate();
            if (!draftTemplate) setDraftTemplate(draft);
            setOpenFlowId({ kind: "template", id: draft.id });
            setOrchView("canvas");
            setOrchOpen(true);
          }}
          // Leaves template-editing entirely, back to the Templates screen —
          // called both by the canvas's own Cancel button (discarding
          // whatever draft is open) and right after its Save sends
          // `flow:writeTemplate` (the draft's job is done; the real template
          // arrives on the next `deck:flows` post). Clearing `draftTemplate`
          // when the target being left is not actually the draft (a future,
          // still-unreachable path for editing an already-saved template) is
          // a harmless no-op — there is nothing there to clear.
          onCancelTemplate={() => {
            setDraftTemplate(null);
            setOpenFlowId(null);
            setOrchView("templates");
          }}
        />
      )}

      {shownCard && (
        <DeckDetail
          card={shownCard}
          sourceLabel={sourceLabel}
          closing={ddClosing}
          /* Eager total first when the header sweep is on, else the on-demand read.
             `undefined` means still waiting; `null` means the host tried and
             failed. The drawer renders three distinct states from that. */
          usage={shownCard.status.usage ?? lazyUsage[shownCard.status.run.key]}
          flows={flows}
          templates={templates}
          // The full list, not `live`: same reasoning as the Orchestrator drawer's
          // own `runs` prop above — a place node binds a run key, and a run
          // shelving as closed must not make its own node unresolvable.
          runs={runs}
          branchCi={branchCi}
          orchEnabled={orchEnabled}
          onClose={() => setSelId(null)}
          onForget={forget}
          // Same pairing the Orchestrator chip's own onClick uses above (open the
          // Orchestrator, close the card): the two drawers share one slot, so
          // opening one here has to close the other explicitly rather than
          // trusting a render order.
          onOpenWorkflow={(id) => { setOrchView("canvas"); setOpenFlowId({ kind: "flow", id }); setOrchOpen(true); setSelId(null); }}
        />
      )}
    </>
  );
}
