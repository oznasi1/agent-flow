import { CardAgent, DeckColumn, DeckLane, RunStatus } from "../types";
import { deriveBucket, deriveLane, prSignals } from "../engine/bucket";

/** One card on the Agents board. A run's agents are bucketed by column (see
 * below) and each distinct column its agents land in produces one of these; a
 * run with none produces exactly one, with `agent: null`. */
export interface DeckCard {
  /** React key. Prefixed because a run key and a session id are both opaque
   * strings from different namespaces and could otherwise collide. */
  id: string;
  /** The owning run's status — where the ticket, repo chips, PR block and every
   * card action still come from. Shared by reference across sibling cards. */
  status: RunStatus;
  /** The single agent this card identifies with, or null on a parked card (no
   * agent open) or a merged card (two or more agents share this card's column —
   * there is no one agent to identify with, so card-level actions fall back to
   * the run, same as a parked card). */
  agent: CardAgent | null;
  /** Every agent this card represents — one entry when `agent` is set, the
   * whole same-column group when `agent` is null and the run has agents, empty
   * on a parked card. What `AgentsRow` lists. */
  agents: CardAgent[];
  column: DeckColumn;
  /** The band within `column`, or null where the column means one thing. */
  lane: DeckLane | null;
}

/** The lane a whole run sits in, for the two card shapes that take the run's own
 * column rather than an agent's: a parked card here, and every card the
 * Workspaces lens builds. */
export function laneOf(status: RunStatus, column: DeckColumn): DeckLane | null {
  return deriveLane(column, prSignals(status.prs));
}

/**
 * Re-project the runs the host posted into per-agent cards.
 *
 * A card is bucketed by its agents' *own* state, which is the whole point of the
 * view: a run with one agent working and one that ended its turn belongs in two
 * columns at once, and the run-level `mostActive` reduction the host does can only
 * ever report one of them. Agents that land in the same column share one card —
 * two agents both idle on the same run is one card with two names inside it, not
 * two identical-looking cards — while agents in different columns still split,
 * because that split is the meaningful case this view exists for.
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
      cards.push({
        id: `p:${status.run.key}`, status, agent: null, agents: [],
        column: status.column, lane: laneOf(status, status.column),
      });
      continue;
    }
    const pr = prSignals(status.prs);
    const byColumn = new Map<DeckColumn, CardAgent[]>();
    for (const agent of status.agents) {
      const column = deriveBucket({
        ticketCategory: status.ticketCategory,
        ticketStatus: status.ticketStatus,
        agentState: agent.activity.state,
        prOpen: pr.open,
        prBlocked: pr.blocked,
        prMerged: pr.merged,
      });
      const group = byColumn.get(column);
      if (group) group.push(agent); else byColumn.set(column, [agent]);
    }
    for (const [column, group] of byColumn) {
      const lane = deriveLane(column, pr);
      cards.push(
        group.length === 1
          ? { id: `a:${group[0].session.sessionId}`, status, agent: group[0], agents: group, column, lane }
          : { id: `g:${status.run.key}:${column}`, status, agent: null, agents: group, column, lane },
      );
    }
  }
  return cards;
}
