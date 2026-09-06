// What to do about a failed rule, derived from the error's SHAPE.
//
// A failed rule stamps an error on its edge (`FlowEdge.error`) and the drawer
// offers Reset. Honest, but silent about the next step — and passes run
// unattended on a schedule now, so whoever reads the error reads it hours later,
// out of context. Each failure shape the engine produces has exactly one
// sensible next step, and several already say it in prose inside the refusal.
// This module collects them into one table so the drawer and the headless tick
// can show the step beside the error.
//
// Nothing here diagnoses. A row matches a STABLE SUBSTRING of a message the
// engine already writes (case-sensitive, to the source's own spelling) and names
// the step; an error no row recognises gets `undefined`, never a generic filler.
// `test/unit/engine/orchestrator/suggestions.test.ts` reads the source files
// each row names and asserts the literal is still there verbatim, so a reworded
// engine message fails there, loudly, instead of leaving the drawer mute.
//
// Webview-safe: imports nothing but `./model`. Keep it that way — the Deck
// bundle reaches this file (see `test/webview/webviewGraph.test.ts`).
import { ACTION_MISMATCH_PREFIX } from "./model";

/** One failure shape: the substring that identifies it, where the engine writes
 * that substring, and the one next step. Ordered most-specific-first in
 * `SUGGESTION_SHAPES`; the first row whose `match` accepts the error wins. */
export interface SuggestionShape {
  /** Stable, unique id — the test's sample table is keyed on it. */
  id: string;
  /** The exact text every file in `sources` contains. A prefix match is still
   * expressed as a literal so the source-grep test can check it. */
  literal: string;
  /** Repo-relative source files that write this literal into an error. */
  sources: string[];
  /** Whether `error` is this shape. Substring containment unless noted. */
  match: (error: string) => boolean;
  /** One short imperative sentence: the next step. */
  suggest: string;
}

const CWD_HINT = "Set the command step's working directory (the inspector's \"Runs in\" field — cwdRepo in the flow file), then Reset.";
const OFF_BOARD_HINT = "The card left the board — bring it back or rewire the rule; Reset alone fails the same way.";
const WRONG_KIND_HINT = "Re-point the rule at a step of the right kind, or delete it.";
// 120 s, spelt out: `COMMAND_TIMEOUT_MS` lives in `command.ts`, which this
// webview-safe module must not import. The test pins the two figures together.
const TIMEOUT_HINT = "Make the command finish inside 120 s or move the long part out of the rule, then Reset.";

const includes = (literal: string) => (error: string) => error.includes(literal);

/** Every shape, most-specific-first. One row per shape; each row's comment names
 * the source of the message it matches. */
