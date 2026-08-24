import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** ~/.agentflow/attention.json — which runs have already had their toast.
 *
 * Cross-window on purpose: every open editor window runs its own extension host
 * over the same runs store, so an in-memory latch would announce the same run
 * once per window, and would forget everything on an extension-host restart.
 *
 * Advisory rather than locked. The worst a lost race can do is raise one
 * duplicate toast, which is not worth the coordination the orchestrator's flows
 * need — and the write is atomic (temp + rename) so a crash mid-write cannot
 * leave a truncated file behind for the next window to read. */
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
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(announced) + "\n");
    fs.renameSync(temp, file);
  } catch {
    // See the doc comment: advisory store, deliberately silent.
  }
}
