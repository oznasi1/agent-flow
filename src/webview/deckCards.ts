import { CardAgent, DeckColumn, RunStatus } from "../types";
import { deriveBucket, prSignals } from "../engine/bucket";

/** One card on the Agents board. A run with two agents open in it produces two of
 * these; a run with none produces exactly one, with `agent: null`. */
export interface DeckCard {
  /** React key. Prefixed because a run key and a session id are both opaque
   * strings from different namespaces and could otherwise collide. */
  id: string;
  /** The owning run's status — where the ticket, repo chips, PR block and every
   * card action still come from. Shared by reference across sibling cards. */
  status: RunStatus;
  /** null on a parked card: the run has no agent open in it. */
  agent: CardAgent | null;
  column: DeckColumn;
}

/**
 * Re-project the runs the host posted into per-agent cards.
 *
 * An agent card is bucketed by *its own* state, which is the whole point of the
 * view: a run with one agent working and one that ended its turn belongs in two
 * columns at once, and the run-level `mostActive` reduction the host does can only
 * ever report one of them.
 *
 * A parked card keeps `status.column` untouched rather than re-deriving it. The
 * host computed that from the run's own transcript reads, which still say
 * something useful about an agentless run (a session that exited two minutes ago
 * leaves a warm transcript) — and `stateView` renders from the same source, so
 * re-deriving here would let the dot and the column disagree.
 */
export function projectCards(runs: RunStatus[]): DeckCard[] {
  const cards: DeckCard[] = [];
  for (const status of runs) {
    if (status.agents.length === 0) {
      cards.push({ id: `p:${status.run.key}`, status, agent: null, column: status.column });
      continue;
    }
    const pr = prSignals(status.prs);
    for (const agent of status.agents) {
      cards.push({
        id: `a:${agent.session.sessionId}`,
        status,
        agent,
        column: deriveBucket({
          jiraCategory: status.jiraCategory,
          jiraStatus: status.jiraStatus,
          agentState: agent.activity.state,
          prOpen: pr.open,
          prBlocked: pr.blocked,
          prMerged: pr.merged,
        }),
      });
    }
  }
  return cards;
}
