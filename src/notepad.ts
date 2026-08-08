// Pure notepad logic — no `vscode`, no `fs`. Lives outside tasksView.ts so it is
// testable without a mocked extension context, and so the 1700-line controller
// grows only the glue that genuinely needs VS Code.
import { NotepadItem, NotepadRunStatus, Run } from "./types";

// `canon` is deliberately reimplemented here rather than imported from
// `./engine/paths` — that module does `import * as fs from "fs"` at module
// scope, and dragging that into notepad.ts would break the "no fs" purity
// this file exists to guarantee (the webview may one day import it directly).
// Since notes only ever compare against `livePlaces` sets built the same way
// callers already build them (see `noteStatus` below), an identity fallback
// for paths that don't resolve is all that's needed here.
function canon(p: string): string {
  return p;
}

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
 * too, not just landed work. */
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
    out.push(note);
  }
  return out;
}
