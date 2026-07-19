import { JiraAuth } from "./auth";
import { buildJql, stripSprint } from "./jql";
import { Filter, JiraTask, Size } from "../types";

export class JiraAuthError extends Error {}

/** How long a single Jira request may run before we give up. Without this a wrong
 * base URL or an unreachable site (VPN off, DNS, firewall) hangs `fetch` forever,
 * which would leave the panel stuck on "loading" with no indication of why. */
const REQUEST_TIMEOUT_MS = 15_000;

// The Sprint field is a custom (greenhopper) field; its id is stable per Jira site.
let cachedSprintFieldId: string | null | undefined;

const LIST_FIELDS =["summary", "status", "priority", "assignee", "labels", "components", "updated", "timeoriginalestimate"];
const DETAIL_FIELDS = ["summary", "description", "labels", "components", "priority", "status", "assignee"];

export interface JiraDetail {
  key: string;
  summary: string;
  descriptionText: string;
  labels: string[];
  components: string[];
  url: string;
  status: string | null; // status name, e.g. "In Review"
  statusCategory: string | null; // "new" | "indeterminate" | "done"
}

export class JiraClient {
  constructor(
    private readonly baseUrl: string,
    private readonly project: string,
    private readonly auth: JiraAuth,
  ) {}

  private async request(pathname: string, init?: RequestInit): Promise<any> {
    const header = await this.auth.getAuthHeader();
    if (!header) throw new JiraAuthError("Not signed in to Jira.");
    if (!this.baseUrl) {
      throw new Error("No Jira site URL configured. Run “Agent Flow: Run Setup…”.");
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
        throw new Error(
          `Jira didn't respond within ${REQUEST_TIMEOUT_MS / 1000}s (${this.baseUrl}). ` +
            "Check agentFlow.jira.baseUrl and your network/VPN.",
        );
      }
      throw new Error(`Couldn't reach Jira at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      throw new JiraAuthError(`Jira auth failed (${res.status}). Sign in again.`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Jira ${res.status}: ${body.slice(0, 300)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null; // transitions/edits return 204 No Content
  }

  async currentUserName(): Promise<string | null> {
    try {
      const me = await this.request("/rest/api/3/myself");
      return me?.displayName ?? null;
    } catch {
      return null;
    }
  }

  async getMyself(): Promise<{ accountId: string; displayName: string } | null> {
    try {
      const me = await this.request("/rest/api/3/myself");
      return me?.accountId ? { accountId: me.accountId, displayName: me.displayName ?? "" } : null;
    } catch {
      return null;
    }
  }

  /** Resolve (once, per site) the id of the Sprint custom field. */
  private async sprintFieldId(): Promise<string | null> {
    if (cachedSprintFieldId !== undefined) return cachedSprintFieldId;
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
    cachedSprintFieldId = resolved;
    return resolved;
  }

  async fetchTasks(filter: Filter, size: Size = "any", maxResults = 50): Promise<JiraTask[]> {
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

  async getDetail(key: string): Promise<JiraDetail> {
    const data = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${DETAIL_FIELDS.join(",")}`,
    );
    const f = data.fields ?? {};
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

  /** Lightweight status lookup for the Deck — just the fields a card needs. */
  async getStatus(key: string): Promise<{ status: string | null; category: string | null }> {
    const data = await this.request(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`,
    );
    const s = data?.fields?.status;
    return { status: s?.name ?? null, category: s?.statusCategory?.key ?? null };
  }

  /** Valid workflow transitions for an issue (Jira only allows configured next states). */
  async getTransitions(key: string): Promise<{ id: string; name: string; toName: string; toCategory: string }[]> {
    const data = await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
    return (data?.transitions ?? []).map((t: any) => ({
      id: t.id,
      name: t.name,
      toName: t.to?.name ?? t.name,
      toCategory: t.to?.statusCategory?.key ?? "",
    }));
  }

  async transition(key: string, transitionId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: "POST",
      body: JSON.stringify({ transition: { id: transitionId } }),
    });
  }

  /** Add a label without touching others (used to stamp provenance on writes). */
  async addLabel(key: string, label: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ update: { labels: [{ add: label }] } }),
    });
  }

  /** The active sprint on the project's (scrum) board, or null if there is none. */
  async getActiveSprintId(): Promise<number | null> {
    const boards = await this.request(
      `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(this.project)}&maxResults=50`,
    );
    const values = boards?.values ?? [];
    const board = values.find((b: any) => b?.type === "scrum") ?? values[0];
    if (!board) return null;
    const sprints = await this.request(`/rest/agile/1.0/board/${board.id}/sprint?state=active`);
    return (sprints?.values ?? [])[0]?.id ?? null;
  }

  /** Move an issue into a sprint (Jira Agile WRITE). */
  async addIssueToSprint(sprintId: number, key: string): Promise<void> {
    await this.request(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
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

  private normalize(issue: any, sprintField: string | null): JiraTask {
    const f = issue.fields ?? {};
    const { sprintName, inOpenSprint } = parseSprints(sprintField ? f[sprintField] : null);
    return {
      key: issue.key,
      summary: f.summary ?? "",
      status: f.status?.name ?? "",
      statusCategory: f.status?.statusCategory?.key ?? "new",
      priority: f.priority?.name ?? "",
      assignee: f.assignee?.displayName ?? "Unassigned",
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c: any) => c.name),
      sprint: sprintName,
      inOpenSprint,
      updated: f.updated ?? "",
      url: `${this.baseUrl}/browse/${issue.key}`,
      estimateSeconds: typeof f.timeoriginalestimate === "number" ? f.timeoriginalestimate : null,
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
