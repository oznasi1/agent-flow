// The controls for a condition's own parameters — the repo and branch a
// `branch-ci-passed` rule watches, the status a `ticket-status-is` rule waits
// for, the span an idle rule counts. One component, imported by BOTH
// presentations of a flow (the canvas inspector in OrchestratorDrawer.tsx and
// the keyboard rows in flowList.tsx), for exactly the reason orchestratorRule.ts
// gives in its own header: "one model, two presentations" only holds if the
// controls that edit it live in one place both import. A second, faithful copy
// is the drift that ends with one side able to set a branch and the other not.
//
// It renders a FRAGMENT, never a wrapper. The two presentations lay a rule out
// differently on purpose — the inspector stacks `.orch-clause` rows, a flowList
// row is one wrapping `.fl-sentence` — and a container chosen here would be
// right in one and wrong in the other. So this owns the fields; each caller owns
// where they sit.
//
// Nothing here reaches for `flow` or `onSave` directly: every control hands its
// one value to `onEdit`, and the caller spends `withCondParams`. That keeps this
// file free of the model-writing that orchestratorRule.ts owns, the same split
// that file already keeps between its `with*` writers and the JSX that calls
// them.
import * as React from "react";
import { Condition, condIncomplete } from "../engine/orchestrator/model";
import { DEFAULT_IDLE_MINUTES, PRINTED_TEXT_ARIA_LABEL } from "./orchestratorRule";

export interface CondParamsProps {
  /** The condition being edited. A bare kind renders nothing at all. */
  cond: Condition;
  /** Every checkout the board can see — `repoOptions(runs)`. The repo picker's
   * options; empty is an ordinary state (a board with no cards yet), and the
   * field then offers only whatever the flow already names. */
  repos: string[];
  /** Apply one changed parameter. The caller writes it with `withCondParams`,
   * which is what refuses a patch that does not belong to this kind. */
  onEdit: (patch: Partial<Condition>) => void;
  /** Distinguishes this rule's fields from another rule's on the same screen.
   * `defaultValue` inputs below are keyed by it: without that, React reuses the
   * DOM node when the selected rule changes and the previous rule's branch stays
   * on screen under the new rule's condition — an uncontrolled input keeps
   * whatever the user typed and ignores a new `defaultValue`. The inspector and
   * an open list row each pass the edge id. */
  editKey: string;
}

/** The extra `<option>` a repo `<select>` needs when the name it holds is not on
 * the board — a repo whose cards are closed, or a flow written on another
 * machine. Without it a `<select>` whose `value` matches no option shows its
 * FIRST option instead, so a rule watching `payments-api` would silently read as
 * one watching whatever sorts first. The same defect, and the same fix, the
 * command and mode pickers in OrchestratorDrawer.tsx already carry.
 *
 * Exported because the command node's own `cwdRepo` picker needs the identical
 * option and must word it identically — two repo pickers on one surface that
 * disagree about what "not on the board" is called would read as two different
 * conditions. */
export function RepoOptions(p: { value: string; repos: string[] }): JSX.Element {
  return (
    <>
      {p.value !== "" && !p.repos.includes(p.value) && (
        <option value={p.value}>{p.value} (not on the board)</option>
      )}
      {p.repos.map((r) => (
        <option key={r} value={r}>{r}</option>
      ))}
    </>
  );
}

