import { JiraAuth } from "./auth";
import { buildJql, stripPriorityOrder, stripSprint } from "./jql";
import { childrenJql } from "./childJql";
import { JiraApiError, parseJiraError } from "./errors";
import { TransitionFieldMeta } from "./transitionFields";
import { Filter, Task, Size } from "../../types";
import { markTaskNetworkFailure, TaskAuthError } from "../provider";
import {
  isShapeFresh, lastShape, peekSprintField, pickBoard, ProjectShape, putShape,
  putSprintField, siteKey,
} from "./shape";

export class JiraAuthError extends TaskAuthError {
  constructor(message: string) {
    super(message);
    // Still explicit, still a literal — the base sets "TaskAuthError" and this
    // must win, and esbuild's minifier makes the class identifier unusable.
    // classifyFailure (telemetry/events.ts) checks `e.name === "JiraAuthError"`
    // (alongside the base's own "TaskAuthError") and needs this to survive
    // minification; a string literal does.
    this.name = "JiraAuthError";
  }
}

// One import site for Jira failures: callers catching a rejected write need both
// this and JiraAuthError, and they mean different things — auth re-gates the panel,
// an API error is reported in place.
export { JiraApiError } from "./errors";

/** How long a single Jira request may run before we give up. Without this a wrong
 * base URL or an unreachable site (VPN off, DNS, firewall) hangs `fetch` forever,
 * which would leave the panel stuck on "loading" with no indication of why. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The project's component list. Short-lived on purpose: a component created in Jira
 * should become syncable without a window reload, and the payload is a handful of
 * names. Keyed by site AND project (`siteId`) — a project key alone let two Jira
 * sites that both define a `PLAT` project answer each other's component reads. */
const COMPONENTS_TTL_MS = 5 * 60_000;
const cachedComponents = new Map<string, { names: string[]; at: number }>();

const LIST_FIELDS = ["summary", "status", "priority", "assignee", "labels", "components", "updated", "timeoriginalestimate", "issuetype"];
const DETAIL_FIELDS = ["summary", "description", "labels", "components", "priority", "status", "assignee"];
/** All a child row needs: what to call it, what kind it is, whether it is already
 *  done. Deliberately narrower than LIST_FIELDS — a tree probe runs once per node. */
const CHILD_FIELDS = ["summary", "issuetype", "status"];

/** A workflow transition plus the fields its screen declares — the metadata that
 *  tells us what to prompt for before attempting the write. */
export interface TransitionOption {
  id: string;
  name: string;
  toName: string;
  toCategory: string;
  fields: Record<string, TransitionFieldMeta>;
}

export interface TaskDetail {
  key: string;
  summary: string;
  descriptionText: string;
  labels: string[];
  components: string[];
  url: string;
  status: string | null; // status name, e.g. "In Review"
  statusCategory: string | null; // "new" | "indeterminate" | "done"
}

/** One child of a ticket, one level down. Lives here rather than in `../provider`
 *  for the same reason `TaskDetail` does: the connector owns the shape it produces,
 *  and `provider.ts` re-exports it type-only. */
export interface ChildRef {
  key: string;
  summary: string;
  type: string;
  statusCategory: "new" | "indeterminate" | "done" | null;
}

