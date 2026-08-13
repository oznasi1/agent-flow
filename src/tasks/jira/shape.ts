/** What Agent Flow has learned about one Jira project's board setup, and the two
 * caches that remember it. Separate from `client.ts` for one reason: both caches
 * used to be module-level state in there, keyed by less than identifies them — the
 * Sprint field id by nothing at all, the component list by project key alone — so
 * a `baseUrl` change mid-session, or two sites that both define a `PLAT` project,
 * were answered with the wrong site's data. A module whose only exported writers
 * take `(baseUrl, project)` cannot be keyed wrongly by a future call site. */

/** Everything one Agile API round trip can tell us about a project's board setup.
 * `boardCount` is not used to decide anything — it exists so the one genuinely
 * ambiguous case (several Scrum boards on one project) can be logged rather than
 * silently resolved. */
export interface ProjectShape {
  /** The board every sprint operation on this project will use, or null when the
   *  project has no board at all. */
  boardId: number | null;
  /** True only when the chosen board is one Jira itself types as `scrum`. This is
   *  the fact the sprint-shaped filter lenses and `caps.sprints` hang off. */
  hasSprints: boolean;
  /** How many boards the project has, of any type. Diagnostic only. */
  boardCount: number;
}

/** Board setup changes when someone reconfigures a project — rarely, but a user who
 * creates their first Scrum board should not have to reload the window to get their
 * sprint tabs. Ten minutes is the same order as the component list's own TTL. */
export const SHAPE_TTL_MS = 10 * 60_000;

/** The Sprint custom field id is stable per SITE, not per project — but a resolved
 * `null` (the lookup failed, or the site has no greenhopper field) used to be
 * remembered forever, which turned a transient 500 into "sprints are off until you
 * reload the window." A TTL costs one extra `/field` request every ten minutes on a
 * site that genuinely has no Sprint field, and buys recovery on the far more common
 * case of a request that just failed once. */
export const FIELD_TTL_MS = 10 * 60_000;

/** The one place a cache key is assembled. A NUL separator rather than a printable
 * one because a project key is user input: `siteKey("https://a.test", "AB|C")` and
 * `siteKey("https://a.test|AB", "C")` must not collide, and NUL can appear in
 * neither a URL nor a Jira project key. */
function key(baseUrl: string, project: string): string {
  return `${baseUrl}\u0000${project}`;
}

export function siteKey(baseUrl: string, project: string): string {
  return key(baseUrl, project);
}

const shapes = new Map<string, { shape: ProjectShape; at: number }>();
const sprintFields = new Map<string, { id: string | null; at: number }>();

/** The cached shape, or null when nothing is known — never a guess. Synchronous and
 * I/O-free on purpose: `JiraProvider.caps` is a synchronous getter that reads this,
 * and a `caps` that awaited anything would change the seam for every connector. */
export function peekShape(baseUrl: string, project: string): ProjectShape | null {
  const k = key(baseUrl, project);
  const hit = shapes.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at >= SHAPE_TTL_MS) {
    shapes.delete(k);
    return null;
  }
  return hit.shape;
}

/** Returns what it stored so a caller can cache-and-return in one expression. */
export function putShape(baseUrl: string, project: string, shape: ProjectShape): ProjectShape {
  shapes.set(key(baseUrl, project), { shape, at: Date.now() });
  return shape;
}

/** `null` means "not known"; `{ id: null }` means "known: this site has no Sprint
 * field." Collapsing those two into one value is what made a failed lookup
 * permanent, so the two-level shape is deliberate. */
export function peekSprintField(baseUrl: string): { id: string | null } | null {
  const hit = sprintFields.get(baseUrl);
  if (!hit) return null;
  if (Date.now() - hit.at >= FIELD_TTL_MS) {
    sprintFields.delete(baseUrl);
    return null;
  }
  return { id: hit.id };
}

export function putSprintField(baseUrl: string, id: string | null): void {
  sprintFields.set(baseUrl, { id, at: Date.now() });
}

/** Test seam. Production never calls this: the TTLs are the production answer to
 * staleness, and a cache a running extension can wipe is a cache whose lifetime
 * nothing can reason about. */
export function resetShapeCaches(): void {
  shapes.clear();
  sprintFields.clear();
}

/** Read Jira's `/rest/agile/1.0/board` payload into a `ProjectShape`.
 *
 * Pure, and total: every malformed shape Jira or a proxy could hand back resolves to
 * "no boards" rather than throwing, because the caller's fallback for "we could not
 * learn the shape" is today's behaviour, and an exception there would instead take
 * out the caps refresh that wraps it.
 *
 * **Scrum wins over Kanban, and the LOWEST id wins among Scrum boards.** The second
 * half is not a claim that the lowest id is the *right* board — with two Scrum boards
 * on one project (a board per team, common) nothing in the API says which one the
 * user means, and this is deliberately not a setting. What the ordering buys is that
 * the answer is *stable*: the previous code took `values[0]`, so two operations in one
 * session could disagree if Jira's paging order shifted, and "Add to my sprint" could
 * put an issue in a different sprint from the one the board's own sprint lookup
 * reported. Stable-and-possibly-not-yours is a strictly better failure than
 * arbitrary-and-possibly-not-yours. */
export function pickBoard(payload: unknown): ProjectShape {
  const values =
    typeof payload === "object" && payload !== null && Array.isArray((payload as { values?: unknown }).values)
      ? (payload as { values: unknown[] }).values
      : [];
  const boards = values.filter(
    (b): b is { id: number; type?: string } =>
      typeof b === "object" && b !== null && typeof (b as { id?: unknown }).id === "number",
  );
  const scrum = boards.filter((b) => b.type === "scrum").sort((a, b) => a.id - b.id);
  const chosen = scrum[0] ?? [...boards].sort((a, b) => a.id - b.id)[0];
  return {
    boardId: chosen?.id ?? null,
    hasSprints: scrum.length > 0,
    boardCount: values.length,
  };
}
