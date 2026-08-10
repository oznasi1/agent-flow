// One condition, one place, one answer. Every predicate here is a pure function of
// a single `RunStatus` — the snapshot `buildRunStatus` already builds for the board
// — so the whole vocabulary is table-testable and adds no I/O of its own. Adding a
// condition that needs a new fact means teaching the Deck to observe it first.
//
// Imports come from `../activity`, never `../status`: OrchestratorDrawer.tsx pulls
// `describeCond` in, the webview bundles for a browser target, and esbuild resolves
// statically — one hop into `status.ts` puts `child_process`, `fs`, `path` and `os`
// in the Deck's bundle graph and the build stops resolving. `../activity` is a leaf
// that imports types only. test/webview/webviewGraph.test.ts pins this.
import { AgentActivity, PrFacts, RepoGit, RunStatus } from "../../types";
import { mostActive, UNKNOWN_ACTIVITY } from "../activity";
import { BranchCiStatus, branchCiKey } from "./branchCi";
import { Condition } from "./model";

export interface CondContext {
  status: RunStatus;
  /** The node's repo. A place node always resolves to exactly one, so no
   * condition is ever ambiguous about which repo's git or PR it means. */
  repo: string;
  nowMs: number;
  /** Branch-CI verdicts this pass fetched, keyed `repo#branch` by `branchCiKey` —
   * both halves, so a flow waiting on `main` and a flow waiting on `release` in the
   * same repo can never read each other's answer.
   *
   * The only fact in this context that does NOT come out of `status`, because it is
   * the only one that is not about this place: `branch-ci-passed` names a branch
   * nothing on the board need have checked out (see its own doc comment in
   * `model.ts`). It arrives already fetched — `deckView.ts` makes the `gh` call,
   * once per distinct key per poll, and hands the map to `evaluateFlow` — because
   * this module is bundled into the webview and cannot spawn anything (see the
   * header comment above).
   *
   * Optional, and an absent map or an absent key is NOT green: see the arm in
   * `evalCond`. */
  branchCi?: Record<string, BranchCiStatus>;
}

/** This place's verdict for a named repo and branch. `"unknown"` for an absent map
 * and for an absent key alike — a fact nobody fetched and a fact nobody could read
 * are the same amount of evidence. */
function branchCi(c: CondContext, repo: string, branch: string): BranchCiStatus {
  return c.branchCi?.[branchCiKey(repo, branch)] ?? "unknown";
}

function facts(c: CondContext): PrFacts | null {
  return c.status.prs[c.repo]?.facts ?? null;
}

function git(c: CondContext): RepoGit | undefined {
  return c.status.repos.find((r) => r.name === c.repo);
}

/** The sessions running in this node's place. `repo` is absent on a local card's
 * agents, which have exactly one repo to belong to — so absent matches. */
function agentsHere(c: CondContext) {
  return c.status.agents.filter((a) => a.repo === undefined || a.repo === c.repo);
}

/** Live state of this place, not of the whole run: a two-worktree run can have one
 * agent working and one waiting on you, and a rule about one must not read the
 * other. Falls back to the run-level aggregate only when the run has a single
 * repo — where that aggregate genuinely IS this place's state, because there is
 * nowhere else for it to have come from. A run with more than one repo and
 * nothing attached here reads as unknown instead: `status.agent` is `mostActive`
 * over every repo in the run (`buildRunStatus`), so borrowing it would let a
 * live agent in an unrelated repo answer for a place that has none.
 *
 * Exported so `evaluate.ts`'s agent-state-unknown guard reads exactly this, not
 * the unfiltered run aggregate. */
export function placeActivity(c: CondContext): AgentActivity {
  const here = agentsHere(c);
  if (here.length > 0) return mostActive(here.map((a) => a.activity));
  return c.status.run.repos.length <= 1 ? c.status.agent : UNKNOWN_ACTIVITY;
}

