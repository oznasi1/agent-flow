// One condition, one place, one answer. Every predicate here is a pure function of
// a single `RunStatus` — the snapshot `buildRunStatus` already builds for the board
// — so the whole vocabulary is table-testable and adds no I/O of its own. Adding a
// condition that needs a new fact means teaching the Deck to observe it first.
import { AgentActivity, PrFacts, RepoGit, RunStatus } from "../../types";
import { mostActive } from "../status";
import { Condition } from "./model";

export interface CondContext {
  status: RunStatus;
  /** The node's repo. A place node always resolves to exactly one, so no
   * condition is ever ambiguous about which repo's git or PR it means. */
  repo: string;
  nowMs: number;
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
 * other. Falls back to the run-level aggregate when nothing is attached here.
 *
 * Exported so `evaluate.ts`'s agent-state-unknown guard reads exactly this, not
 * the unfiltered run aggregate — a place whose own repo has no agent while a
 * different repo's agent is live must still read as unknown here. */
export function placeActivity(c: CondContext): AgentActivity {
  const here = agentsHere(c);
  return here.length > 0 ? mostActive(here.map((a) => a.activity)) : c.status.agent;
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
      return c.status.jiraCategory === "done";
    case "ticket-status-is":
      return c.status.jiraStatus === cond.status;
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
      if (failing.length > 0) return `${failing.map((k) => k.name).join(", ")} failing`;
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
    case "ticket-done":
    case "ticket-status-is":
      return c.status.jiraStatus ?? "no Jira status";
  }
}
