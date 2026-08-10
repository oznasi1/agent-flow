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

/** A card's worth of places: one multi-root window's session directories, or a
 * single directory that no live window claims. */
export interface LocalGroup {
  /** The .code-workspace this card stands for, or null for a lone place. */
  workspaceFile: string | null;
  /** Every folder the card covers, in window order. `[place]` when standalone. */
  roots: string[];
  /** The session places inside this group, in input order — never empty. */
  places: string[];
}

/**
 * Fold session places into the multi-root window that holds them.
 *
 * Only a window with a .code-workspace and more than one root groups anything: a
 * single-folder window *is* the place, so grouping it would rename the card after
 * a file that adds no information. A window whose record carries no `roots` was
 * written by an older extension host and claims nothing — that record cannot say
 * which folders it holds, and guessing from the workspace file would mean reading
 * and parsing it on every refresh.
 *
 * Every input place comes back in exactly one group, in first-appearance order,
 * so the board's card order does not shuffle between refreshes.
 */
export function groupPlacesByWindow(
  places: string[],
  windows: { identity: string; kind: "workspace" | "folder"; roots?: string[] }[],
): LocalGroup[] {
  const owner = new Map<string, { identity: string; roots: string[] }>();
  for (const w of windows) {
    const roots = w.roots ?? [];
    if (w.kind !== "workspace" || roots.length < 2) continue;
    for (const root of roots) {
      if (!owner.has(root)) owner.set(root, { identity: w.identity, roots });
    }
  }
  const groups: LocalGroup[] = [];
  const byWorkspace = new Map<string, LocalGroup>();
  for (const place of places) {
    const win = owner.get(place);
    if (!win) {
      groups.push({ workspaceFile: null, roots: [place], places: [place] });
      continue;
    }
    const existing = byWorkspace.get(win.identity);
    if (existing) {
      existing.places.push(place);
      continue;
    }
    const group: LocalGroup = { workspaceFile: win.identity, roots: win.roots, places: [place] };
    byWorkspace.set(win.identity, group);
    groups.push(group);
  }
  return groups;
}
