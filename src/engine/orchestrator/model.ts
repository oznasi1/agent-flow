// The shape of a Deck flow. Types and shape-level helpers only — no evaluation,
// no persistence, no geometry, and deliberately no imports at all, so every other
// module in this directory can depend on it without dragging anything in.

/** What several incoming edges mean at their meeting point. "any" fires on the
 * first one met; "all" waits for every one. It lives on the target node rather
 * than the edge because it is a property of the junction, not of one arrow. A
 * node with fewer than two incoming edges is unaffected by it. */
export type JoinMode = "any" | "all";

/** Where an autonomous launch puts the work. The flow's own vocabulary, not
 * `WorkspaceMode` — that type is only "multiroot" | "per-window" and cannot
 * express the worktree choice a Take offers. Phase 3's runner maps these onto the
 * take path's arguments. */
export type LaunchDest = "worktree" | "new-window" | "current-window";

interface NodeBase {
  id: string;
  x: number;
  y: number;
  join: JoinMode;
}

/** A place on disk that already exists: a run, narrowed to one of its repos. It
 * stores `runKey` and `repo` and never a pid or session id — sessions come and go
 * inside a worktree, and the worktree is what a condition can be about. */
export type PlaceNode = NodeBase & { kind: "place"; runKey: string; repo: string };

/** Work that has not started. It carries its whole launch configuration, because
 * an armed launch cannot stop to ask which repo, which prompt or where it goes. */
export type PlannedNode = NodeBase & {
  kind: "planned";
  ticketKey: string;
  repos: string[];
  mode: string; // a PromptMode id
  dest: LaunchDest;
};

/** A terminal that tells you something. Not a place, so nothing observes it. */
export type NotifyNode = NodeBase & { kind: "notify"; message: string };

/** A command to run when a condition is met: a deploy, a webhook call, a
 * smoke test. Either `commandId` (an entry in `agentFlow.commands`) or `run`
 * (typed into the drawer), never both — `resolveCommand` in command.ts resolves
 * which, and refuses a node carrying neither.
 *
 * A command node is not a place: nothing observes it, and no condition asks
 * what it is "doing". What a LATER rule can ask is whether it succeeded, which
 * is what the `command-succeeded` condition reads off the receipt. */
export type CommandNode = NodeBase & {
  kind: "command";
  commandId?: string;
  run?: string;
  /** Which repo's checkout to run in. Absent means the repo of the place the
   * incoming edge came from — the common case, and the one that needs no
   * configuration. */
  cwdRepo?: string;
};

/** A question the flow stops and asks you. A rule into it poses the question;
 * you answer Approve or Reject on the node; a LATER rule reads that answer as
 * `gate-approved` or `gate-rejected`.
 *
 * The same shape as `NotifyNode` with `question` where `message` is — but not
 * the same thing at all. A notify terminal is not observed by anything; a gate
 * is, which is why it keeps an out port and why the two conditions below read
 * off its incoming edge. It is the only node whose state a PERSON, rather than
 * the world, decides. */
export type GateNode = NodeBase & { kind: "gate"; question: string };

/** A workflow inside a workflow: a node that, when a rule reaches it, STARTS a
 * saved template as a child flow bound to the same card, and that a LATER rule
 * can wait on with `subflow-done`. It is what lets a starter compose into a
 * bigger shape instead of being copied into it.
 *
 * `templateId` is the user's configuration. `childFlowId` is a host stamp: set
 * once the child exists (`bindSubflow`), never carried into a template
 * (`normalizedTemplateFlow` strips it), and — deliberately — NOT cleared by Reset
 * on the rule that started it: the child is a real flow on disk with its own
 * history, and a second start would leave two. Reset the child's own rules, or
 * delete it, to run it again.
 *
 * The child carries `parentFlow`/`parentNode` (see `Flow`) and is excluded from
 * card attachment (`attachedWorkflows`), which is what keeps "one workflow per
 * card" a question about the parent alone. */
export type SubflowNode = NodeBase & { kind: "subflow"; templateId: string; childFlowId?: string };

export type FlowNode = PlaceNode | PlannedNode | NotifyNode | CommandNode | GateNode | SubflowNode;

/** Every condition kind that needs no parameter. */
export type CondKind =
  | "pr-merged"
  | "ci-passed"
  | "ci-failed"
  | "review-approved"
  | "changes-requested"
  | "threads-resolved"
  | "pr-conflicting"
  | "agent-ended-turn"
  | "no-agent-left"
  | "tree-clean"
  | "has-uncommitted"
  | "nothing-to-push"
  | "ticket-done"
  /** Whether the command a LATER rule points past a `CommandNode` actually ran
   * and succeeded — see that node's own doc comment. Bare, like every other
   * entry here, but answered nowhere near them: `evaluate.ts`'s `isMet`
   * intercepts this kind before `conditions.ts`'s `evalCond` ever sees it,
   * because the verdict lives on the command node's INCOMING edge, not on any
   * `RunStatus` `evalCond` could be handed. `conditions.ts` still carries a
   * documented arm for it, so it stays a total function over every kind. */
  | "command-succeeded"
  /** Did you approve — or reject — the gate this rule points back at? Bare, like
   * `command-succeeded` above, and answered in the same unusual place and for the
   * same reason: `evaluate.ts`'s `isMet` intercepts both before `conditions.ts`'s
   * `evalCond` ever sees them, because the verdict lives on the gate node's
   * INCOMING edge (`gateAnswer`, below) rather than on any `RunStatus`.
   *
   * Two kinds rather than one is not symmetry for its own sake. The stamp must
   * distinguish "rejected" from "unanswered" regardless — otherwise the drawer
   * cannot stop asking, and cannot show you what you decided — so the fact is on
   * disk either way. Reading only half of it would leave a rejected gate
   * indistinguishable from an unanswered one to every downstream rule. */
  | "gate-approved"
  | "gate-rejected"
  /** Did ANOTHER rule out of this same source run out of time? Bare, and answered
   * in the same unusual place as the three above — `evaluate.ts`'s `isMet`
   * intercepts it before `conditions.ts` — because the fact lives on a SIBLING
   * edge's `expiredAt`, not on any `RunStatus`. It is what lets a deadline act:
   * the rule carrying `timeoutMinutes` only settles as expired, and a sibling with
   * this condition is what then notifies, re-seeds, or launches the fallback.
   * "If it hasn't merged in an hour, tell me" is two rules out of one place. */
  | "deadline-passed"
  /** Has the child workflow a `subflow` node started FINISHED — every rule in it
   * settled? Bare, and answered in the same unusual place as the four above:
   * `evaluate.ts`'s `isMet` reads the child off `EvalInput.flows`, because the
   * fact lives in another flow's file, not on any `RunStatus`. A child that
   * stopped on a failure is not done — it is stopped — and this stays unmet; a
   * deadline on the rule is how a parent bounds that wait. */
  | "subflow-done";