export function evalCond(cond: Condition, c: CondContext): boolean {
  switch (cond.kind) {
    case "pr-merged":
      return facts(c)?.state === "MERGED";
    case "ci-passed": {
      const f = facts(c);
      // `passing > 0` matters: a PR whose checks have not reported yet has nothing
      // failing and nothing pending, and "no checks at all" is not "CI passed".
      return !!f && f.ci.failing.length === 0 && f.ci.pending === 0 && f.ci.passing > 0;
    }
    case "ci-failed": {
      const f = facts(c);
      // Advisory failures are excluded: every required check passed and something
      // optional did not, which does not block a merge and must not launch a fix.
      return !!f && f.ci.failing.length > 0 && !f.ciAdvisory;
    }
    case "review-approved":
      return facts(c)?.review === "approved";
    case "changes-requested":
      return facts(c)?.review === "changes_requested";
    case "threads-resolved":
      // Strictly zero. `null` means the GraphQL call was skipped — absence of
      // evidence, which is not evidence of zero.
      return facts(c)?.unresolved === 0;
    case "pr-conflicting":
      return facts(c)?.mergeable === "conflicting";
    case "agent-ended-turn":
      return placeActivity(c).state === "needs-you";
    case "agent-idle-over": {
      const a = placeActivity(c);
      if (a.state !== "idle" || a.lastActivityMs === null) return false;
      return c.nowMs - a.lastActivityMs > cond.minutes * 60_000;
    }
    case "no-agent-left":
      return agentsHere(c).length === 0;
    case "tree-clean":
      // `!!g &&` rather than `!g?.dirty`: a repo missing from the status is not a
      // clean repo, it is a repo we know nothing about.
      return !!git(c) && !git(c)!.dirty;
    case "has-uncommitted":
      return git(c)?.dirty === true;
    case "nothing-to-push": {
      const g = git(c);
      // `ahead` is 0 both when everything is pushed and when there is no upstream
      // at all. The condition is named for what it can actually prove.
      return !!g && g.ahead === 0;
    }
    case "ticket-done":
      return c.status.ticketCategory === "done";
    case "ticket-status-is":
      return c.status.ticketStatus === cond.status;
    case "branch-ci-passed":
      // Unknown is NOT green, and this is the arm where that matters most: this
      // condition exists to gate a deploy. An armed flow that ships to staging
      // because a `gh` call failed, timed out, hit a rate limit or answered in a
      // shape this build does not parse is the worst outcome the whole feature can
      // produce — strictly worse than a deploy that waits one poll too long. So
      // only an explicit `"passed"` is met; `"failed"`, `"pending"`, `"unknown"`
      // and a key nobody fetched at all are all "not yet".
      //
      // The same posture every other arm above takes toward an unreadable fact:
      // `threads-resolved` demands a strict `0` because `null` is a call that was
      // skipped, `tree-clean` writes `!!g && !g.dirty` because a repo missing from
      // the status is not a clean repo, and `ci-passed` demands `passing > 0`
      // because "no checks at all" is not a pass. `branchCi()` collapses absent
      // and unreadable into the same `"unknown"` for exactly that reason.
      return branchCi(c, cond.repo, cond.branch) === "passed";
    case "command-succeeded":
      // Not answerable here, and not answered with a silent wrong guess
      // either. Every OTHER arm above is a pure function of the one
      // `RunStatus` a `CondContext` carries — a live agent, its repos, its PR
      // — because a place always resolves to exactly one of each. A command
      // node is not a place: nothing in `c` says what a shell command's exit
      // code was, because nothing about a command node ever produces a
      // `RunStatus` for one to live in. The verdict instead lives on the
      // command node's INCOMING edge — `firedAt`/`error`/`performed`, stamped
      // by `applyFired` in runner.ts — and reading that needs the whole
      // `Flow`, which only `evaluate.ts` has in scope: see `commandSucceeded`
      // there, which is where this kind is actually decided. `evaluate.ts`'s
      // `isMet` intercepts it before it ever reaches this switch, and
      // `orchestratorRule.ts`'s `observationOf` refuses this kind before ever
      // calling `describeCond`'s matching arm below — so this arm has no live
      // caller left to hand a value to. A `false` here once WAS that wrong
      // guess: harmless while nothing called it, but a silent, confidently
      // wrong answer the moment a second caller ever does. Throwing is the
      // same choice `evaluate.ts`'s `isMet` makes for "cannot say" elsewhere
      // (it returns `undefined`, never a guessed `boolean`) — `evalCond`'s own
      // return type has no room for `undefined`, so failing loudly is the
      // closest equivalent available here.
      throw new Error(
        "evalCond cannot answer command-succeeded: it is decided in evaluate.ts's " +
          "commandSucceeded from the whole Flow, never from one place's CondContext.",
      );
  }
}

/** What this place looks like with respect to this condition, right now. The
 * drawer renders it after "waiting · ", so it describes the OBSERVATION, not the
 * rule: "CI running, 4 of 7" tells you why nothing has fired, where "CI passed"
 * would only repeat the condition back at you.
 *
 * Prose, not identifiers — the Deck sets English in the UI font and keeps
 * monospace for keys, branches and counts. */
