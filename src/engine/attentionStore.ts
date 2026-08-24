import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** ~/.agentflow/attention.json — which runs have already had their toast.
 *
 * Cross-window on purpose: every open editor window runs its own extension host
 * over the same runs store, so an in-memory latch would announce the same run
 * once per window, and would forget everything on an extension-host restart.
 *
 * Advisory rather than locked, and the write is atomic (temp + rename) so a
 * crash mid-write cannot leave a truncated file behind for the next window to
 * read. Two windows racing one pass costs at most one duplicate toast, which is
 * not worth the coordination the orchestrator's flows need.
 *
 * The honest bound is wider than that, though, and it is a bound on *repetition*
 * rather than on a single race: the focused window rewrites the whole file, and
 * `nextAnnouncements` prunes every stamp whose key is not in the set THIS window
 * just computed. Two windows that genuinely compute different sets therefore
 * prune each other's stamps, and each re-announces the other's runs the next
 * time focus lands on it — indefinitely, not once. That needs the two windows to
 * disagree about which runs are waiting, which needs a per-window setting to
 * differ: `agentFlow.inflightShowAll`, `agentFlow.openAgents` and
 * `agentFlow.prFacts` are all `window`-scoped, so a workspace that overrides one
 * of them is enough.
 *
 * Left as it is on purpose. The prune's destructiveness is the mechanism that
 * makes park -> answer -> park announce twice, which is specified behaviour and
 * the whole point of a level-triggered latch. Scoping the record per window
 * would trade a rare repeat for announcing every run once per open window, which
 * is worse; the trade is recorded in the design doc's Accepted trade-offs. */
export function defaultAttentionFile(): string {
  return path.join(os.homedir(), ".agentflow", "attention.json");
}

/** The record, or `{}` for a missing, unreadable or corrupt file. Values are
 * filtered to numbers: a hand-edited or half-written file must degrade to
 * "nothing announced yet", never hand the latch something it will compare
 * against a timestamp. */
export function readAnnounced(file: string): Record<string, number> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    // An array passes `typeof === "object"` but takes non-index properties that
    // JSON.stringify silently drops, which would wedge the file at "[]" forever.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, v]) => typeof v === "number"),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

/** Persist the record. Best-effort: a failed write costs at most one duplicate
 * toast on the next pass, and must never propagate into the poll. */
export function writeAnnounced(file: string, announced: Record<string, number>): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(announced) + "\n");
    fs.renameSync(temp, file);
  } catch {
    // See the doc comment: advisory store, deliberately silent.
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