/** The `kind` strings below are serialized into flow files under
 * ~/.agentflow/flows and shared across windows, so they keep their released
 * spelling — `agent-idle-over`, not `session-idle-over` — while the labels
 * rendered beside them read "session". That mismatch is deliberate: a card is a
 * session in the UI, and renaming a key would break every saved flow.
 *
 * Parameterised where it has to be, a bare kind everywhere else. */
export type Condition =
  | { kind: CondKind }
  | { kind: "agent-idle-over"; minutes: number }
  | { kind: "ticket-status-is"; status: string }
  /** Did CI pass on a NAMED BRANCH of a NAMED REPO — "wait for the build to pass
   * on master, then deploy to staging". Parameterised for a reason no other
   * condition here shares: every one of them asks about the place the rule's
   * source node already is (its PR, its git, its agent), so the repo is implied
   * and the branch is whatever that place has checked out. This one asks about a
   * branch nothing on the board need be sitting on, so both halves have to be
   * said out loud.
   *
   * `repo` is Agent Flow's name for a CHECKOUT (a `run.repos[].name`), not a
   * GitHub `owner/name` — it says which directory the fetch runs in, and gh
   * resolves the repository from that directory's remote. See
   * `branchCi.ts`'s `BRANCH_CI_QUERY` for why that distinction is load-bearing.
   *
   * Verdicts arrive on `CondContext.branchCi`, keyed `repo#branch`, and only an
   * explicit `"passed"` satisfies it: this condition is built to gate a deploy,
   * so an unreadable branch reads as not met (see `conditions.ts`'s arm). */
  | { kind: "branch-ci-passed"; repo: string; branch: string }
  /** Did the command this rule points past PRINT `text` — anywhere in its
   * captured stdout+stderr, case-insensitively (`outputContains`)? The second
   * command-shaped condition beside `command-succeeded`, and the first that
   * reads more than one bit off a command: "deploy printed ROLLBACK, so page me"
   * and "the smoke test printed 0 failures, so promote" are both this.
   *
   * The output itself never crosses into the engine. It lives in the flow's
   * journal (`fired`/`errored` lines carry `output`), which is host-side: the
   * host reads it once per pass, answers this rule (`printedVerdicts`,
   * journal.ts), and hands the verdict in on `EvalInput.printed` keyed by THIS
   * rule's edge id — the same route `branch-ci-passed` takes for its `gh` call,
   * and for the same reason: `conditions.ts` and `evaluate.ts` are bundled into
   * the webview and can reach neither a forge nor a file. Answered only once the
   * command's own rule has performed (see `evaluate.ts`'s `commandPrinted`) —
   * ran and succeeded OR ran and failed, since a failure's output is often
   * exactly the text worth acting on. */
  | { kind: "command-printed"; text: string };

/** Does a command's captured output carry `text`? Case-insensitive substring —
 * not a regex, not a glob. A deploy script's "DEPLOYED" and a human's "deployed"
 * are the same fact, and a `*` in a rule that means "literal asterisk" is a trap
 * `agentFlow.neverAutoRun`'s globbing already sets once in this codebase. Blank
 * text matches nothing: a rule with no text is incomplete (`condIncomplete`),
 * never one that fires on any output at all. The ONE place the match is
 * defined, so the host's verdict and any future reader agree. */
export function outputContains(output: string, text: string): boolean {
  const needle = text.trim().toLowerCase();
  return needle !== "" && output.toLowerCase().includes(needle);
}

/** What a rule does when its condition is met, derived from the node it points
 * at — see `actionFor`. `run` executes a command node's command.
 *
 * Nothing here instructs a RUNNING agent; that remains impossible (see the
 * spec's out-of-scope note on `tell`). */
export type FlowAction = "launch" | "seed" | "notify" | "run" | "ask" | "spawn";

