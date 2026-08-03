import { createHash } from "crypto";
import * as path from "path";
import { Run } from "../types";
import { OpenSession } from "./sessions";

/** A Jira ticket named by a branch. */
export interface InferredTicket {
  key: string;
  url: string;
  summary: string;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The ticket a branch names, or null. Gated on the project key the user actually
 * works in, so a guess can only ever name an issue that could exist for them —
 * `feature/x` names nothing, and `PROJ-12-x` in an ASM shop is somebody else's
 * convention. The summary is the branch's own tail, never fetched: reading the
 * real one would mean a Jira round trip before the card could be built at all,
 * to improve a line the branch already says.
 */
export function inferTicket(branch: string | null, project: string, baseUrl: string): InferredTicket | null {
  if (!branch || !project) return null;
  const m = new RegExp(`^(${escapeRe(project)}-\\d+)(?:[-_/](.*))?$`, "i").exec(branch);
  if (!m) return null;
  const key = m[1].toUpperCase();
  const summary = (m[2] ?? "").replace(/[-_/]+/g, " ").trim() || key;
  return { key, url: `${baseUrl.replace(/\/+$/, "")}/browse/${key}`, summary };
}

/**
 * A local card's identity. It has to survive a refresh (React keys, and the
 * `prfacts/<key>.json` cache), be safe as a filename, and never collide. A slug
 * of the whole path satisfies the first two and can blow past a 255-byte
 * filename on a deep worktree; a bare hash satisfies all three and is
 * unreadable in a log. The basename keeps it greppable, the hash keeps two
 * places that share one distinct.
 */
export function localKey(place: string): string {
  const slug = path.basename(place).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `local-${slug || "place"}-${createHash("sha1").update(place).digest("hex").slice(0, 8)}`;
}

/**
 * The card for a place Agent Flow Deck never launched, shaped as a Run so the whole
 * existing pipeline — gitState, deriveBucket, prSignals, presence, Open, Diff —
 * renders it with no special case. Never written to the runs store unless the
 * user picks Track it.
 */
export function localRunFor(
  place: string,
  sessions: OpenSession[],
  git: { isGit: boolean; branch: string | null },
  ticket: InferredTicket | null,
  nowMs: number,
): Run {
  const name = path.basename(place) || place;
  const started = sessions.map((s) => s.startedAt).filter((n) => n > 0);
  return {
    key: localKey(place),
    summary: ticket?.summary ?? name,
    url: ticket?.url ?? "",
    createdAt: started.length > 0 ? Math.min(...started) : nowMs,
    kind: "local",
    mode: "per-window",
    repos: [{ name, path: place, isGit: git.isGit, ...(git.branch ? { branch: git.branch } : {}) }],
    briefPaths: [],
  };
}
