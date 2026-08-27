import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OpenSession } from "../types";
import { pidAlive, canon } from "./paths";
import { repoRoot } from "./git";

export type { OpenSession }; // re-exported so callers can take both from here

/** ~/.claude/sessions — Claude Code's live session registry, one file per running
 * session. Claude Code owns this directory: Agent Flow Deck only ever reads it, and
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

/** What a sessions read saw, and whether it could see at all. */
export interface SessionsProbe {
  sessions: OpenSession[];
  /** False when the directory itself could not be read. `sessions: []` alone
   * cannot say whether nothing is running or nothing could be SEEN, and
   * `promoteExited` needs that difference: it calls a card's agent dead on a
   * zero count, so a single failed read used to mark every mid-work card on the
   * board `exited` on the next 6s poll — and inflate the sidebar badge to
   * match. A record that fails to parse, or whose pid is dead, does NOT clear
   * this flag: the directory was read fine and that record really is not a live
   * session. */
  readable: boolean;
}

/**
 * `readOpenSessions`, plus whether the directory could be read. See
 * `SessionsProbe.readable` for why the difference is worth a return type.
 * The narrowing rules applied to each record — skip on parse failure, drop a
 * dead pid, keep an absent `kind` — are documented on `readOpenSessions` below.
 */
export function readOpenSessionsProbe(dir: string): SessionsProbe {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { sessions: [], readable: false };
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
  return { sessions: out.sort((a, b) => a.startedAt - b.startedAt), readable: true };
}

/**
 * Every session still open, oldest first. Skips a record that fails to parse or
 * lacks a field a card needs, drops one whose pid is dead (a crash leaves the
 * file behind), and drops one whose `kind` is present and is not "interactive".
 * An absent `kind` is kept on purpose: a future Claude Code that stops writing
 * the field should degrade to showing sessions, not to showing none.
 *
 * Best-effort throughout — an unreadable directory yields [] with no way for
 * the caller to tell that from a genuinely empty one. A caller that needs to
 * tell the two apart wants `readOpenSessionsProbe` instead.
 */
export function readOpenSessions(dir: string): OpenSession[] {
  return readOpenSessionsProbe(dir).sessions;
}

/**
 * Sessions grouped by the git repo root containing their cwd, so one started in
 * `centaur/src` groups with one started in `centaur` — and so a place compares
 * equal to a run record's repo path, which is always a root. A cwd in no repo
 * groups under itself. Keys are canonicalised, so /var and /private/var
 * spellings of one directory land in one group.
 */
export function groupByPlace(sessions: OpenSession[]): Map<string, OpenSession[]> {
  const out = new Map<string, OpenSession[]>();
  for (const s of sessions) {
    const place = canon(repoRoot(s.cwd) || s.cwd);
    const list = out.get(place);
    if (list) list.push(s);
    else out.set(place, [s]);
  }
  return out;
}