export interface FlowEdge {
  id: string;
  from: string; // node id
  to: string; // node id
  cond: Condition;
  /** Mirrors the action its target implies — see `edgeAction`/`actionFor` — but
   * is NOT simply overwritten with that mirror: `writeFlow` writes `e.action ??
   * derived`, preserving a stored value that disagrees with the target, because
   * that disagreement is exactly what `latchActionMismatches` (`store.ts`) needs
   * to see on the next read to latch the edge instead of silently reinterpreting
   * it. The field also stays on the record for compatibility: an OLDER build's
   * `validEdge` *requires* it and DROPS any edge without it, so a file this
   * build wrote without the field would lose every rule after a downgrade or a
   * rollback — an edge THIS build created has no stored value yet, so it always
   * falls through to the derived one.
   *
   * NOTHING on the host's acting path reads this field for behaviour any more:
   * `evaluate.ts` derives the verb from the target (`costsSlot`/`edgeAction`) and
   * carries it on `FiredEdge.action`, and `deckView.ts`'s spend-slot check, its
   * dispatch, `spendTarget` and `performEdge` all take that carried value as a
   * parameter. Nor does the WEBVIEW: Task 9 finished that half, so
   * `orchestratorRule.ts`'s labels, mode and destination all resolve through
   * `edgeAction` (the TARGET) — see `modeValueOf`'s own comment on what keying off
   * the stored field broke. `store.ts` reads it, but only to compare against the
   * derived value and latch a disagreement, and `promoteToPlace` CLEARS it on every
   * edge into a node it rewrites, because that rewrite is what would otherwise
   * manufacture such a disagreement. Comparison, compatibility and that one clear
   * are the field's whole remaining purpose. */
  action?: FlowAction;
  /** A PromptMode id, for `seed` only. A launch's prompt and destination live on the
   * `planned` node it targets, which carries its whole launch configuration — see
   * `PlannedNode`. Two homes for one fact is deliberate here: a place has no mode
   * field, so a seed's has nowhere else to go. */
  mode?: string;
  /** Set once this edge has fired. Its presence IS the latch: an edge with a
   * `firedAt` is never evaluated again until Reset clears it. */
  firedAt?: number;
  /** The receipt the drawer shows, e.g. "opened bite-me-3a". */
  firedNote?: string;
  /** Set, and only ever set to `true`, on the edge whose action actually ran —
   * as opposed to a per-target-dedupe or "all"-junction SIBLING that
   * `applyFired` (runner.ts) stamps with the identical `firedAt`-set,
   * `error`-absent shape without ever running anything. `firedAt`/`error`
   * alone cannot tell the two apart (a demoted sibling never gets `error`, so
   * it reads exactly like a successful performer); this field is the
   * explicit answer to "was THIS the one that ran", independent of whether it
   * then succeeded or failed.
   *
   * Read by `evaluate.ts`'s `commandSucceeded`, which needs to name the
   * performer among a command node's several incoming edges rather than
   * infer it from the absence of an error anywhere — the inference this
   * field replaces breaks the moment the performer alone is Reset (Reset is
   * per edge): the sibling's bare `firedAt` would otherwise outlive the
   * failure it was standing next to and read back as a success.
   *
   * Optional, absent on every edge from a build before this field existed and
   * on every non-performing edge going forward — both read the same as "not
   * this edge", which is what keeps an old flow file parsing unchanged.
   * Dropped by Reset (`flow:resetEdge`, deckView.ts), which names it in an
   * explicit list of the stamps it deletes. It used to be cleared for free —
   * that handler rebuilt the edge from an allow-list of its non-host fields —
   * but the allow-list also silently dropped `note`, the user's own
   * configuration, so it is a deny-list now: a HOST-OWNED field added here
   * needs a matching edit there, or Reset will leave it behind. */
  performed?: true;
  /** Your answer to the gate this edge points at, stamped on the PERFORMER edge
   * — the one carrying `performed: true` — for the same reason `commandSucceeded`
   * names its performer that way: `firedAt`/`error` alone cannot tell a real
   * performer from an "all"-junction or per-target-dedupe sibling that
   * `applyFired` stamps with an identical shape.
   *
   * It cannot be inferred from `firedAt`. An ask edge fires the moment the
   * question is POSED, which means "asked", never "approved" — the one place a
   * gate differs from the `command-succeeded` shape it otherwise copies.
   *
   * On the EDGE and not on the node, because Reset is per edge: clearing the ask
   * edge clears the answer and the next pass re-poses the question, which is the
   * whole Reset affordance inherited for nothing. `flow:resetEdge` (deckView.ts)
   * names it in the explicit deny-list of stamps it deletes — a host-owned field
   * added here needs a matching edit there or Reset leaves it behind.
   *
   * Optional, and absent on every flow written before this build: absent means
   * "not answered", which is what keeps an old file reading unchanged. */
  gateAnswer?: "approved" | "rejected";
  /** Extra, once-off text for the agent this rule starts — appended to the prompt
   * mode's template, or substituted at `{note}` if the template has one. For
   * `launch` and `seed` only; a `notify` rule's words live on its notify node.
   * Reusable instructions belong in `agentFlow.promptModes`, which the rule
   * already picks from — this is for what is specific to THIS transition. */
  note?: string;
  /** The action threw. Never retried until Reset — retrying a launch that failed
   * every poll is how you end up with twenty windows. */
  error?: string;
  /** How long this rule may WAIT once its clock is running before it settles as
   * expired — the user's own configuration, kept by Reset and by `toTemplate`
   * exactly like `note`. Absent (or anything but a positive finite number — a
   * flow file is hand-editable, see `hasDeadline`) means the rule waits forever,
   * which is what every rule did before this field existed and what keeps an old
   * file reading unchanged.
   *
   * A deadline does not make the rule fire. It settles it with `expiredAt`, and
   * a SIBLING out of the same source with the `deadline-passed` condition is what
   * acts on that — see `CondKind`. */
  timeoutMinutes?: number;
  /** When this rule's clock started: the first pass that found it live — its
   * source a place on the board, a command that has performed, or a gate that
   * has been asked (see `evaluateDeadlines` in evaluate.ts) — while it carried a
   * deadline. Stamped only for a rule WITH `timeoutMinutes`, so a flow that never
   * opted in is never written for this. Host-owned: cleared by Reset
   * (`stripHostStamps`), and cleared on every pending rule when the flow is
   * re-armed, so a paused flow's clocks start over rather than expiring the
   * instant it wakes. */
  liveSince?: number;
  /** The THIRD terminal stamp, beside `firedAt` and `error`: the deadline passed
   * and the condition had not arrived. Distinct from both on purpose — an expired
   * rule ran nothing (so it is not a `firedAt`, and `commandSucceeded` must never
   * read it as a performer) and nothing broke (so it is not an `error`, and the
   * drawer must not show it in red). `isSettled` counts it, so it is never
   * evaluated again until Reset. */
  expiredAt?: number;
  /** OPT-IN retry for a rule that spends. Absent — the default, and every flow on
   * disk — means what it always meant: a failure is a full stop until Reset.
   * With it, a failed `launch`, `seed` or `run` is tried again up to `max` more
   * times, each after `backoffMs`, and only THEN latched. The user's own
   * configuration, kept by Reset and `toTemplate` like `note`.
   *
   * Split by whether the action is safe to repeat, which is the whole care this
   * feature needs: a launch that failed because a worktree could not be created
   * is safe to retry; a deploy that half-ran is not. So a `run` rule's retry is
   * honoured only alongside `retryOk` — the same posture the consent gates take
   * toward shell. See `retryPolicy`, the one reader. */
  retry?: { max: number; backoffMs: number };
  /** The explicit tick that this `run` rule's command is safe to execute twice.
   * Only ever `true`, only read for `run`, and required for `retry` to mean
   * anything on one — a retry policy on a command without it is inert. */
  retryOk?: true;
  /** Host stamp: how many times this rule's action has FAILED so far. Kept when
   * it finally succeeds (the receipt says "after 2 retries") and when it gives
   * up. Cleared by Reset. */
  attempts?: number;
  /** Host stamp: the earliest moment the next attempt may run. Its PRESENCE is
   * what makes an errored rule "pending retry" rather than settled — see
   * `isSettled` and `retryPending` — and `evaluate.ts` reads it as "not yet"
   * until the clock passes it. Absent on a terminal failure. Cleared by Reset,
   * and by the attempt that succeeds. */
  retryAt?: number;
}

