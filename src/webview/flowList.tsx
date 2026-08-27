// The keyboard path onto a flow. A canvas built from divs and pointer events
// (OrchestratorDrawer.tsx's graph) has no usable keyboard story of its own —
// there is no browser-native tab order over an absolutely-positioned node you
// drag with a pointer. Shipping the graph as the only way to edit a flow
// would make the whole feature unreachable without a mouse, which is why this
// file exists at all (see the design doc's own words, quoted in this phase's
// task brief).
//
// "One model, two presentations": this component takes the SAME `Flow` and
// writes back through the SAME `onSave`/`onResetEdge` the canvas already
// uses. Every read of what a rule means (its condition's wording, whether its
// action is even possible for its target, what a fired rule's receipt says)
// and every write of an edit comes from orchestratorRule.ts, which
// OrchestratorDrawer.tsx's own inspector shares — not a second copy of either
// living in this file. A second copy, even a faithful one today, is exactly
// the drift "one model, two presentations" is warning against.
import * as React from "react";
import { CondKind, Condition, edgeAction, Flow, FlowEdge, isSettled, LaunchDest } from "../engine/orchestrator/model";
import { FlowCommand, FlowPromptMode, RunStatus } from "../types";
import {
  ACTION_LABEL,
  COMMAND_FREE_TEXT,
  COMMAND_NOT_SET,
  commandFieldsOf,
  commandTargetOf,
  condOffered,
  condOptionLabel,
  isBareCond,
  seedCond,
  sourceRepoOfNode,
  COND_LABEL,
  defaultCondFor,
  DEST_LABEL,
  endLabel,
  isMigrationNotice,
  launchDestOf,
  modeDisplayLabel,
  modeValueOf,
  nextEdgeId,
  NOTE_ARIA_LABEL,
  NOTE_COMMAND_HINT,
  NOTE_COMMAND_PLACEHOLDER,
  NOTE_PLACEHOLDER,
  notifyMessageOf,
  offeredConds,
  repoOptions,
  OFFERED_DESTS,
  truncatedNote,
  withCommandId,
  withCommandRun,
  withCond,
  withCondParams,
  withDest,
  withMode,
  withNote,
  withNotifyMessage,
  withoutEdge,
} from "./orchestratorRule";
import { CondParams } from "./CondParams";

export interface FlowListProps {
  flow: Flow;
  /** The board, which this file reads for exactly one thing so far: the checkout
   * names a `branch-ci-passed` rule's repo picker offers (`repoOptions`). It was
   * carried unused for a while before that, because the canvas's own props carry
   * it (`OrchestratorDrawerProps.runs`) and "the same callbacks the canvas already
   * uses" means the same SHAPE, not a narrower one invented for this file. A
   * future row that shows what a place currently looks like (the inspector's
   * `observationOf`) reads it from here too. */
  runs: RunStatus[];
  promptModes: FlowPromptMode[];
  /** `agentFlow.commands`, from the same `deck:flows` post the canvas reads it
   * from — and here for the same reason the canvas needs it: a rule that runs a
   * command names one of these, and the ONLY place a rule's command can be
   * chosen or its free text typed used to be the canvas inspector. A command
   * node reachable from the keyboard whose command was not is the same
   * one-step-short gap phase 3 shipped for `planned` work (a launch path
   * nothing in the UI could create a target for). */
  commands: FlowCommand[];
  onSave: (flow: Flow) => void;
  onResetEdge: (edgeId: string) => void;
}

/** The sentence a row reads as, and — when `open` — the ordinary form
 * controls that edit it. Not a component of its own: it closes over `flow`/
 * `onSave`/`promptModes` from `FlowList` rather than re-accepting them as
 * props, because nothing else ever renders a rule's sentence on its own. */
