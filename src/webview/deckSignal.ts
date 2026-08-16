import { CardAgent, PrFacts, RunStatus } from "../types";

/** One element of a card's signal line. `diff` is its own kind rather than a
 * formatted string because the two halves take different colors, and a card
 * must never set a count in anything but mono. */
export type SignalBit =
  | { kind: "text"; text: string; tone?: "bad" | "warn" | "ok"; mono?: boolean }
  | { kind: "diff"; added: number; removed: number };

const REVIEW_TEXT: Record<PrFacts["review"], string> = {
  approved: "approved",
  changes_requested: "changes",
  review_required: "required",
  none: "pending",
};

/** The PR this card speaks for. A card names one PR, so when several repos have
 * one it must pick the same one every render: the first failing PR by repo name,
 * else the first PR by repo name. Sorting is what makes it deterministic —
 * `Object.entries` order follows insertion, which the host does not promise. */
function leadPr(r: RunStatus): PrFacts | null {
  const withFacts = Object.entries(r.prs)
    .map(([repo, e]) => [repo, e.facts] as const)
    .filter((x): x is readonly [string, PrFacts] => x[1] !== null)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (withFacts.length === 0) return null;
  return (withFacts.find(([, f]) => f.ci.failing.length > 0) ?? withFacts[0])[1];
}

/**
 * The one line a card at rest gets, worst fact first and capped at three bits.
 *
 * The cap is the whole design: a card that says five things says nothing, and
 * the fourth bit is always the least decisive one. Diff totals lose to PR news
 * outright — "how big" never outranks "what is wrong".
 */
export function cardSignal(r: RunStatus, agent: CardAgent | null): SignalBit[] {
  const bits: SignalBit[] = [];
  const f = leadPr(r);

  if (f) {
    bits.push({ kind: "text", text: `#${f.number}`, mono: true });

    if (f.ci.failing.length > 0) {
      bits.push({ kind: "text", text: `✗ ${f.ci.failing[0].name}`, tone: "bad" });
    } else if (f.ci.pending > 0) {
      bits.push({ kind: "text", text: `${f.ci.pending} running` });
    } else if (f.state === "MERGED") {
      bits.push({ kind: "text", text: "merged", tone: "ok" });
    } else {
      bits.push({ kind: "text", text: "✓ ci", tone: "ok" });
    }

    // Only an open PR has a mergeability worth reporting — GitHub stops computing
    // it once the PR closes, exactly as PrBlock's own comment explains.
    if (f.state === "OPEN" && f.mergeable === "conflicting") {
      bits.push({ kind: "text", text: "conflicts", tone: "warn" });
    } else if (f.review === "changes_requested") {
      bits.push({ kind: "text", text: "changes", tone: "warn" });
    } else if (f.review === "approved") {
      bits.push({ kind: "text", text: "approved", tone: "ok" });
    } else if (f.state !== "MERGED") {
      bits.push({ kind: "text", text: REVIEW_TEXT[f.review] });
    }

    return bits.slice(0, 3);
  }

  // The agent's own repo, not repos[0]: on a multi-root card the first repo may
  // be one this session never touched.
  const own = agent?.repo ? r.run.repos.find((x) => x.name === agent.repo) : undefined;
  const branch = (own ?? r.run.repos[0])?.branch;
  if (branch) bits.push({ kind: "text", text: `⎇ ${branch}`, mono: true });

  const tot = r.repos.reduce((s, g) => ({ a: s.a + g.added, d: s.d + g.removed }), { a: 0, d: 0 });
  if (tot.a > 0 || tot.d > 0) bits.push({ kind: "diff", added: tot.a, removed: tot.d });

  if (r.repos.length > 1) bits.push({ kind: "text", text: `${r.repos.length} repos` });
  else if (r.agents.length > 1) bits.push({ kind: "text", text: `${r.agents.length} agents` });

  return bits.slice(0, 3);
}