export interface Flow {
  id: string;
  name: string;
  armed: boolean;
  createdAt: number;
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** When the user approved this flow's first launch. A flow asks once, naming
   * what it is about to open, then runs unattended — the same reasoning as the
   * resume gate: a mis-wired flow should cost one prompt, not a string of paid
   * sessions. Absent means it has never launched anything. */
  launchConfirmedAt?: number;
  /** When the user approved this flow's first COMMAND. A second gate, deliberately
   * separate from `launchConfirmedAt`, because the two consents are not the same
   * one: approving a launch approves opening an agent session, and the modal that
   * asked closed with "It will keep launching on its own from now on", which
   * discloses nothing about executing shell. Every flow confirmed by an existing
   * user before commands shipped carries `launchConfirmedAt` and nothing else — one
   * shared gate would let all of those run their first `deploy.sh` with no ask at
   * all, on a machine whose owner approved a Claude Code window.
   *
   * Optional, and absent on every flow written before this build, which is what
   * makes an old file read unchanged: absent means "has never run a command", so
   * the first one asks. Nothing migrates it — a migration that copied
   * `launchConfirmedAt` into it would be inventing the consent this field exists to
   * require. */
  commandConfirmedAt?: number;
  /** The template this workflow was instantiated from, when it was.
   *
   * Deliberately STORED rather than derived, unlike attachment (which is derived
   * from the graph on purpose — see attach.ts): a workflow's origin leaves no
   * trace in its own nodes and edges, so there is nothing to derive it from. The
   * Templates tab reads it to answer "is this template in use, or did I abandon
   * it?", and matching on name plus rule count instead would break the moment
   * anyone renamed a template.
   *
   * Optional, and absent on every flow written before this field existed — which
   * reads the same as "not from a template", the honest answer for a
   * hand-drawn one. */
  fromTemplate?: string;
  /** Per-command approvals, keyed by the RESOLVED command text — the same string
   * `spendTarget` shows in the modal and `neverAutoRun` matches against — read
   * only under `agentFlow.commandConsent: "command"` (see consent.ts). Each
   * record says when the text was approved and, when the approval was for a
   * number of runs, how many are left; absent `remaining` means "always for this
   * command". `commandConfirmedAt` beside it is untouched and still governs the
   * default `"flow"` mode, so flipping the setting back restores exactly the
   * behaviour every existing workflow has. Never carried into a template
   * (`normalizedTemplateFlow` builds from scratch). */
  /** How much this flow may spend over its whole life — sessions opened plus
   * commands run — before it disarms itself. The count it is measured against is
   * DERIVED from the flow's journal (`spendTally`, journal.ts), never stored here:
   * every fired spend is already a journal line, so a stored counter would be a
   * second copy of a fact that could drift from the first, and would need a
   * migration for every flow already on disk. The journal is lifetime — Reset
   * clears a rule's receipt but not its line — which is exactly what makes this
   * a ceiling rather than a per-cycle budget.
   *
   * A pass whose spends would take the total PAST the ceiling performs none of
   * them and disarms the flow, saying so (`advanceUnderLock`, deckView.ts). The
   * per-pass cap (`MAX_LAUNCHES_PER_PASS`) bounds one pass; this bounds all of
   * them, which matters most for a template instantiated many times over.
   *
   * Optional, and absent on every flow written before this field existed, which
   * reads as "no ceiling" — what every flow had. Anything but a positive finite
   * number reads the same way (`hasCeiling`). */
  spendCeiling?: number;