export function describeCond(cond: Condition, c: CondContext): string {
  switch (cond.kind) {
    case "pr-merged": {
      const f = facts(c);
      if (!f) return "no PR yet";
      return f.state === "MERGED" ? "merged" : f.state === "CLOSED" ? "PR closed" : "PR open";
    }
    case "ci-passed":
    case "ci-failed": {
      const f = facts(c);
      if (!f) return "no PR yet";
      const { passing, pending, failing } = f.ci;
      if (failing.length > 0) {
        const names = failing.map((k) => k.name).join(", ");
        // `ci-failed`'s predicate excludes advisory-only failures (see `evalCond`
        // above) — say so, or the drawer shows "waiting · lint failing" beside a
        // rule that will never fire on that basis. `ci-passed`'s wording is
        // unaffected: it genuinely will not fire either way, so "X failing" is
        // already the right answer for it.
        return cond.kind === "ci-failed" && f.ciAdvisory ? `${names} failing (advisory)` : `${names} failing`;
      }
      if (pending > 0) return `CI running, ${passing} of ${passing + pending}`;
      return passing > 0 ? `${passing} checks passing` : "no checks yet";
    }
    case "review-approved":
    case "changes-requested": {
      const f = facts(c);
      if (!f) return "no PR yet";
      const words: Record<PrFacts["review"], string> = {
        approved: "approved",
        changes_requested: "changes requested",
        review_required: "review required",
        none: "no review yet",
      };
      return words[f.review];
    }
    case "threads-resolved": {
      const f = facts(c);
      if (!f) return "no PR yet";
      if (f.unresolved === null) return "threads not checked";
      return f.unresolved === 0 ? "no unresolved threads" : `${f.unresolved} unresolved`;
    }
    case "pr-conflicting": {
      const f = facts(c);
      if (!f) return "no PR yet";
      return f.mergeable === "conflicting" ? "conflicting" : `mergeable: ${f.mergeable}`;
    }
    case "agent-ended-turn": {
      const a = placeActivity(c);
      if (a.state === "unknown") return "agent state unknown";
      return a.state === "needs-you" ? "ended turn" : a.state;
    }
    case "agent-idle-over": {
      const a = placeActivity(c);
      if (a.state === "unknown") return "agent state unknown";
      if (a.lastActivityMs === null) return "last activity unknown";
      if (a.state !== "idle") return a.state === "needs-you" ? "ended turn" : a.state;
      return `idle ${Math.floor((c.nowMs - a.lastActivityMs) / 60_000)}m of ${cond.minutes}m`;
    }
    case "no-agent-left": {
      const n = agentsHere(c).length;
      return n === 0 ? "no agent" : n === 1 ? "1 agent open" : `${n} agents open`;
    }
    case "tree-clean":
    case "has-uncommitted": {
      const g = git(c);
      if (!g) return "repo not found";
      // The same minus sign the Deck's diff chips use, not a hyphen.
      return g.dirty ? `+${g.added} −${g.removed} · ${g.files} files` : "clean";
    }
    case "nothing-to-push": {
      const g = git(c);
      if (!g) return "repo not found";
      return g.ahead === 0 ? "nothing to push" : `${g.ahead} to push`;
    }
    case "ticket-done": {
      // The predicate reads the category, not this status text (see `evalCond`
      // above), and the two can disagree: a workflow's status can say "Done"
      // under a category that is not `done` yet, or the category can already
      // be `done` with no status text set at all. Reflect the category
      // whenever the status text's own claim about "done-ness" does not match
      // it, so the drawer never shows "Done" beside a rule that cannot fire —
      // or the reverse.
      const status = c.status.ticketStatus ?? "no ticket status";
      const looksDone = /done/i.test(status);
      const isDone = c.status.ticketCategory === "done";
      return looksDone === isDone ? status : `${status} (${c.status.ticketCategory ?? "no category"})`;
    }
    case "branch-ci-passed": {
      // Names the branch, because `COND_LABEL` cannot: the drawer's label for this
      // kind is one static string for every rule of it, so "`main` passed" beside a
      // rule about `release` would be the only place the two are told apart.
      //
      // "not checked yet" and "unreadable" are deliberately different words for the
      // two `"unknown"`s. Both are equally not-met (see `evalCond`), but they send a
      // user to different places: an absent key means nothing fetched it — a rule on
      // a disarmed flow, or one whose repo is not on the board, since
      // `branchCiWanted` only asks for armed flows' branches — while an explicit
      // `"unknown"` means a call was made and could not be read, and that one is
      // worth looking in the log for. The webview can now tell them apart too: the
      // verdict map crosses the wire on `deck:flows` and `observationOf` puts it in
      // this context, where it used to build one without it and read every branch
      // rule as "not checked yet" forever.
      const v = branchCi(c, cond.repo, cond.branch);
      if (v === "passed") return `${cond.branch} passed`;
      if (v === "failed") return `${cond.branch} failed`;
      if (v === "pending") return `${cond.branch} CI running`;
      return c.branchCi === undefined || !(branchCiKey(cond.repo, cond.branch) in c.branchCi)
        ? `${cond.branch} not checked yet`
        : `${cond.branch} status unreadable`;
    }
    case "ticket-status-is":
      return c.status.ticketStatus ?? "no ticket status";
    case "command-succeeded":
      // Unreachable, deliberately: `observationOf` (orchestratorRule.ts)
      // refuses this kind before ever calling `describeCond` at all, rather
      // than only guarding on the source being a place — a `command-succeeded`
      // rule is not guaranteed to have a command-node source (the pickers refuse
      // to offer it off one, but a hand-edited file bypasses them entirely —
      // see `evaluate.ts`'s `commandSucceeded`, which
      // guards it on the read side), so a place-sourced one would otherwise
      // reach here too. An empty string used to be the answer, and it was
      // exactly the wrong shape of "unreachable": `observationOf` returned it
      // to the drawer, which has no `?? fallback` that catches an empty
      // string, rendering as a blank line instead of surfacing the mistake.
      // Throwing — same reasoning as `evalCond`'s arm above — turns a silent
      // blank into a loud one if this ever becomes reachable again.
      throw new Error(
        "describeCond cannot describe command-succeeded: there is no place-shaped " +
          "observation for it. observationOf (orchestratorRule.ts) must keep refusing this kind.",
      );
  }
}