export const SUGGESTION_SHAPES: readonly SuggestionShape[] = [
  // src/engine/orchestrator/launch.ts — git could not make the worktree.
  {
    id: "worktree",
    literal: "Couldn't create a git worktree in",
    sources: ["src/engine/orchestrator/launch.ts"],
    match: includes("Couldn't create a git worktree in"),
    suggest: "Read the Agent Flow Deck output channel for git's reason, free the branch or path it names, then Reset.",
  },
  // src/engine/orchestrator/command.ts — exit 124, the runner's kill code.
  {
    id: "command-killed",
    literal: "the code reported for a command killed after",
    sources: ["src/engine/orchestrator/command.ts"],
    match: includes("the code reported for a command killed after"),
    suggest: TIMEOUT_HINT,
  },
  // src/engine/orchestrator/shellRunner.ts — the runner's own reason on stderr.
  {
    id: "command-timeout",
    literal: "did not finish within",
    sources: ["src/engine/orchestrator/shellRunner.ts"],
    match: includes("did not finish within"),
    suggest: TIMEOUT_HINT,
  },
  // src/deckView.ts / src/headless/pass.ts — the named repo has no checkout here.
  {
    id: "repo-not-checked-out",
    literal: "isn't checked out on this machine",
    sources: ["src/deckView.ts", "src/headless/pass.ts"],
    match: includes("isn't checked out on this machine"),
    suggest: "Check that repo out under the repos root, or point the command at a repo the card has, then Reset.",
  },
  // src/deckView.ts / src/headless/pass.ts — no place upstream of the command.
  {
    id: "no-upstream-place",
    literal: "is a place, so the command at",
    sources: ["src/deckView.ts", "src/headless/pass.ts"],
    match: includes("is a place, so the command at"),
    suggest: CWD_HINT,
  },
  // src/deckView.ts / src/headless/pass.ts — the upstream place's run is gone.
  {
    id: "source-run-off-board",
    literal: "and that run is not on the board",
    sources: ["src/deckView.ts", "src/headless/pass.ts"],
    match: includes("and that run is not on the board"),
    suggest: OFF_BOARD_HINT,
  },
  // src/deckView.ts — a seed whose source run left the board.
  {
    id: "seed-run-off-board",
    literal: "is no longer on the board — not seeding",
    sources: ["src/deckView.ts"],
    match: includes("is no longer on the board — not seeding"),
    suggest: OFF_BOARD_HINT,
  },
  // src/deckView.ts — a seed whose repo the run no longer has.
  {
    id: "seed-repo-gone",
    literal: "'s repos — not seeding it.",
    sources: ["src/deckView.ts"],
    match: includes("'s repos — not seeding it."),
    suggest: "The card no longer has that repo — add it back, or re-point the rule at a place the card has, then Reset.",
  },
  // src/engine/orchestrator/store.ts stamps it, spelt by the prefix constant in
  // model.ts — latched on read when the saved action stopped matching the target.
  {
    id: "action-mismatch",
    literal: ACTION_MISMATCH_PREFIX,
    sources: ["src/engine/orchestrator/model.ts"],
    match: (error) => error.startsWith(ACTION_MISMATCH_PREFIX),
    suggest: "Reset to accept the rule's new meaning, or point it elsewhere if that was not intended.",
  },
  // src/engine/orchestrator/command.ts / src/headless/pass.ts — the denylist.
  {
    id: "never-auto-run",
    literal: "agentFlow.neverAutoRun pattern",
    sources: ["src/engine/orchestrator/command.ts", "src/headless/pass.ts"],
    match: includes("agentFlow.neverAutoRun pattern"),
    suggest: "Edit the command or the agentFlow.neverAutoRun setting — Reset alone refuses again.",
  },
  // src/deckView.ts — the step's prompt mode left agentFlow.promptModes.
  {
    id: "prompt-mode-gone",
    literal: "is no longer configured —",
    sources: ["src/deckView.ts"],
    match: includes("is no longer configured —"),
    suggest: "Pick a configured mode on the step, or restore it in agentFlow.promptModes, then Reset.",
  },
  // src/deckView.ts / src/headless/pass.ts — launch, seed, subflow and run
  // rules each refuse a target of the wrong kind with this phrase.
  {
    id: "wrong-kind-must-point",
    literal: "rule must point at",
    sources: ["src/deckView.ts", "src/headless/pass.ts"],
    match: includes("rule must point at"),
    suggest: WRONG_KIND_HINT,
  },
  // src/engine/orchestrator/runner.ts — a target that derives no action at all.
  {
    id: "wrong-kind-points-at",
    literal: "which is not a place, planned work, a notification, or a command",
    sources: ["src/engine/orchestrator/runner.ts"],
    match: includes("which is not a place, planned work, a notification, or a command"),
    suggest: WRONG_KIND_HINT,
  },
  // src/engine/orchestrator/runner.ts — the act returned no outcome.
  {
    id: "not-performed",
    literal: "was not performed",
    sources: ["src/engine/orchestrator/runner.ts"],
    match: includes("was not performed"),
    suggest: "Check the step the rule points at is still what you meant, then Reset.",
  },
  // src/deckView.ts — the subflow node already has a child.
  {
    id: "subflow-already-started",
    literal: "already started a subflow",
    sources: ["src/deckView.ts"],
    match: includes("already started a subflow"),
    suggest: "Delete or reset the child flow it names, then Reset.",
  },
  // src/deckView.ts — a subflow rule whose source is not a place.
  {
    id: "subflow-source-not-place",
    literal: "a subflow starts from a place",
    sources: ["src/deckView.ts"],
    match: includes("a subflow starts from a place"),
    suggest: "Wire the subflow rule from a place so it has a card to bind to, then Reset.",
  },
  // src/deckView.ts — the template the subflow names is gone.
  {
    id: "template-off-disk",
    literal: "is no longer on disk",
    sources: ["src/deckView.ts"],
    match: includes("is no longer on disk"),
    suggest: "Restore that template or pick another on the subflow step, then Reset.",
  },
  // src/deckView.ts — MAX_SUBFLOW_DEPTH reached.
  {
    id: "subflow-depth",
    literal: "subflows deep — not nesting another",
    sources: ["src/deckView.ts"],
    match: includes("subflows deep — not nesting another"),
    suggest: "Start this workflow from a shallower flow, or remove a level of nesting; Reset alone refuses again.",
  },
  // src/engine/orchestrator/templates.ts — instantiation refusals.
  {
    id: "template-no-planned",
    literal: "has no planned step",
    sources: ["src/engine/orchestrator/templates.ts"],
    match: includes("has no planned step"),
    suggest: "Add a planned step to the template, then attach it again.",
  },
  {
    id: "template-self-subflow",
    literal: "starts itself as a subflow",
    sources: ["src/engine/orchestrator/templates.ts"],
    match: includes("starts itself as a subflow"),
    suggest: "Point the template's subflow step at a different template, then attach it again.",
  },
  {
    id: "template-no-repo",
    literal: "has no repo to launch in, and the template names none",
    sources: ["src/engine/orchestrator/templates.ts"],
    match: includes("has no repo to launch in, and the template names none"),
    suggest: "Give the card a repo, or name one in the template, then attach it again.",
  },
  {
    id: "template-no-prompt-mode",
    literal: "no prompt mode is configured",
    sources: ["src/engine/orchestrator/templates.ts"],
    match: includes("no prompt mode is configured"),
    suggest: "Set agentFlow.promptModes, then attach the workflow again.",
  },
  // src/deckView.ts — routed-gate delivery (`FlowEdge.routed.error`).
  {
    id: "gate-not-wired",
    literal: "is not wired to a place, so there is no pull request to ask on",
    sources: ["src/deckView.ts"],
    match: includes("is not wired to a place, so there is no pull request to ask on"),
    suggest: "Wire the gate downstream of a place, or answer on the step; Reset re-asks and re-posts.",
  },
  {
    id: "gate-run-off-board",
    literal: "is not on the board, so its pull request cannot be found",
    sources: ["src/deckView.ts"],
    match: includes("is not on the board, so its pull request cannot be found"),
    suggest: "Bring the card back to the board, or answer on the step; Reset re-asks and re-posts.",
  },
  {
    id: "gate-repo-not-checkout",
    literal: "is not a checkout of",
    sources: ["src/deckView.ts"],
    match: includes("is not a checkout of"),
    suggest: "Point the place at a repo the card has, or answer on the step; Reset re-asks and re-posts.",
  },
  {
    id: "gate-no-pr",
    literal: "has no pull request yet to ask on",
    sources: ["src/deckView.ts"],
    match: includes("has no pull request yet to ask on"),
    suggest: "Open the pull request first, or answer on the step; Reset re-asks and re-posts.",
  },
  {
    id: "gate-forge-cannot",
    literal: "cannot carry a gate question",
    sources: ["src/deckView.ts"],
    match: includes("cannot carry a gate question"),
    suggest: "Answer on the step — this forge cannot carry the question.",
  },
];

/** The one next step for a failed rule's error, or `undefined` when the message
 * is not a shape this table knows — a forge's own post failure, a command's
 * ordinary non-zero exit, a hand-written error. Never a generic filler. */
export function suggestionFor(error: string | undefined): string | undefined {
  if (error === undefined || error === "") return undefined;
  return SUGGESTION_SHAPES.find((s) => s.match(error))?.suggest;
}