  commandConsents?: Record<string, CommandConsent>;
  /** Set on a flow a `subflow` node started: the flow and node it was started
   * from. Absent on every hand-drawn or attached flow. What it changes: the
   * child is never offered as a card's workflow (`attachedWorkflows`), so the
   * card keeps showing the parent; the child is still a real flow in the
   * Workflows list, armable, resettable and deletable on its own. */
  parentFlow?: string;
  parentNode?: string;
  /** A random UUID minted for THIS workflow the first time anything wants to
   * report on it, and the only workflow identifier telemetry ever sends
   * (`flow_uid`).
   *
   * It exists because `Flow.id` cannot be sent and never will be: `newFlowId`
   * mints it from a clock plus a short salt, so it is neither random nor ours —
   * not even fingerprinted, since a hash of a low-entropy, time-ordered value is
   * reversible by anyone who can guess the minute. This field is the opposite by
   * construction: `randomUUID()`, derived from nothing about the user, the
   * machine or the workflow, and meaningful only as "these events are the same
   * workflow".
   *
   * Stored HERE, in the flows file, rather than in `globalState`, because the
   * flows file is the one store all three readers share: both Deck windows and
   * `dist/tick.js`, which has no editor state to read. A funnel that lost its
   * thread the moment a workflow ran overnight under cron would answer none of
   * the questions this field exists for.
   *
   * Optional, and absent on every flow written before it existed — which is why
   * `analyticsIdFor` mints lazily rather than a migration writing one into every
   * file on disk. NEVER carried into a template or a duplicate: a template
   * attached to twenty cards is twenty workflows, and twenty workflows sharing
   * one id would collapse exactly the funnel this is for (see
   * `normalizedTemplateFlow` in templates.ts and the `duplicate_template`
   * gesture). */
  analyticsId?: string;
}

/** What a workflow is BUILT from, counted for telemetry: how many of its rules
 * carry each of the features 0.68.0 added, and how many of its nodes are
 * subflows.
 *
 * Counts only, and that is the whole point — a deadline's minutes are a
 * duration and safe, but an output condition's needle, a subflow's template id
 * and a command's text are user-authored strings that must never leave the
 * machine. Answering "is this feature used at all?" needs a number, not a value.
 *
 * `withRetry` asks `retryPolicy`, not `e.retry`, so a retry that could never be
 * taken — on an action that does not spend, or a `run` missing its explicit
 * `retryOk` tick — is not counted as adoption. A user who typed a RETRY into a
 * notify rule has not adopted retries; they have configured something inert, and
 * reporting it as uptake would be a lie the feature's own reader does not tell. */
export interface AnalyticsShape {
  withDeadline: number;
  withRetry: number;
  withOutputCondition: number;
  subflowNodes: number;
}

/** The id to report this flow under, or `""` for a flow that has never been
 * written by this build.
 *
 * Empty rather than a freshly minted value, deliberately: a mint here would hand
 * back a different id every time it was asked, which is worse than no id at all
 * — every event would look like its own workflow. `writeFlow` is the one place
 * that mints, because minting means persisting.
 *
 * Lives here beside the field rather than in `store.ts` because it reads a Flow
 * and touches no IO — and because a caller should not have to reach through the
 * persistence module to ask a question about an object it already holds. */
export function analyticsIdOf(flow: Flow | undefined): string {
  return typeof flow?.analyticsId === "string" ? flow.analyticsId : "";
}

export function analyticsShape(flow: Flow): AnalyticsShape {
  return {
    withDeadline: flow.edges.filter(hasDeadline).length,
    withRetry: flow.edges.filter((e) => retryPolicy(e, edgeAction(flow, e)) !== undefined).length,
    withOutputCondition: flow.edges.filter((e) => e.cond?.kind === "command-printed").length,
    subflowNodes: flow.nodes.filter((n) => n.kind === "subflow").length,
  };
}

/** One per-command approval — see `Flow.commandConsents`. */
export interface CommandConsent {
  at: number;
  /** Runs still covered. Absent: every run of this text, from now on. `0` reads
   * as spent, and the next such command asks again. */
  remaining?: number;
}

/** What a flow has spent so far, counted off its journal's `fired` lines: a
 * `launch` or a `seed` opened a session, a `run` executed a command. Defined here
 * rather than in journal.ts because the webview shows it (`deck:flows` carries
 * one per flow) and journal.ts imports `path`, which no browser bundle can take. */
export interface SpendTally {
  sessions: number;
  commands: number;
}

export function spendTotal(t: SpendTally): number {
  return t.sessions + t.commands;
}

/** Does this flow have a ceiling it can hit? A positive finite number and nothing
 * else — same tolerance `hasDeadline`-style readers extend to a hand-edited file:
 * `"spendCeiling": "10"` or `0` reaches here, and neither is a ceiling. */
export function hasCeiling(f: Flow): boolean {
  return typeof f.spendCeiling === "number" && Number.isFinite(f.spendCeiling) && f.spendCeiling > 0;
}

/** Would performing `wanted` more spends take this flow past its ceiling?
 * Reaching the ceiling exactly is allowed — a ceiling of 10 means ten — and a flow
 * with no ceiling is never over it. Asked of the WHOLE pass's spends rather than
 * one at a time, so a pass either performs everything it decided or nothing: a
 * half-performed pass would leave a junction's siblings stamped around a
 * performer that never ran. */
export function overCeiling(f: Flow, tally: SpendTally, wanted: number): boolean {
  return hasCeiling(f) && spendTotal(tally) + wanted > f.spendCeiling!;
}

export function emptyFlow(id: string, name: string, nowMs: number): Flow {
  return { id, name, armed: false, createdAt: nowMs, nodes: [], edges: [] };
}

