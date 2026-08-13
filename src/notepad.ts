// Pure notepad logic — no `vscode`, no mocked extension context needed, no
// `Date.now`/`Math.random`. Lives outside tasksView.ts (host-side only; the
// webview imports only the notepad types from ./types, never this module) so
// it is unit-testable without a mocked extension context, and so the
// 1700-line controller grows only the glue that genuinely needs VS Code.
// `canon` does touch `fs` (via `fs.realpathSync`), same as `src/engine/runs.ts`
// which imports it the same way — that's fine here, per the same reasoning:
// this file's purity bar is "no vscode / no mocked context", not "no fs".
import { NotepadItem, NotepadRunStatus, NotepadSection, Run } from "./types";
import { canon } from "./engine/paths";

/** A note's run status, from the two cheap signals `describeActiveTasks` already
 * uses for the same question — deliberately NOT `retireVerdict`, which needs live
 * git state, `gh` PR facts, and a ticket category that the Tasks panel neither
 * has nor should pay for on every poll.
 *
 * `livePlaces` is the canonicalised repo-root set of directories with a Claude
 * Code session open right now: build it exactly as deckView.ts does —
 * `new Set(groupByPlace(readOpenSessions(dir)).keys())`.
 *
 * Undefined means "nothing to say": either the note was never run, or its record
 * is gone because the Deck's sweep already retired it. Claiming "finished" for a
 * retired record would be a guess — retirement covers unreachable and abandoned
 * too, not just landed work.
 *
 * Known limitation: "finished" is only reachable through the Deck. `finishedAt`
 * has exactly one writer — the Deck's own poll loop (`src/deckView.ts`) — so a
 * user who runs a note but never opens the Deck will see this settle on
 * "running" and then "stale" once the session ends, but never "finished". This
 * matches how plain `explore` runs already behave (their status has the same
 * dependency); it is accepted, not a bug, but is easy to misread from this
 * function alone since all three states otherwise read as self-sufficient. */
export function noteStatus(
  note: NotepadItem,
  runs: Run[],
  livePlaces: ReadonlySet<string>,
): NotepadRunStatus | undefined {
  if (!note.lastRunKey) return undefined;
  const run = runs.find((r) => r.key === note.lastRunKey);
  if (!run) return undefined;
  if (typeof run.finishedAt === "number") return "finished";
  // `repos` is guarded rather than trusted, for the same reason describeActiveTasks
  // guards it: readRuns only validates that a record has `.key`, so a legacy or
  // hand-edited file can reach here with `repos` missing entirely.
  const repos = run.repos ?? [];
  return repos.some((r) => livePlaces.has(canon(r.path))) ? "running" : "stale";
}

/** A fresh note. `id` and `createdAt` are injected rather than generated here so
 * this stays pure and its tests need no clock or randomness stub. */
export function newNote(title: string, body: string, id: string, createdAt: number): NotepadItem {
  return { id, title: title.trim(), body: body.trim(), done: false, createdAt };
}

/** A fresh section. Same injection pattern as `newNote` — `id`/`createdAt` are
 * passed in so this stays pure. */
export function newSection(name: string, id: string, createdAt: number): NotepadSection {
  return { id, name: name.trim(), createdAt };
}

/** Notes as read back from globalState, which is untyped storage that a previous
 * version — or a hand-edited state file — may have left in any shape. Anything
 * without a usable id is dropped; everything else is coerced to the current
 * shape rather than trusted, so one bad record cannot break the whole panel. */
export function sanitizeNotes(raw: unknown): NotepadItem[] {
  if (!Array.isArray(raw)) return [];
  const out: NotepadItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0) continue;
    const note: NotepadItem = {
      id: e.id,
      title: typeof e.title === "string" ? e.title : "",
      body: typeof e.body === "string" ? e.body : "",
      done: e.done === true,
      createdAt: typeof e.createdAt === "number" ? e.createdAt : 0,
    };
    if (typeof e.lastRunKey === "string") note.lastRunKey = e.lastRunKey;
    if (typeof e.sectionId === "string") note.sectionId = e.sectionId;
    out.push(note);
  }
  return out;
}

/** Sections as read back from globalState, same defensive stance as
 * `sanitizeNotes`. A section with no usable id OR no usable (non-empty,
 * trimmed) name is dropped rather than coerced: an unnamed header is not a
 * section anyone could recognise, unlike a note's title, which can be blank —
 * a note still has its body to identify it, a section header has nothing else. */
export function sanitizeSections(raw: unknown): NotepadSection[] {
  if (!Array.isArray(raw)) return [];
  const out: NotepadSection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0) continue;
    if (typeof e.name !== "string" || e.name.trim().length === 0) continue;
    out.push({
      id: e.id,
      name: e.name,
      createdAt: typeof e.createdAt === "number" ? e.createdAt : 0,
    });
  }
  return out;
}