function ruleSentence(
  flow: Flow,
  e: FlowEdge,
  open: boolean,
  promptModes: FlowPromptMode[],
  commands: FlowCommand[],
  /** Every checkout the board can see — `repoOptions(runs)`, computed once by
   * `FlowList` rather than per row, since every row offers the same list. */
  repos: string[],
  onSave: (f: Flow) => void,
): JSX.Element {
  const modeValue = modeValueOf(flow, e);
  const modeExists = modeValue !== "" && promptModes.some((m) => m.id === modeValue);
  const dest = launchDestOf(flow, e) ?? "worktree";
  // Computed once here rather than at each of the two spots below that would
  // otherwise call it themselves — both a closed row's presence check and
  // its rendered text want the exact same string.
  const noteText = truncatedNote(e.note);
  // What this rule DOES: the action its target implies, never the one stored on
  // the edge. Read as `e.action ?? edgeAction(flow, e)` this row disagreed with
  // the canvas inspector, which derives (Task 9) — a stale stored `notify` on a
  // place target read as "Notify me in VS Code" here and as "seed" there, for
  // one rule. The store latches such a disagreement on the next read and its
  // notice is what reports it (see `isMigrationNotice`); the sentence's job is
  // to describe the rule as it will actually behave.
  //
  // `undefined` means a missing target, or a node kind this build does not know
  // — `store.ts`'s `validNode` admits one on purpose so a flow written by a
  // newer build still renders. Every read below treats that as "cannot say",
  // never as a reason to pick a verb.
  const derived = edgeAction(flow, e);
  /** The rule's target command node, when it has one — the `run` counterpart of
   * the planned target `modeValueOf`/`launchDestOf` read — and what its two
   * controls read. Through `commandFieldsOf`, which the canvas's two inspectors
   * spend as well: this row used to derive the same three values from the same
   * fields by hand, "exactly as the inspector's own does", which is a comment
   * rather than a guarantee. */
  const cmd = commandFieldsOf(commandTargetOf(flow, e), commands);

  const setCond = (kind: Condition["kind"]) => {
    const next = withCond(flow, e.id, kind);
    // See `withCond`'s own doc comment: it hands back `flow` itself, the
    // same reference, for the two kinds this picker never offers.
    if (next !== flow) onSave(next);
  };

  /** The note, once — an open row edits it, a closed one shows it truncated
   * (nothing at all when there is none). One element for all three acting
   * verbs, with only its PLACEHOLDER differing: `NOTE_PLACEHOLDER` spends its
   * whole width contrasting "note" with "mode", and a command rule has no mode
   * on screen to contrast with — see `NOTE_COMMAND_PLACEHOLDER`. Two hand-copied
   * inputs, one per branch, is how the command note ended up carrying the
   * mode-contrast placeholder in the first place. */
  const noteField = open ? (
    <input
      className="orch-msg"
      aria-label={NOTE_ARIA_LABEL}
      key={`${e.id}-note`}
      defaultValue={e.note ?? ""}
      placeholder={derived === "run" ? NOTE_COMMAND_PLACEHOLDER : NOTE_PLACEHOLDER}
      onBlur={(ev) => onSave(withNote(flow, e, ev.currentTarget.value))}
    />
  ) : noteText ? (
    <span>&ldquo;{noteText}&rdquo;</span>
  ) : null;

  return (
    <>
      <span className="orch-kw">WHEN</span>
      {open ? (
        <select
          className="orch-sel"
          aria-label="Condition"
          value={e.cond.kind}
          onChange={(ev) => setCond(ev.currentTarget.value as Condition["kind"])}
        >
          {/* An option for this rule's own condition when the picker does not
              offer that kind. Without it `selectedIndex` is -1 and the control
              renders BLANK — which is how a hand-authored `branch-ci-passed`
              rule showed an empty Condition select in an open row while the
              CLOSED row read it correctly. `condOptionLabel` names the repo and
              branch that `COND_LABEL`, keyed by kind alone, cannot. */}
          {!condOffered(flow, e) && (
            <option value={e.cond.kind}>{condOptionLabel(e.cond)}</option>
          )}
          {/* Per SOURCE: `command-succeeded` can only ever be answered for a
              rule out of a command node, and every place-shaped condition only
              for one out of a place — see `offeredConds`. */}
          {offeredConds(flow, e.from).map((k) => (
            <option key={k} value={k}>{COND_LABEL[k]}</option>
          ))}
        </select>
      ) : (
        // `condOptionLabel`, not `COND_LABEL`: a closed row was already honest
        // about the KIND, but said "branch CI passed…" without ever saying
        // which branch — and the ellipsis promised a parameter it then never
        // showed. Same string the open row's own option spends.
        <span>{condOptionLabel(e.cond)}</span>
      )}
      {/* The condition's own parameters, INLINE — a repo picker and a branch
          field sitting in the sentence between WHEN and THEN, which is where
          they read: "WHEN branch CI passed… repo agent-flow branch main THEN
          launch ASM-12". The canvas gives them a row of their own instead,
          because its clauses stack; the fields themselves are the same
          component, which is the whole point of `CondParams` (see its header).

          Open rows only. A closed row already says which branch it watches —
          `condOptionLabel` above is what names it — and a closed row is a
          sentence to scan, not a form. */}
      {open && !isBareCond(e.cond.kind) && (
        <CondParams
          cond={e.cond}
          repos={repos}
          editKey={e.id}
          onEdit={(patch) => onSave(withCondParams(flow, e.id, patch))}
        />
      )}

      {/* THEN is a STATEMENT, not a choice — the same conclusion Task 9 reached
          for the canvas inspector, for a reason that applies word for word
          here. The action is whatever the target implies, so a `<select>` could
          not decide anything: its pick was overridden by the target on the next
          read AND stored, which is precisely the disagreement
          `latchActionMismatches` (store.ts) stamps an edge dead for. This
          control offered three of the four verbs, so a `run` rule's value
          matched no option — blank in a browser, "launch" under jsdom — and
          touching it wrote a stored action that killed the rule on the next
          poll. The way to change what a rule does is to point it at a different
          node, which in this presentation is the To node picker below.

          `data-testid` because the verb is derived TEXT rather than a labelled
          control, and a row-wide text assertion cannot pin it: "run" is a
          substring of the note hint's own "…a note can extend what runs", so an
          assertion on the row's text passes even with no verb rendered at all
          (measured on the canvas, twice). Per row, since a list renders many. */}
      <span className="orch-kw">THEN</span>
      <span
        data-testid={`flowlist-then-${e.id}`}
        // Not red — nothing has tried and failed; "cannot say" gets the same
        // dim, low-key treatment the inspector gives it, in the inspector's
        // own words (two presentations of one model must not describe one
        // state two ways).
        style={derived === undefined ? { fontSize: "var(--t-micro)", color: "var(--dim)" } : undefined}
      >
        {derived === undefined ? "this rule’s action can’t be determined" : ACTION_LABEL[derived]}
      </span>
      {/* Same rule the inspector follows: notify already reads complete on its
          own ("THEN Notify me in VS Code"); launch and seed need the target's
          identifier — mono, house style for an identifier — to finish the
          clause. A `run` needs it too, on a CLOSED row, which is the only
          reading of what it runs a scanning user gets; in an OPEN one the
          Command picker right below names it, and printing it here as well
          would give one rule's own name twice in the same row. */}
      {derived !== undefined && derived !== "notify" && !(derived === "run" && open) && (
        <span style={{ fontFamily: "var(--mono)" }}>{endLabel(flow, e.to)}</span>
      )}

      {derived === "notify" ? (
        open ? (
          <input
            className="orch-msg"
            aria-label="Notify message"
            key={e.id}
            defaultValue={notifyMessageOf(flow, e)}
            onBlur={(ev) => onSave(withNotifyMessage(flow, e, ev.currentTarget.value))}
          />
        ) : (
          <span>&ldquo;{notifyMessageOf(flow, e)}&rdquo;</span>
        )
      ) : derived === "run" ? (
        // No USING <Mode> clause and no destination: a command is not an agent
        // session. `run` used to fall through to the launch/seed branch, so a
        // closed row read "THEN run deploy USING (no mode set)" — a clause about
        // a field nothing reads for `run` — and the open row's Mode select wrote
        // `edge.mode`, which `performEdge` never looks at for a command.
        <>
          {open && (
            <>
              <span className="orch-kw">USING</span>
              <select
                className="orch-sel"
                aria-label="Command"
                value={cmd.value}
                onChange={(ev) =>
                  onSave(
                    ev.currentTarget.value === COMMAND_FREE_TEXT
                      ? withCommandRun(flow, e, "")
                      : withCommandId(flow, e, ev.currentTarget.value),
                  )
                }
              >
                {/* Same reasoning as the Mode select's own extra option: a
                    `<select>` whose value matches none of its options silently
                    shows the FIRST one instead, so a node naming a command that
                    is not (or no longer) in `agentFlow.commands` would read as
                    the first configured one while `resolveCommand` refuses it
                    outright — and a hand-edited node carrying neither field must
                    say so rather than look like a command that exists. */}
                {!cmd.idExists && (
                  <option value={cmd.value}>
                    {cmd.value === "" ? COMMAND_NOT_SET : `${cmd.value} (not configured)`}
                  </option>
                )}
                {commands.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
                {/* Last, and always present: `agentFlow.commands` ships no
                    built-ins, so for most users this is the only entry — and
                    without it the keyboard path could reach a command node but
                    never type what it runs. */}
                <option value={COMMAND_FREE_TEXT}>Free-text command…</option>
              </select>
              {/* Shown whenever the node is IN the free-text shape (`run`
                  present, even blank) — exactly what the Add-command picker's
                  own free-text option creates. This field is what makes the
                  keyboard path complete: without it, a free-text command node
                  added from the keyboard could only ever be filled in on the
                  canvas. */}
              {cmd.run !== undefined && (
                <input
                  className="orch-msg"
                  aria-label="Command to run"
                  key={`${e.id}-run`}
                  defaultValue={cmd.run}
                  placeholder="deploy.sh --env=staging"
                  onBlur={(ev) => onSave(withCommandRun(flow, e, ev.currentTarget.value))}
                />
              )}
            </>
          )}
          {noteField}
          {/* Said where the note is TYPED, because this is the field that makes
              it true — `command.ts`'s `withNote` splices a note into the command
              string unquoted, so `deploy.sh --env={note}` with a note of
              `prod; rm -rf ~` runs both. It was disclosed at the inspector's
              note field and nowhere else, i.e. at one of the two surfaces where
              a command note is typed. Dim, not red and not a warning icon:
              nothing has failed, this is how a feature the user chose works. */}
          {open && (
            <span style={{ fontSize: "var(--t-micro)", color: "var(--dim)" }}>{NOTE_COMMAND_HINT}</span>
          )}
        </>
      ) : derived === "launch" || derived === "seed" ? (
        <>
          <span className="orch-kw">USING</span>
          {open ? (
            <select
              className="orch-sel"
              aria-label="Mode"
              value={modeValue}
              onChange={(ev) => onSave(withMode(flow, e, ev.currentTarget.value))}
            >
              {!modeExists && <option value={modeValue}>{modeDisplayLabel(promptModes, modeValue)}</option>}
              {promptModes.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          ) : (
            <span>{modeDisplayLabel(promptModes, modeValue)}</span>
          )}
          {/* The note, right after the mode — a closed row shows it
              truncated (`truncatedNote`, empty for none), an open row edits
              it directly, same `withNote` the inspector writes through.
              Prose, so no mono; never a second filled control. */}
          {noteField}
          {/* A place already exists, so `seed` has nothing to pick a
              destination for — only `launch` opens one, same as the
              inspector. */}
          {derived === "launch" && (
            <>
              <span style={{ fontSize: "var(--t-body)" }}>in a</span>
              {open ? (
                <select
                  className="orch-sel"
                  aria-label="Destination"
                  value={dest}
                  onChange={(ev) => onSave(withDest(flow, e, ev.currentTarget.value as LaunchDest))}
                >
                  {OFFERED_DESTS.map((d) => <option key={d} value={d}>{DEST_LABEL[d]}</option>)}
                </select>
              ) : (
                <span>{DEST_LABEL[dest]}</span>
              )}
            </>
          )}
        </>
      ) : null}
    </>
  );
}

/** Add a rule, from the keyboard: the from-node, the to-node, the condition,
 * and — where the derived action needs them — the mode and destination.
 * Ordinary form controls, the same as an open row's own.
 *
 * There is no action control and no action WRITTEN, which is the same shape
 * `finishWire` (OrchestratorDrawer.tsx) creates on the canvas and for the same
 * reason: an edge with no stored action is the one shape
 * `latchActionMismatches` (store.ts) can never latch, since it skips
 * `action === undefined`, while `writeFlow` still puts the derived value on disk
 * for an older build's `validEdge`. This bar used to store whatever its own
 * `<select>` said, and that select offered three of the four verbs — so a rule
 * built from a place to a COMMAND node saved `action: "notify"` against a target
 * that means `run`, and `flow:save`/`postFlows` showed the user the rule die on
 * the next poll. The same was true, unremarked, of the default `notify` against
 * a PLACE target, which means `seed`. Deriving instead of storing closes both:
 * the target IS the verb, so a disagreement cannot be built here at all. */
function NewRuleBar(p: {
  flow: Flow;
  promptModes: FlowPromptMode[];
  /** Every checkout on the board — `repoOptions(runs)`, the same list every open
   * row's repo picker offers. */
  repos: string[];
  onSave: (f: Flow) => void;
}): JSX.Element | null {
  const { flow, promptModes, repos, onSave } = p;
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  // A whole `Condition`, not a bare kind. This used to be a `CondKind` because
  // the picker only ever offered kinds that need no parameter — that filter is
  // gone (see `OFFERED_CONDS`), and a `{ kind }` cast to fit would now build a
  // `branch-ci-passed` rule with no `repo` and no `branch` fields at all: not
  // merely an unfired rule but a record no reader in the engine is written for.
  // Holding the real shape means the bar builds exactly what it shows, and
  // `seedCond` is what fills it in — the same seeds the inspector's own picker
  // spends, so one choice cannot mean two things depending on where it was made.
  const [cond, setCond] = React.useState<Condition>({ kind: "pr-merged" });
  // Seeded from nothing in particular — there is no `to` chosen yet for
  // either to describe anything about. The moment a `to` IS chosen, the
  // "To node" handler below reseeds both from `modeValueOf`/`launchDestOf` —
  // what that node's own launch config, or this brand-new edge, already says —
  // rather than leaving these generic defaults to be written over it. See
  // `addRule`'s own comment for why that distinction matters.
  const [mode, setMode] = React.useState(promptModes[0]?.id ?? "");
  const [dest, setDest] = React.useState<LaunchDest>("worktree");
  /** Does `mode` name a mode that still exists? The SAME question an open row and
   * the canvas inspector each ask before rendering their own Mode select, and this
   * bar was the only one of the three that did not ask it. It matters because
   * `seedModeAndDest` below seeds `mode` from the target planned node, which can
   * carry an id `agentFlow.promptModes` no longer has (or never had) — and a
   * `<select>` whose value matches none of its options does not render blank, it
   * shows its FIRST option, selected. So the bar read "USING Quick pass" while
   * "+ Add rule" wrote the store's real `gone-mode`, which `modeFor` then refuses
   * at fire time. The closed row one panel away said "gone-mode (not configured)"
   * correctly the whole time. */
  const modeExists = mode !== "" && promptModes.some((m) => m.id === mode);

  // A half-built rule belongs to the flow you were looking at when you
  // started it — switching flows (the "Flows · N ▾" switcher, still visible
  // while List is open) must not leave a draft's `from`/`to` pointing at node
  // ids that belong to whichever flow was open a moment ago. Keyed on
  // `flow.id`, not `flow` itself: every OTHER edit to the open flow (adding a
  // node, adding a rule) is a new `Flow` object too, and clearing the draft
  // on each of THOSE would undo the very thing this bar just did.
  React.useEffect(() => {
    setFrom("");
    setTo("");
    setCond({ kind: "pr-merged" });
    setMode(promptModes[0]?.id ?? "");
    setDest("worktree");
    // eslint has no opinion in this repo (no config), but the omission of
    // `promptModes` is deliberate anyway: a config push mid-edit changing
    // which modes exist is not "the flow changed", and re-running this on
    // every `promptModes` identity change would be a second, unrelated
    // reason for a draft to reset.
  }, [flow.id]);

  /** What a freshly chosen `to` already says about its mode and destination —
   * read through the SAME `modeValueOf`/`launchDestOf` every other presentation
   * of a rule uses, on a throwaway edge shaped like the one about to be created.
   * Where that edge's action would be is deliberately empty: both functions ask
   * `edgeAction` — the TARGET — which is the only thing that decides here now.
   * For a launch, this reads the target PLANNED node's own `mode`/`dest` — set
   * once, at Add planned work's four QuickPicks, and never silently overwritten
   * by a hardcoded default just because a NEW rule happened to be the thing that
   * wrote next. For a seed there is no pre-existing value to protect (the mode
   * lives on the edge itself, which does not exist yet), so this falls back to
   * the first configured mode. */
  const seedModeAndDest = (toId: string) => {
    const probe: FlowEdge = { id: "draft", from, to: toId, cond };
    setMode(modeValueOf(flow, probe) || promptModes[0]?.id || "");
    setDest(launchDestOf(flow, probe) ?? "worktree");
  };

  // Only a non-`notify` node ever had an out-port on the canvas (see
  // OrchestratorDrawer.tsx's own `orch-port out`, rendered for every node
  // except a notify terminal) — a notify node can never be a rule's source
  // here either, for the identical reason. No nodes at all, or nodes that are
  // ALL notify terminals, leaves nothing to build a rule from; there is
  // nothing useful this bar can offer in that case, so it renders nothing
  // rather than a picker with an empty "From" list and a permanently disabled
  // button.
  const sources = flow.nodes.filter((n) => n.kind !== "notify");
  if (sources.length === 0) return null;

  // Excludes `from` itself (no self-loop) and any node `from` already has an
  // edge to (the exact duplicate `finishWire`'s own wiring already refuses on
  // the canvas). Nothing is excluded by target KIND, and no companion guard
  // decides one either — every kind is a legitimate target now that the target
  // is what DECIDES the verb rather than something a chosen verb could disagree
  // with. This list used to be paired with a kind guard (`actionMismatch`),
  // which is the pairing that has gone, not moved.
  const targets = flow.nodes.filter(
    (n) => n.id !== from && !flow.edges.some((e) => e.from === from && e.to === n.id),
  );

  /** The edge this bar would create, as it stands — with NO `action` field, the
   * one shape `latchActionMismatches` can never latch (see this component's own
   * doc comment). `edgeAction` reads the verb off it exactly as every other
   * presentation of a rule does. */
  const draft: FlowEdge | null = from && to ? { id: "draft", from, to, cond } : null;
  /** What the drafted rule will DO, once a `to` names a node: whatever that node
   * implies. `undefined` before a `to` is chosen (nothing to derive from yet) and
   * also for a target of a kind this build does not know — `store.ts`'s
   * `validNode` admits one on purpose, so a flow written by a newer build can put
   * such a node in the To list. The two are told apart by `draft` itself, since
   * only the second can be `undefined` with a draft in hand. */
  const derived = draft ? edgeAction(flow, draft) : undefined;

  const addRule = () => {
    // `from` and `to` are plain component state, and the effect above only
    // clears them when `flow.id` itself changes — so every node id they hold
    // still belongs to whichever flow was open when the select was touched, and
    // a node removed from THIS flow in the meantime (the tray's own delete)
    // leaves the draft naming something that is no longer there. Nothing else
    // catches it: there is no target-kind refusal left to piggyback on now that
    // the target IS the verb, and `edgeAction` answering `undefined` for a
    // missing node is not a refusal either — it is the same answer an unknown
    // node kind gives, which is a rule this bar is allowed to build.
    const fromExists = flow.nodes.some((n) => n.id === from);
    const toExists = flow.nodes.some((n) => n.id === to);
    if (!draft || !fromExists || !toExists) return;
    const id = nextEdgeId(flow);
    const finalEdge: FlowEdge = { ...draft, id };
    let next: Flow = { ...flow, edges: [...flow.edges, finalEdge] };
    // `mode`/`dest` are seeded from the target's own truth the moment `to`
    // (or `action`) is chosen — see `seedModeAndDest` — so this write is a
    // no-op in the common case and an explicit, visible override in the
    // uncommon one. It is never a hardcoded default landing on a node whose
    // mode and destination were already chosen at Add planned work's own
    // QuickPicks; that silent overwrite was the bug this replaced.
    //
    // `derived`, not a stored action: `withMode` itself asks `edgeAction` which
    // of the two homes to write (the target planned node for a launch, the edge
    // for a seed), so the branch that decides whether to write at all has to
    // read the verb the same way or the two would disagree about one rule.
    if (derived === "seed") next = withMode(next, finalEdge, mode);
    if (derived === "launch") {
      next = withMode(next, finalEdge, mode);
      next = withDest(next, finalEdge, dest);
    }
    onSave(next);
    setFrom("");
    setTo("");
    setCond({ kind: "pr-merged" });
    // Reset too, not left to carry into the NEXT rule: `to` above always
    // clears back to "", so the next rule's own "To node" pick will reseed
    // these the moment it's made — but resetting here as well means nothing
    // is left showing a stale value in the gap before that pick happens.
    setMode(promptModes[0]?.id ?? "");
    setDest("worktree");
  };

  return (
    <div className="fl-newrule" data-testid="flowlist-newrule">
      <span className="orch-kw">WHEN</span>
      <select
        className="orch-sel"
        aria-label="From node"
        value={from}
        onChange={(ev) => {
          const val = ev.currentTarget.value;
          setFrom(val);
          setTo("");
          // The offered conditions depend on the SOURCE (see `offeredConds`), so
          // the draft's own condition has to be reseeded with it: leaving
          // `pr-merged` selected after choosing a command node would leave this
          // select's value out of its own option list — blank, and one click
          // from building a rule that can never be met.
          setCond(defaultCondFor(flow, val));
        }}
      >
        <option value="">choose a node…</option>
        {sources.map((n) => <option key={n.id} value={n.id}>{endLabel(flow, n.id)}</option>)}
      </select>
      <select
        className="orch-sel"
        aria-label="New rule condition"
        value={cond.kind}
        // `seedCond`, not `{ kind }`: a parameterised kind needs a value the
        // moment it is named, and the repo half of a `branch-ci-passed` rule is
        // seeded from whichever node `from` currently holds — the same guess
        // `withCond` makes on the other surface.
        onChange={(ev) =>
          setCond(seedCond(ev.currentTarget.value as Condition["kind"], sourceRepoOfNode(flow, from)))
        }
      >
        {offeredConds(flow, from).map((k) => <option key={k} value={k}>{COND_LABEL[k]}</option>)}
      </select>
      {/* The parameters, when the chosen kind has any — the same component the
          open rows below and the canvas inspector spend. Without it this bar
          could name `branch CI passed…` and then build a rule with no branch in
          it, which is precisely why the kind used to be filtered out of the
          picker instead. `editKey` is a constant here because there is only ever
          one draft: nothing else on screen can collide with it, and it must NOT
          change as the draft is edited or each keystroke would remount the field
          it was typed into. */}
      {!isBareCond(cond.kind) && (
        <CondParams
          cond={cond}
          repos={repos}
          editKey={`newrule-${cond.kind}`}
          onEdit={(patch) => setCond((c) => ({ ...c, ...patch }) as Condition)}
        />
      )}
      <span className="orch-kw">THEN</span>
      {/* A STATEMENT, exactly as in an open row and the canvas inspector — the
          To picker beside it is the only thing that decides the verb, so there
          is nothing for a second control to choose. Rendered only once a `to`
          has been picked: before that there is no target to derive anything
          from, and "can't be determined" would be a complaint about a rule the
          user has not finished describing yet.

          `data-testid` for the same reason both other surfaces have one: the
          verb is derived TEXT, and "run" is a substring of the note hint's own
          "…a note can extend what runs", so a bar-wide text assertion passes
          even with no verb rendered at all. */}
      {draft && (
        <span
          data-testid="flowlist-newrule-then"
          style={derived === undefined ? { fontSize: "var(--t-micro)", color: "var(--dim)" } : undefined}
        >
          {derived === undefined ? "this rule’s action can’t be determined" : ACTION_LABEL[derived]}
        </span>
      )}
      <select
        className="orch-sel"
        aria-label="To node"
        value={to}
        onChange={(ev) => {
          const val = ev.currentTarget.value;
          setTo(val);
          seedModeAndDest(val);
        }}
      >
        <option value="">choose a node…</option>
        {targets.map((n) => <option key={n.id} value={n.id}>{endLabel(flow, n.id)}</option>)}
      </select>
      {/* A `launch` or a `seed` spends a mode, and only a `launch` opens a
          destination — the same two rules an open row and the inspector follow.
          A `notify` has neither, and a `run` has neither either: a command is
          not an agent session (see the `run` branch of `ruleSentence`). What a
          command node RUNS is the node's own configuration, chosen where the
          node is added ("+ Add command…", one bar above this one) and editable
          in the rule's own open row — not a fourth control here. */}
      {derived === "launch" || derived === "seed" ? (
        <>
          <span className="orch-kw">USING</span>
          <select
            className="orch-sel"
            aria-label="New rule mode"
            value={mode}
            onChange={(ev) => setMode(ev.currentTarget.value)}
          >
            {/* An option for whatever the draft actually carries when it names no
                configured mode — the same extra option an open row (above) and the
                canvas inspector both render, through the same
                `modeDisplayLabel`, so all three name it identically. */}
            {!modeExists && <option value={mode}>{modeDisplayLabel(promptModes, mode)}</option>}
            {promptModes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {derived === "launch" && (
            <select
              className="orch-sel"
              aria-label="New rule destination"
              value={dest}
              onChange={(ev) => setDest(ev.currentTarget.value as LaunchDest)}
            >
              {OFFERED_DESTS.map((d) => <option key={d} value={d}>{DEST_LABEL[d]}</option>)}
            </select>
          )}
        </>
      ) : null}
      {/* `disabled` only for an INCOMPLETE draft (no from, or no to) — there is
          nothing yet to attempt. Every COMPLETE draft is now buildable: there is
          no target-kind pairing left to refuse, because the target is the verb.
          The one refusal that remains is `addRule`'s own stale-draft guard (a
          node deleted from under a half-built rule), which stays a guard rather
          than a disabled button for the same reason the tray's drop handler
          stays a live target for a payload it is about to refuse (see
          OrchestratorDrawer.tsx's "ignores a malformed payload" case). */}
      <button type="button" className="orch-mini" disabled={!draft} onClick={addRule}>
        + Add rule
      </button>
    </div>
  );
}

export function FlowList(p: FlowListProps): JSX.Element {
  const { flow } = p;

  /** Which row Up/Down currently sits on. Not necessarily in range once a
   * Delete has shrunk `flow.edges` — see `focusedIndex` below, which clamps
   * it for every read. Kept as its own piece of state (rather than always
   * deriving it from DOM focus) so a row still knows which of its siblings
   * to move to on ArrowDown/Up without asking the DOM first. */
  const [focusedIndexRaw, setFocusedIndexRaw] = React.useState(0);
  /** The one row currently open for editing, or `null`. At most one at a
   * time — this is what lets every open-row control below use a plain
   * `aria-label` ("Condition", "Mode", "Command", ...) without colliding: a
   * list of near-identical rows is exactly where a query for "the" Condition
   * select would otherwise match more than one element. (Deliberately NOT
   * "Action": there is no action control, and this file must not grow one —
   * see the `THEN` clause's own comment in `ruleSentence`.) */
  /** Every checkout on the board, for the repo picker a `branch-ci-passed` rule
   * opens with. Once per render, not once per row: every row offers the same
   * list, and `repoOptions` sorts. */
  const boardRepos = repoOptions(p.runs);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const rowRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  /** Where focus goes once the last rule is deleted and the empty state
   * below replaces the row list entirely. There is no row left to hand
   * focus to at that point — see `onDeleteRule`'s own comment — so this is
   * the deliberate landing spot, focused by the effect right below, rather
   * than letting the browser drop focus to <body> when the row that held it
   * unmounts. */
  const emptyRef = React.useRef<HTMLDivElement | null>(null);
  const wasEmpty = React.useRef(flow.edges.length === 0);

  const rows = flow.edges;
  React.useEffect(() => {
    // Fires only on the transition INTO empty — never on mount with an
    // already-empty flow (nothing to steal focus FROM in that case) and
    // never again while it stays empty (each edge in `rows.length` only
    // changes when a delete — the only mutation this file makes to the
    // edge count — actually happens).
    if (!wasEmpty.current && rows.length === 0) emptyRef.current?.focus();
    wasEmpty.current = rows.length === 0;
  }, [rows.length]);
  // Clamped on every read, not just after a delete: it is cheap, and it means
  // nothing else in this file has to remember to re-clamp it.
  const focusedIndex = Math.min(focusedIndexRaw, Math.max(rows.length - 1, 0));

  /** Roving tabindex: exactly ONE row (`focusedIndex`) carries `tabIndex={0}`;
   * every other row carries `tabIndex={-1}`. Tab lands on the list once, at
   * whichever row is "current"; Up/Down then move `focusedIndex` (and the
   * real DOM focus alongside it, imperatively, in the handlers below) without
   * ever touching the Tab order itself. The alternative — every row
   * `tabIndex={0}` — is what a screen reader or keyboard user would actually
   * feel: a 20-rule flow would cost twenty separate Tab presses just to get
   * past the list to whatever comes after it. One stop in, arrow around
   * inside, one stop out. */
  const rowTabIndex = (i: number): 0 | -1 => (i === focusedIndex ? 0 : -1);

  const onDeleteRule = (i: number, e: FlowEdge) => {
    if (openId === e.id) setOpenId(null);
    // Only when a row actually survives: the row sliding UP into this slot
    // (`i + 1`, in the array as it stands right NOW, before removal) if there
    // is one, else the row that was already just above it. Focusing it
    // before calling `onSave` matters: React reconciles the shorter array by
    // key, so this exact node keeps the DOM focus it already has rather than
    // the browser dropping focus to <body> the instant the deleted row's own
    // node unmounts.
    //
    // When this is the LAST row (`rows.length === 1`), that computation
    // degenerates to `i` itself — the very node being deleted — so it is
    // skipped entirely here. There is nothing left to focus among the rows;
    // the list is about to be replaced by the empty state, and the effect
    // above hands focus to THAT once it exists, rather than leaving the
    // about-to-unmount node as the last thing focus touched (which is
    // exactly what silently drops focus to <body> the instant it goes away).
    if (rows.length > 1) {
      const stays = i + 1 < rows.length ? i + 1 : Math.max(i - 1, 0);
      rowRefs.current[stays]?.focus();
      setFocusedIndexRaw(i + 1 < rows.length ? i : Math.max(i - 1, 0));
    }
    p.onSave(withoutEdge(flow, e.id));
  };

  const onRowKeyDown = (ev: React.KeyboardEvent<HTMLDivElement>, i: number, e: FlowEdge) => {
    // Escape is handled regardless of which descendant inside an OPEN row
    // actually has focus — pressing it while typing the notify message must
    // still close the row, not merely bubble past the input as text. It is
    // the one row-level key that isn't itself a list-navigation action.
    if (ev.key === "Escape") {
      if (openId !== e.id) return;
      ev.preventDefault();
      setOpenId(null);
      rowRefs.current[i]?.focus();
      return;
    }
    // Every key below IS a list-navigation action, and none of them may fire
    // from inside an open row's own controls: ArrowDown/Up inside a <select>
    // changes ITS value (the browser's native behaviour), Delete inside the
    // notify-message <input> deletes a character, and Enter/Space on a
    // <button> activates it. Without this guard, this row-level handler
    // would ALSO treat every one of those as "move to the next row" / "delete
    // the whole rule" / "open (already-open) editing" the moment the bubbled
    // event reached it.
    if (ev.target !== ev.currentTarget) return;
    switch (ev.key) {
      case "ArrowDown": {
        ev.preventDefault();
        const next = Math.min(i + 1, rows.length - 1);
        setFocusedIndexRaw(next);
        rowRefs.current[next]?.focus();
        break;
      }
      case "ArrowUp": {
        ev.preventDefault();
        const prev = Math.max(i - 1, 0);
        setFocusedIndexRaw(prev);
        rowRefs.current[prev]?.focus();
        break;
      }
      case "Enter":
      case " ":
        ev.preventDefault();
        setOpenId(e.id);
        break;
      case "Delete":
        ev.preventDefault();
        onDeleteRule(i, e);
        break;
      default:
        break;
    }
  };

  // Both branches below now sit above the SAME `NewRuleBar` (rendered once,
  // after this `if`) — there being no rows yet is no longer a dead end that
  // sends you back to the canvas to make one, now that a rule can be built
  // right here.
  const body = rows.length === 0 ? (
    // Not a hint line on a card (the house rule those forbid) — an empty
    // state for the list itself, the same job `.orch-empty` does for the
    // canvas when a flow has no nodes yet.
    //
    // `tabIndex={-1}`: focusable by the `emptyRef` effect above (deleting
    // the last rule lands focus here on purpose, deliberately, rather than
    // losing it to <body>), but not a stop an ordinary Tab press should
    // land on — there is nothing here to DO, only something to read.
    <div className="orch-empty" data-testid="flowlist-empty" ref={emptyRef} tabIndex={-1}>
      No rules yet.
    </div>
  ) : (
    <div className="fl-list" role="list" aria-label="Rules" data-testid="orch-list">
      {rows.map((e, i) => {
        const open = openId === e.id;
        const settled = isSettled(e);
        return (
          <div
            key={e.id}
            ref={(el) => { rowRefs.current[i] = el; }}
            data-testid={`flowlist-row-${e.id}`}
            className={`fl-row${open ? " open" : ""}`}
            role="listitem"
            tabIndex={rowTabIndex(i)}
            onKeyDown={(ev) => onRowKeyDown(ev, i, e)}
            onClick={() => {
              setFocusedIndexRaw(i);
              setOpenId(e.id);
            }}
          >
            {/* Clicks on a control inside an open row (a <select>, the Reset
                button) bubble here too — stopping them keeps a control click
                from also re-running the row's own onClick, which does
                nothing harmful today (it would just re-set state already at
                these values) but would stop being harmless the moment this
                row's onClick grows anything with a side effect beyond
                opening. */}
            <div className="fl-sentence" onClick={(ev) => ev.stopPropagation()}>
              {ruleSentence(flow, e, open, p.promptModes, p.commands, boardRepos, p.onSave)}
            </div>
            {settled && (
              <div className="fl-receipt" onClick={(ev) => ev.stopPropagation()}>
                {/* Error wins over a receipt when a hand-edited flow somehow
                    carries both — same tie-break as the inspector's, for the
                    same reason: a failure is the more important claim. */}
                {e.error !== undefined ? (
                  // Same two licences the inspector's `.orch-obs` spends, and the
                  // same exception: red is for a rule that tried and failed, and
                  // the store's migration notice is not one — see
                  // `isMigrationNotice`.
                  <span className={isMigrationNotice(e.error) ? undefined : "err"}>{e.error}</span>
                ) : (
                  <span className="fired">{e.firedNote ?? "fired"}</span>
                )}
                {/* `tabIndex` follows the SAME roving rule the row itself
                    follows (`rowTabIndex`) — without it, this button is a
                    native Tab stop regardless of whether its row is the
                    current one, which is exactly the cost the roving
                    tabindex exists to avoid (see `rowTabIndex`'s own doc
                    comment): a flow with five fired rules would cost five
                    extra Tab presses just to get past the list, one per
                    Reset button, on top of the one stop the list itself is
                    supposed to cost. */}
                <button
                  type="button"
                  className="orch-mini"
                  tabIndex={rowTabIndex(i)}
                  onClick={() => p.onResetEdge(e.id)}
                >
                  Reset
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      {body}
      <NewRuleBar flow={flow} promptModes={p.promptModes} repos={boardRepos} onSave={p.onSave} />
    </>
  );
}