export class JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly project: string,
    private readonly auth: JiraAuth,
  ) {}

  /** This client's cache identity: which site, which project. A cache key, not a
   *  display string and not a URL. */
  private get siteId(): string {
    return siteKey(this.baseUrl, this.project);
  }

  private async request(pathname: string, init?: RequestInit): Promise<any> {
    const header = await this.auth.getAuthHeader();
    if (!header) throw new JiraAuthError("Not signed in to Jira.");
    if (!this.baseUrl) {
      throw new Error("No Jira site URL configured. Use the “Run Setup…” command.");
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        ...init,
        signal: ctl.signal,
        headers: {
          Authorization: header,
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(init?.headers || {}),
        },
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw markTaskNetworkFailure(
          new Error(
            `Jira didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s (${this.baseUrl}). ` +
              "Check agentFlow.jira.baseUrl and your network/VPN.",
          ),
          "ETIMEDOUT",
        );
      }
      throw markTaskNetworkFailure(
        new Error(`Couldn't reach Jira at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`),
        "ENOTFOUND",
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new JiraAuthError(`Jira auth failed (${res.status}). Sign in again.`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw parseJiraError(res.status, body);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null; // transitions/edits return 204 No Content
  }

  /** Deliberately NOT gated on `accountId`: a `/myself` that answers with a display
   * name but no account id (Jira Server/DC, or a field-stripping proxy) still names
   * the signed-in user, and dropping the whole identity over the missing id took the
   * header's name chip AND every "is this task mine?" affordance with it — including
   * "Add to my sprint" on the user's own out-of-sprint tasks. The write side stays
   * safe where it matters: `assignToMe` refuses an empty id rather than unassigning.
   * Either field alone is an identity; neither means nobody, which is still `null`. */
  async getMyself(): Promise<{ accountId: string; displayName: string } | null> {
    try {
      const me = await this.request("/rest/api/3/myself");
      return me?.accountId || me?.displayName
        ? { accountId: me.accountId ?? "", displayName: me.displayName ?? "" }
        : null;
    } catch {
      return null;
    }
  }

  /** `getMyself()` with the swallowing removed, for Doctor. That method returns
   *  `null` for a rejected token, a timeout *and* an unreachable host alike, so a
   *  check that must fail on bad credentials but only warn on a dead network cannot
   *  be built on it. Let both kinds through and let the caller classify:
   *  `JiraAuthError` means the credentials, any other Error means reaching Jira. */
  async probeMyself(): Promise<{ accountId: string; displayName: string }> {
    const me = await this.request("/rest/api/3/myself");
    return { accountId: me?.accountId ?? "", displayName: me?.displayName || me?.emailAddress || "" };
  }

  /** Does the configured project key resolve for this user? A valid token with a
   *  renamed or mistyped key renders an empty panel and explains nothing. Throws
   *  `JiraApiError` (404 when the key isn't visible). */
  async getProject(key: string): Promise<{ id: string; key: string; name: string }> {
    const p = await this.request(`/rest/api/3/project/${encodeURIComponent(key)}`);
    return { id: p?.id ?? "", key: p?.key ?? key, name: p?.name ?? "" };
  }

  /** Resolve (once per site, per FIELD_TTL_MS) the id of the Sprint custom field. */
  private async sprintFieldId(): Promise<string | null> {
    const known = peekSprintField(this.baseUrl);
    if (known) return known.id;
    let resolved: string | null = null;
    try {
      const fields = await this.request("/rest/api/3/field");
      const f = Array.isArray(fields)
        ? fields.find((x: any) => x?.schema?.custom === "com.pyxis.greenhopper.jira:gh-sprint")
        : null;
      resolved = f?.id ?? null;
    } catch {
      resolved = null; // give up quietly — sprint detection just stays off
    }
    putSprintField(this.baseUrl, resolved);
    return resolved;
  }

  /** The board setup of the configured project, cached per site+project.
   *
   * On a read failure this answers `{ boardId: null, hasSprints: true, boardCount: 0 }`
   * — **optimistic, and deliberately not cached.** The Agile API 403s for a user
   * without a Jira Software licence and 404s behind some proxies, and treating either
   * as "this project has no sprints" would strip the sprint tabs off a working Scrum
   * project over one bad request. `hasSprints: true` with `boardId: null` is exactly
   * the pre-detection behaviour: claim sprints, and let the sprint lookup find no
   * board and answer null. An auth failure is NOT swallowed — a dead token is a fact
   * about the credentials, and the panel already re-gates on it. */
  async loadShape(): Promise<ProjectShape> {
    const known = this.shapeSnapshot();
    if (known && isShapeFresh(this.baseUrl, this.project)) return known;
    try {
      return await this.fetchShape();
    } catch (e) {
      if (e instanceof JiraAuthError) throw e;
      // A stale answer beats the optimistic guess: it is what this project actually
      // looked like ten minutes ago, and the alternative silently re-widens the
      // capabilities we already narrowed.
      return known ?? { boardId: null, hasSprints: true, boardCount: 0 };
    }
  }

  /** `loadShape` with the swallowing removed — the board setup, or the reason we
   *  could not read it. Exists because the two callers need opposite things from a
   *  failure: narrowing capabilities must degrade quietly (an unreadable board list
   *  is not a reason to shout at someone who only opened the panel), while a sprint
   *  WRITE must not turn "couldn't reach Jira" into `boardId: null`, which its caller
   *  reports to the user as the confident and false "No active sprint on the X
   *  board." Caches on success exactly as `loadShape` does, so the two share one
   *  answer per session. */
  private async fetchShape(): Promise<ProjectShape> {
    const payload = await this.request(
      `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(this.project)}&maxResults=50`,
    );
    return putShape(this.baseUrl, this.project, pickBoard(payload));
  }

  /** What `loadShape` last learned, without making a request — **including an answer
   *  past its re-read interval**, which is why this reads `lastShape` rather than
   *  gating on freshness. `null` means nothing has ever been learned, and the caller
   *  must treat that as "behave exactly as before detection existed", never as "no
   *  sprints". Re-reading is `loadShape`'s job; this method never lets a shape we once
   *  knew turn back into "unknown", because `JiraProvider.caps` maps unknown to the
   *  every-lens answer and would re-grow the tabs it had already dropped. */
  shapeSnapshot(): ProjectShape | null {
    return lastShape(this.baseUrl, this.project);
  }

  async fetchTasks(filter: Filter, size: Size = "any", maxResults = 50): Promise<Task[]> {
    // Degrade gracefully: full query → without sprint clause (no sprint board) →
    // without size clause (time-tracking disabled) → without either.
    const full = buildJql(this.project, filter, size);
    const candidates = [full];
    const push = (q: string) => { if (!candidates.includes(q)) candidates.push(q); };
    push(stripSprint(full));
    if (size !== "any") {
      const noSize = buildJql(this.project, filter, "any");
      push(noSize);
      push(stripSprint(noSize));
    }
    // Sort-stripped variants go LAST, after every WHERE-stripped candidate: a wrong
    // sort is cosmetic and a wrong filter is a wrong list, so the ladder should
    // exhaust everything that keeps the sort before trading it away. Iterating over a
    // copy — `push` appends to `candidates` as we go.
    for (const q of [...candidates]) push(stripPriorityOrder(q));

    const sprintField = await this.sprintFieldId();
    const fields = sprintField ? [...LIST_FIELDS, sprintField] : LIST_FIELDS;

    let lastErr: unknown;
    for (const jql of candidates) {
      try {
        const data = await this.searchJql(jql, fields, maxResults);
        return (data?.issues ?? []).map((i: any) => this.normalize(i, sprintField));
      } catch (e) {
        if (e instanceof JiraAuthError) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  private async searchJql(jql: string, fields: string[], maxResults: number): Promise<any> {
    return this.request("/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({ jql, fields, maxResults }),
    });
  }

  async getDetail(key: string): Promise<TaskDetail> {
    const data = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${DETAIL_FIELDS.join(",")}`,
    );
    // request() maps an empty body to null (the 204 contract), and some proxies
    // answer 200 with no body. Every sibling reads `data?.…`, but a detail with no
    // key or summary is a husk the take flow would seed a blank brief from — a
    // failed read has to look like one, in the same JiraApiError shape every other
    // failed read produces.
    if (data == null) {
      throw new JiraApiError(200, `Jira answered with an empty response for ${key}.`, {}, []);
    }
    const f = data?.fields ?? {};
    return {
      key: data.key,
      summary: f.summary ?? "",
      descriptionText: adfToText(f.description),
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c: any) => c.name),
      url: `${this.baseUrl}/browse/${data.key}`,
      status: f.status?.name ?? null,
      statusCategory: f.status?.statusCategory?.key ?? null,
    };
  }

  /** The children of one issue, one level down. The first candidate JQL with a
   *  non-empty answer wins (see `childrenJql` for why non-empty and not merely
   *  non-failing); a rejected candidate moves to the next; every candidate answering
   *  empty means "no children", which is the common case and not an error. */
  async childrenOf(key: string): Promise<ChildRef[]> {
    let answered = false;
    let lastErr: unknown;
    for (const jql of childrenJql(key)) {
      try {
        const data = await this.searchJql(jql, CHILD_FIELDS, 100);
        answered = true;
        const kids: ChildRef[] = (data?.issues ?? []).map((i: any) => ({
          key: i.key,
          summary: i.fields?.summary ?? "",
          type: i.fields?.issuetype?.name ?? "",
          // Same boundary cast `normalize` documents: a real site's category key is
          // not guaranteed to be one of the three the union names.
          statusCategory: (i.fields?.status?.statusCategory?.key ?? null) as ChildRef["statusCategory"],
        }));
        if (kids.length) return kids;
      } catch (e) {
        if (e instanceof JiraAuthError) throw e;
        lastErr = e;
      }
    }
    // An authoritative empty answer is final: a site that answered "no children" via
    // the modern `parent` spelling has told us what we asked, and a later candidate
    // failing because its field does not exist there is not a failure to read the tree.
    // `Epic Link` is a company-managed Jira Software custom field, so on a team-managed
    // project — the default for new Jira Cloud projects — that candidate 400s for every
    // ordinary childless ticket. Throwing on it would make the caller announce a failed
    // read on the single most common path in the product.
    if (!answered && lastErr) throw lastErr;
    return [];
  }

  /** Lightweight status lookup for the Deck — just the fields a card needs. */
  async getStatus(key: string): Promise<{ status: string | null; category: string | null }> {
    const data = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`,
    );
    const s = data?.fields?.status;
    return { status: s?.name ?? null, category: s?.statusCategory?.key ?? null };
  }

  /** Valid workflow transitions for an issue (Jira only allows configured next
   *  states). Expanded with each transition's screen fields — same round-trip,
   *  and it's the only way to know what the write will demand. */
  async getTransitions(key: string): Promise<TransitionOption[]> {
    const data = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions?expand=transitions.fields`,
    );
    return (data?.transitions ?? []).map((t: any) => ({
      id: t.id,
      name: t.name,
      toName: t.to?.name ?? t.name,
      toCategory: t.to?.statusCategory?.key ?? "",
      fields: t.fields ?? {},
    }));
  }

  async transition(key: string, transitionId: string, fields: Record<string, unknown> = {}): Promise<void> {
    const body: Record<string, unknown> = { transition: { id: transitionId } };
    if (Object.keys(fields).length) body.fields = fields;
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /** The site's resolution list. Only used when a workflow validator demands a
   *  Resolution that never appeared on the transition screen. */
  async listResolutions(): Promise<{ id?: string; name: string }[]> {
    const data = await this.request("/rest/api/3/resolution");
    return (Array.isArray(data) ? data : [])
      .map((r: any) => ({ id: r?.id, name: r?.name ?? "" }))
      .filter((r: { name: string }) => !!r.name);
  }

  /** Add a label without touching others (used to stamp provenance on writes). */
  async addLabel(key: string, label: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ update: { labels: [{ add: label }] } }),
    });
  }

  /** The component names this project defines — the only names a component write
   *  may use, and `[]` when it defines none. `null` means the read itself failed:
   *  callers must not report that as "no such component", because it is equally
   *  likely to be a dead token or an unreachable site. Cached for
   *  `COMPONENTS_TTL_MS`; a failure is never cached, so the next call retries.
   *  Failures are swallowed here, so callers that need auth errors reported must
   *  read the issue *before* calling this. */
  async listComponents(): Promise<string[] | null> {
    const hit = cachedComponents.get(this.siteId);
    if (hit && Date.now() - hit.at < COMPONENTS_TTL_MS) return hit.names;
    let names: string[];
    try {
      const data = await this.request(
        `/rest/api/3/project/${encodeURIComponent(this.project)}/components`,
      );
      names = (Array.isArray(data) ? data : []).map((c: any) => c?.name ?? "").filter((n: string) => !!n);
    } catch {
      return null;
    }
    cachedComponents.set(this.siteId, { names, at: Date.now() });
    return names;
  }

  /** Add and/or remove components on an issue, leaving every other component in
   *  place (Jira WRITE). Additive verbs only — a `set` would delete the components
   *  that have no local checkout. Names must be spelled as the project spells them. */
  async updateComponents(key: string, delta: { add?: string[]; remove?: string[] }): Promise<void> {
    const ops = [
      ...(delta.add ?? []).map((name) => ({ add: { name } })),
      ...(delta.remove ?? []).map((name) => ({ remove: { name } })),
    ];
    if (ops.length === 0) return;
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ update: { components: ops } }),
    });
  }

  /** The active sprint on the project's board, or null if there is none.
   *
   * The board comes from `loadShape()` rather than a fresh list-and-pick, so this and
   * every other sprint operation in a session agree on one board. That agreement is
   * the point: the previous code took `values[0]` from whatever order Jira replied in,
   * so on a project with several boards this lookup and a subsequent write could
   * disagree, and "Add to my sprint" could move an issue into a sprint the user was
   * never shown. */
  async getActiveSprintId(): Promise<number | null> {
    // `fetchShape`, not `loadShape`: a board list we could not read must fail here
    // rather than answer `boardId: null`, which this method's caller reports as
    // "No active sprint on the X board." — a confident claim about the user's Jira
    // built from a request that never arrived. A `null` from a shape we genuinely
    // read is the honest version of that message, and still returns null.
    const { boardId } = this.shapeSnapshot() ?? (await this.fetchShape());
    if (boardId == null) return null;
    const sprints = await this.request(`/rest/agile/1.0/board/${boardId}/sprint?state=active`);
    return (sprints?.values ?? [])[0]?.id ?? null;
  }

  /** Move an issue into a sprint (Jira Agile WRITE). */
  async addIssueToSprint(sprintId: number, key: string): Promise<void> {
    await this.request(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
      method: "POST",
      body: JSON.stringify({ issues: [key] }),
    });
  }

  /** Move an issue to the backlog — removes it from any active/future sprint (Jira Agile WRITE). */
  async removeIssueFromSprint(key: string): Promise<void> {
    await this.request(`/rest/agile/1.0/backlog/issue`, {
      method: "POST",
      body: JSON.stringify({ issues: [key] }),
    });
  }

  /** Assign an issue to an account (Jira WRITE). */
  async assignIssue(key: string, accountId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, {
      method: "PUT",
      body: JSON.stringify({ accountId }),
    });
  }

  private normalize(issue: any, sprintField: string | null): Task {
    const f = issue.fields ?? {};
    const { sprintName, inOpenSprint } = parseSprints(sprintField ? f[sprintField] : null);
    return {
      key: issue.key,
      summary: f.summary ?? "",
      status: f.status?.name ?? "",
      // The one place Jira's untyped JSON enters the typed domain: `issue` is `any`,
      // so nothing here forces this cast, but a real site's key is never guaranteed
      // to be one of the three the union promises — this is the boundary that answers
      // for it.
      statusCategory: (f.status?.statusCategory?.key ?? "new") as Task["statusCategory"],
      priority: f.priority?.name ?? "",
      assignee: f.assignee?.displayName ?? "Unassigned",
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c: any) => c.name),
      sprint: sprintName,
      inOpenSprint,
      updated: f.updated ?? "",
      url: `${this.baseUrl}/browse/${issue.key}`,
      estimateSeconds: typeof f.timeoriginalestimate === "number" ? f.timeoriginalestimate : null,
      type: f.issuetype?.name ?? "",
    };
  }
}

/** Read the Sprint field value (array of sprint objects, or legacy toString form)
 * into a display name + whether any of them is currently active. */
export function parseSprints(val: any): { sprintName: string | null; inOpenSprint: boolean } {
  if (!Array.isArray(val)) return { sprintName: null, inOpenSprint: false };
  let sprintName: string | null = null;
  let inOpenSprint = false;
  for (const s of val) {
    let state: string | undefined;
    let name: string | undefined;
    if (s && typeof s === "object") {
      state = s.state;
      name = s.name;
    } else if (typeof s === "string") {
      state = /state=(\w+)/.exec(s)?.[1];
      name = /name=([^,\]]+)/.exec(s)?.[1];
    }
    if (state && state.toLowerCase() === "active") {
      inOpenSprint = true;
      if (name) sprintName = name;
    } else if (!sprintName && name) {
      sprintName = name;
    }
  }
  return { sprintName, inOpenSprint };
}

/** Flatten Atlassian Document Format (rich JSON) into plain text for matching. */
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  let out = "";
  if (node.text) out += node.text;
  const content = node.content;
  if (Array.isArray(content)) {
    for (const child of content) out += " " + adfToText(child);
  }
  return out.trim();
}