/** Does this edge carry a terminal stamp? A shape-level fact about the record —
 * `firedAt` says it ran, `error` says it tried and failed — and either one is
 * terminal until Reset clears it.
 *
 * It lives here, not in `evaluate.ts`, because two modules answer this question
 * and they must not drift: `evaluate.ts` skips a settled edge, and
 * `armability.ts` must not report one as "waiting on a toggle" when the real
 * reason it will never fire is that it already errored. That drift was a real
 * defect — `armability.ts` used to check only `firedAt`. */
export function isSettled(e: FlowEdge): boolean {
  // An error with a `retryAt` is a failure that will be tried again — still in
  // play, not terminal. Every reader of "settled" (the evaluator's skip, the
  // junction's arithmetic, armability, the stepper's done count) gets that
  // answer from here alone.
  return e.firedAt !== undefined || e.expiredAt !== undefined || (e.error !== undefined && e.retryAt === undefined);
}

/** Has this rule failed and is it waiting to try again? The one shape that is
 * errored yet not settled. */
export function retryPending(e: FlowEdge): boolean {
  return e.error !== undefined && e.retryAt !== undefined;
}

/** The retry this rule may take for `action`, or `undefined` when it must not.
 * Three refusals, all deliberate: no policy or a malformed one (a flow file is
 * hand-editable — `max` must be a positive integer and `backoffMs` a non-negative
 * finite number); an action that does not spend (a notify or an ask cannot fail
 * in a way a retry would help, and `applyFired` never asks); and a `run` without
 * the explicit `retryOk` tick — re-executing shell that half-ran is the failure
 * mode this whole feature is careful about, so it takes a second, separate yes. */
export function retryPolicy(e: FlowEdge, action: FlowAction | undefined): { max: number; backoffMs: number } | undefined {
  const r = e.retry;
  if (!r || typeof r !== "object") return undefined;
  if (!Number.isInteger(r.max) || r.max <= 0) return undefined;
  if (typeof r.backoffMs !== "number" || !Number.isFinite(r.backoffMs) || r.backoffMs < 0) return undefined;
  if (!isSpendAction(action)) return undefined;
  if (action === "run" && e.retryOk !== true) return undefined;
  return { max: r.max, backoffMs: r.backoffMs };
}

/** Does this rule carry a deadline it can run out of? A positive, finite minute
 * count and nothing else: a flow file is JSON somebody can hand-edit, and
 * `store.ts`'s `validEdge` admits an edge on the strength of its `cond` alone, so
 * `"timeoutMinutes": "10"` or `0` can reach every reader. Zero and below read as
 * "no deadline" rather than "expires at once" — a rule that expires the instant
 * it goes live is not something anyone means by a deadline. */
export function hasDeadline(e: FlowEdge): boolean {
  return typeof e.timeoutMinutes === "number" && Number.isFinite(e.timeoutMinutes) && e.timeoutMinutes > 0;
}

/** The moment this rule's clock runs out, or `undefined` while it has no deadline
 * or the clock has not started. One arithmetic, shared by the engine's expiry
 * check, the dry run's "expires in…" and the card's stepper, so no two of them
 * can disagree about when. */
export function deadlineAt(e: FlowEdge): number | undefined {
  if (!hasDeadline(e) || typeof e.liveSince !== "number") return undefined;
  return e.liveSince + e.timeoutMinutes! * 60_000;
}

/** Every field the HOST stamps onto an edge as it acts, removed — so the edge is
 * back to what the user configured. Two callers: `flow:resetEdge` (deckView.ts),
 * putting one rule back in play, and `toTemplate` (templates.ts), saving a shape
 * that must carry no history.
 *
 * Deliberately a DENY-list. It used to be an allow-list that rebuilt the edge
 * from its known non-host fields, and that allow-list silently dropped `note` —
 * the user's own words — every time anyone pressed Reset. A new host-owned field
 * on `FlowEdge` is therefore forgotten in exactly one place, here, rather than in
 * whichever of two call sites nobody remembered.
 *
 * `mode`, `note` and `timeoutMinutes` survive on purpose: they are the user's
 * configuration, not a mirror of anything the host decided, and a seed's mode has
 * nowhere else to live. */
export function stripHostStamps(e: FlowEdge): FlowEdge {
  const kept: FlowEdge = { ...e };
  delete kept.firedAt;
  delete kept.firedNote;
  delete kept.performed;
  delete kept.error;
  delete kept.action;
  delete kept.gateAnswer;
  delete kept.liveSince;
  delete kept.expiredAt;
  delete kept.attempts;
  delete kept.retryAt;
  return kept;
}

