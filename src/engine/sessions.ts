import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenSession } from "../types";
import { pidAlive } from "./paths";

export type { OpenSession }; // re-exported so callers can take both from here

/** ~/.claude/sessions — Claude Code's live session registry, one file per running
 * session. Claude Code owns this directory: Agent Flow only ever reads it, and
 * never prunes a stale record the way presence.ts prunes its own. */
export function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".claude", "sessions");
}

/** The fields we probe before trusting a record. Everything is `unknown` because
 * this file is written by another program and may change shape under us. */
interface RawSession {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  name?: unknown;
  kind?: unknown;
}

/**
 * Every session still open, oldest first. Skips a record that fails to parse or
 * lacks a field a card needs, drops one whose pid is dead (a crash leaves the
 * file behind), and drops one whose `kind` is present and is not "interactive".
 * An absent `kind` is kept on purpose: a future Claude Code that stops writing
 * the field should degrade to showing sessions, not to showing none.
 *
 * Best-effort throughout — an unreadable directory yields [] and the Deck falls
 * back to the board it renders today.
 */
export function readOpenSessions(dir: string): OpenSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: OpenSession[] = [];
  for (const name of names) {
    let raw: RawSession;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as RawSession;
    } catch {
      continue; // a half-written or hand-edited record must not blow up the read
    }
    if (typeof raw.kind === "string" && raw.kind !== "interactive") continue;
    if (typeof raw.pid !== "number" || raw.pid <= 0) continue;
    if (typeof raw.sessionId !== "string" || !raw.sessionId) continue;
    if (typeof raw.cwd !== "string" || !raw.cwd) continue;
    if (!pidAlive(raw.pid)) continue;
    out.push({
      pid: raw.pid,
      sessionId: raw.sessionId,
      cwd: raw.cwd,
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
      name: typeof raw.name === "string" && raw.name ? raw.name : null,
    });
  }
  // Oldest first: the expansion then lists a place's agents in the order they
  // were opened, and a local card's createdAt is simply the first one's start.
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