export function CondParams(p: CondParamsProps): JSX.Element | null {
  const { cond, onEdit, editKey } = p;
  /** Why this rule can never fire as written, or nothing. The SAME predicate
   * `armability.ts` reports at arm time — one function, so the field cannot be
   * marked here and the rule pass the warning there, or the reverse. */
  const unset = condIncomplete(cond);
  const mark = unset ? <span className="orch-unset">— {unset}</span> : null;

  switch (cond.kind) {
    case "agent-idle-over": {
      // `?? DEFAULT` rather than the field directly, here and in the two arms
      // below: a flow file is JSON somebody can hand-edit and `store.ts` admits
      // an edge on the strength of its `kind` alone, so a condition can arrive
      // with the parameter `Condition` promises simply missing. An `undefined`
      // reaching `defaultValue` makes React treat the input as CONTROLLED with
      // no value and then warn on the first keystroke; reaching a `<select>`'s
      // `value` it does the same in reverse. See `condIncomplete`'s own `blank`
      // helper (model.ts), which is written for the identical case.
      const minutes = cond.minutes ?? DEFAULT_IDLE_MINUTES;
      return (
        <>
          <input
            className="orch-num"
            type="number"
            min={0}
            aria-label="Idle minutes"
            key={`${editKey}-minutes`}
            defaultValue={minutes}
            // `onBlur`, matching every other free-text field on this surface —
            // a rule is not rewritten on each keystroke. `Number(...)`, then a
            // finite check: an emptied number input reads as `""`, which
            // `Number` turns into 0 — "fires the moment a session goes idle" is
            // a real rule, but it is not what clearing a field means, so a blank
            // keeps the value it had rather than silently becoming zero.
            onBlur={(ev) => {
              const n = Number(ev.currentTarget.value);
              if (ev.currentTarget.value.trim() !== "" && Number.isFinite(n) && n >= 0) onEdit({ minutes: n });
              else ev.currentTarget.value = String(minutes);
            }}
          />
          <span className="orch-plabel">minutes</span>
        </>
      );
    }

    case "ticket-status-is":
      return (
        <>
          <span className="orch-plabel">status</span>
          <input
            className="orch-msg"
            aria-label="Ticket status"
            key={`${editKey}-status`}
            defaultValue={cond.status ?? ""}
            // The connector's own word for the column, matched exactly by
            // `evalCond` (`ticketStatus === cond.status`), so the placeholder
            // shows the SHAPE of the answer rather than proposing one: a
            // suggested "In Review" that this board spells "In review" would be
            // a rule that never fires and looks configured.
            placeholder="the status, exactly as the board spells it"
            onBlur={(ev) => onEdit({ status: ev.currentTarget.value })}
          />
          {mark}
        </>
      );

    case "branch-ci-passed": {
      const repo = cond.repo ?? "";
      return (
        <>
          <span className="orch-plabel">repo</span>
          <select
            className="orch-sel"
            aria-label="Repo"
            value={repo}
            onChange={(ev) => onEdit({ repo: ev.currentTarget.value })}
          >
            {/* A seeded rule can start with no repo at all — the source node had
                none to lend (see `sourceRepoOf`). That is a blank the user has
                to fill, so it says so instead of borrowing the first repo's
                name, which a `<select>` with no matching option would otherwise
                show. */}
            {repo === "" && <option value="">choose a repo…</option>}
            <RepoOptions value={repo} repos={p.repos} />
          </select>
          <span className="orch-plabel">branch</span>
          <input
            className="orch-msg"
            aria-label="Branch"
            key={`${editKey}-branch`}
            defaultValue={cond.branch ?? ""}
            // A branch, not a ref: `branchCi.ts` builds the query from this name
            // directly. No default offered — "main" typed in as a placeholder
            // reads as an answer, and a repo whose trunk is `master` would then
            // wait forever on a branch that does not exist.
            placeholder="the branch to watch"
            onBlur={(ev) => onEdit({ branch: ev.currentTarget.value })}
          />
          {mark}
        </>
      );
    }

    case "command-printed":
      return (
        <>
          <span className="orch-plabel">text</span>
          <input
            className="orch-msg"
            aria-label={PRINTED_TEXT_ARIA_LABEL}
            key={`${editKey}-text`}
            defaultValue={cond.text ?? ""}
            // A substring, matched case-insensitively against everything the
            // command printed (`outputContains`, model.ts) — so the placeholder
            // shows the SHAPE (a word the script emits), not a pattern language
            // this field does not have.
            placeholder="a word the command prints, e.g. DEPLOYED"
            onBlur={(ev) => onEdit({ text: ev.currentTarget.value })}
          />
          {mark}
        </>
      );

    default:
      // Every bare kind. Not a fallthrough this file has to keep up with: a new
      // parameterised kind is caught by `PARAMETERISED_CONDS` in
      // orchestratorRule.ts, which stops compiling until it is named there, and
      // by `withCond`'s own seeding switch beside it.
      return null;
  }
}