/** Does this action spend money — open a window, start a paid session? The ONE
 * place that answers this, because it used to be answered three different ways
 * that had to be kept in sync by hand: `evaluate.ts`'s launch cap, the
 * once-per-target dedupe and the dispatch check in `deckView.ts`'s
 * `advanceUnderLock`, and (indirectly) whether `spendTarget()` resolves to
 * something. A fourth action added here without updating every call site by
 * hand would otherwise be silently treated as free by whichever site got
 * missed. `notify` and `ask` are the only non-spending actions today, but this
 * is written as an allowlist, not a `!== "notify"` negation, so a NEW action
 * defaults to "does not spend" until someone deliberately adds it here. `run`
 * was added deliberately: it executes a shell command on the user's machine,
 * unattended, which is exactly the kind of consequence the once-per-flow
 * consent gate exists to catch before the first one fires — an action that
 * reads as "free" here skips that gate entirely. `ask` earns its place in the
 * exclusion the same way `notify` does: it opens no window and starts nothing
 * paid, it only poses a question, so it must stay off the consent gate and out
 * of the once-per-pass launch cap the way `notify` already is.
 *
 * Takes `FlowAction | undefined` — `FlowEdge.action` is optional now (see its
 * own doc comment) — and answers `false` for `undefined`: an edge with no
 * derivable action cannot spend anything, the same as an edge with a known
 * non-spending one. Accepting the optional type here, rather than making
 * every caller check `e.action !== undefined` first, is what keeps this the
 * ONE place the question is answered.
 *
 * A type PREDICATE rather than a bare boolean, so the guard that decides whether
 * to spend also narrows the verb for the code that then spends it:
 * `deckView.ts`'s dispatch hands `performEdge` an action this has already
 * admitted, and `performEdge` therefore has no `undefined` case to write a
 * refusal for that nothing could reach (it had one, and it was dead). The
 * excluded set in the return type has to name `ask` alongside `notify`
 * explicitly for that same reason: leaving it as `Exclude<FlowAction,
 * "notify">` would let the type system believe an edge past this guard could
 * still be `ask`, which is exactly the false belief `deckView.ts`'s dispatch
 * would otherwise be handed. */
export function isSpendAction(action: FlowAction | undefined): action is Exclude<FlowAction, "notify" | "ask" | "spawn"> {
  return action === "launch" || action === "seed" || action === "run";
}

/** Does the HOST have to do something for this verb — as opposed to a verb whose
 * whole action is the stamp (`notify` is a toast off the receipt, `ask` is the
 * question the stamp poses)? Every spending verb, plus `spawn`: starting a child
 * flow writes a file but spends nothing itself — the child spends under its own
 * consent — so it must be dispatched and must report an outcome (`applyFired`
 * demands one) without being capped or consent-gated as a spend. The one place
 * this second allowlist lives, for the reason `isSpendAction` gives about its. */
export function isPerformedAction(action: FlowAction | undefined): action is Exclude<FlowAction, "notify" | "ask"> {
  return isSpendAction(action) || action === "spawn";
}

export function isSubflow(n: FlowNode): n is SubflowNode {
  return n.kind === "subflow";
}

/** Has the child a `subflow` node started finished? Every rule settled, and at
 * least one rule — an empty child has nothing to finish. `flows` is every flow
 * the caller has (the child is another file); a missing child, or a node that
 * has not started one yet, is simply not done. */
export function subflowDone(flow: Flow, nodeId: string, flows: readonly Flow[]): boolean {
  const node = findNode(flow, nodeId);
  if (!node || node.kind !== "subflow" || node.childFlowId === undefined) return false;
  const child = flows.find((f) => f.id === node.childFlowId);
  return child !== undefined && child.edges.length > 0 && child.edges.every(isSettled);
}

/** Record which child a `subflow` node started. A node rewrite, like
 * `promoteToPlace`: the fact is about the node, and a later rule reads it there. */
export function bindSubflow(flow: Flow, nodeId: string, childFlowId: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((n) => (n.id === nodeId && n.kind === "subflow" ? { ...n, childFlowId } : n)),
  };
}

/** How many ancestors a flow has — 0 for a top-level flow. Bounded by
 * `MAX_SUBFLOW_DEPTH` at spawn time: a template that starts a template that
 * starts a template is a fork bomb six seconds at a time, and the guard has to
 * live where the chain grows. Stops at a cycle or a missing parent rather than
 * looping. */
export function subflowDepth(flow: Flow, flows: readonly Flow[]): number {
  const seen = new Set<string>([flow.id]);
  let depth = 0;
  let cur: Flow | undefined = flow;
  while (cur?.parentFlow !== undefined) {
    const parent = flows.find((f) => f.id === cur!.parentFlow);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth++;
    cur = parent;
  }
  return depth;
}

/** Nesting a subflow inside a subflow inside a subflow is as deep as this goes. */
export const MAX_SUBFLOW_DEPTH = 3;

export function isPlace(n: FlowNode): n is PlaceNode {
  return n.kind === "place";
}

export function isPlanned(n: FlowNode): n is PlannedNode {
  return n.kind === "planned";
}

export function isNotify(n: FlowNode): n is NotifyNode {
  return n.kind === "notify";
}

export function isCommand(n: FlowNode): n is CommandNode {
  return n.kind === "command";
}

export function isGate(n: FlowNode): n is GateNode {
  return n.kind === "gate";
}

export function findNode(flow: Flow, id: string): FlowNode | undefined {
  return flow.nodes.find((n) => n.id === id);
}

/** Every edge pointing at `nodeId`, in flow order. Flow order is what makes a
 * join deterministic: an "all" junction performs the action of its first incoming
 * edge, and "first" has to mean something stable. */
export function incomingEdges(flow: Flow, nodeId: string): FlowEdge[] {
  return flow.edges.filter((e) => e.to === nodeId);
}

/** The edge that ASKED a gate's question, or `undefined` while it is unasked.
 *
 * The single definition of "which edge posed this question", and the answer to a
 * trap that shipped a silent no-op: a gate has edges on both sides, and only the
 * INCOMING one is the performer. `evaluate.ts` posts `awaiting-answer` against an
 * outgoing edge's `from`, so a "waiting on you" step carries the edge pointing
 * AWAY from the gate — while the answer is stamped on, and read back from, the
 * edge that asked. A surface that answers the edge it was handed writes to an
 * edge nothing reads, and `flow:answerGate` refuses it (`performed !== true`),
 * so the click does nothing at all. That is what the Deck card's own Approve did
 * until this function replaced its third hand-rolled copy of the predicate.
 *
 * Found by `performed`, never by `firedAt` alone: an errored sibling has a
 * `firedAt` and no receipt, and stopping at it would read the answer off an edge
 * that never asked anything (the same reasoning `gateAnswer` carries below).
 *
 * Pure and dependency-free like the rest of this module, so the webview surfaces
 * can share it with the engine rather than each re-deriving it. */
export function gateAskEdge(flow: Flow, gateNodeId: string): FlowEdge | undefined {
  if (findNode(flow, gateNodeId)?.kind !== "gate") return undefined;
  return incomingEdges(flow, gateNodeId).find((e) => e.performed === true && e.firedAt !== undefined);
}

/** The action a node kind implies. This is the single source of truth for "what
 * does this rule do", replacing the copy that used to live on the edge — the
 * drawer already refused every pairing except these, which is the tell that the
 * edge's copy was always redundant.
 *
 * Takes a `string`, not `FlowNode["kind"]`: `store.ts`'s `validNode` admits an
 * unknown kind on purpose so a flow written by a newer build still renders, and
 * such a node must derive NO action rather than fall through to a wrong one. */
export function actionFor(kind: string): FlowAction | undefined {
  switch (kind) {
    case "planned": return "launch";
    case "place": return "seed";
    case "notify": return "notify";
    case "command": return "run";
    case "gate": return "ask";
    case "subflow": return "spawn";
    default: return undefined;
  }
}

/** The action this edge performs: the one its TARGET implies. `undefined` when
 * the target is missing or of a kind this build does not know. */
export function edgeAction(flow: Flow, e: FlowEdge): FlowAction | undefined {
  return actionFor(findNode(flow, e.to)?.kind ?? "");
}

/** The opening words of the error stamped on an edge whose stored action
 * disagrees with its target. Exported so the migration, the drawer's copy, and
 * the tests all name it once. */
export const ACTION_MISMATCH_PREFIX = "This rule's action no longer matches where it points";

/** Why this condition can never be met as written, or `undefined` when it is
 * complete. A parameterised condition with a blank parameter is not merely
 * unconfigured — it is a rule the engine will evaluate forever and never
 * satisfy: `evalCond` compares `ticketStatus === ""` and looks up
 * `branchCi["#"]`, neither of which any board can produce.
 *
 * It lives HERE rather than beside the pickers in `orchestratorRule.ts` because
 * two very different callers must agree about it and neither can import the
 * other: the webview's inspector, which marks the field so the blank is visible
 * while it is being made, and `armability.ts`, which is what makes arming SAY so
 * rather than leaving the user waiting on a rule that cannot fire. That is the
 * same drift argument `isSettled` above is written for.
 *
 * `agent-idle-over` is deliberately absent: `withCond` seeds it with a real
 * minute count and the picker's own control cannot produce a blank one, so it
 * has no incomplete shape to report. A hand-edited flow naming `minutes: 0`
 * is not incomplete either — it means "fires as soon as the session is idle",
 * which is a rule that works.
 *
 * The returned string is the REASON, phrased to sit inside both callers'
 * sentences ("branch CI passed… — no branch set" and "1 rule has no branch
 * set"), so neither has to invent wording the other might contradict. */
export function condIncomplete(cond: Condition): string | undefined {
  switch (cond.kind) {
    case "ticket-status-is":
      return blank(cond.status) ? "no status set" : undefined;
    case "branch-ci-passed":
      if (blank(cond.repo)) return "no repo set";
      return blank(cond.branch) ? "no branch set" : undefined;
    case "command-printed":
      // `outputContains` matches nothing for blank text, so this is a rule the
      // engine would evaluate forever and never satisfy — the same shape as a
      // blank status, and reported the same way.
      return blank(cond.text) ? "no text set" : undefined;
    default:
      return undefined;
  }
}

/** Is this parameter missing? A `typeof` check and not just `=== ""`, because
 * the value can be genuinely ABSENT despite what `Condition` claims: a flow file
 * is JSON somebody can hand-edit, and `store.ts`'s `validEdge` admits an edge on
 * the strength of its `kind` without reading the parameters beside it — so
 * `{"kind":"ticket-status-is"}` reaches this function with no `status` at all.
 * A bare `.trim()` on that throws, and it throws inside `unfirableRules`, which
 * is called while ARMING: one hand-edited rule would take the whole arm down
 * rather than being reported as the one rule that cannot fire. Absent and blank
 * mean the same thing here anyway — nothing to match against. */
function blank(v: unknown): boolean {
  return typeof v !== "string" || v.trim() === "";
}

/** The next unused `${prefix}N` id, scanning past whatever is already taken
 * rather than trusting the live count. A count alone drifts the moment
 * anything is deleted: three edges minus the middle one is a list of length
 * two, so `length + 1` mints the id the untouched third edge already has.
 * One minting strategy for both node and edge ids — see `nextNodeId` and
 * `nextEdgeId` below — shared by both presentations so a node or edge minted
 * from the canvas and one minted from the list can never collide. */
function nextId(prefix: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** An id unique within this flow. Node ids are local to a flow.
 *
 * Lives here rather than in `orchestratorRule.ts` because `templates.ts` mints
 * ids too, and an engine leaf must not import from `src/webview/` — the webview
 * bundles for a browser target and the dependency only runs the other way. */
export function nextNodeId(flow: Flow): string {
  return nextId("n", new Set(flow.nodes.map((x) => x.id)));
}

/** An id unique within this flow. Edge ids are local to a flow, and must stay
 * unique even after a delete: `deleteEdge`, `setCond` and the inspector's own
 * `flow.edges.find` all key off this id, so two edges sharing one silently
 * merge into whichever the code touches first. */
export function nextEdgeId(flow: Flow): string {
  return nextId("e", new Set(flow.edges.map((x) => x.id)));
}
