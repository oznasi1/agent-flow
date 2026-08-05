import { Filter, JiraTask, Size } from "../../types";
import {
  Capabilities, StatusTarget, TaskProvider, TaskWriteError,
} from "../provider";
import { JiraClient, JiraDetail, TransitionOption } from "./client";
import { describeJiraError, JiraApiError } from "./errors";
import {
  FieldPrompt, fieldDisplayNames, mentionsResolution, missingFieldIds,
  promptableFields, toJiraValue, TransitionFieldMeta,
} from "./transitionFields";

const ALL_FILTERS: readonly Filter[] = [
  "unassigned", "mine", "mysprint", "sprint", "backlog", "all",
];

/** Adapts JiraClient — the raw REST surface — to the source-agnostic
 * TaskProvider. Everything a view used to know about Jira transitions lives
 * here: which screen fields can be prompted for, how an answer becomes Jira's
 * JSON, and which fields a rejection is really pointing at.
 *
 * JiraClient itself is untouched on purpose, so its own test suite keeps
 * asserting exactly what it asserted before the seam existed. */
export class JiraProvider implements TaskProvider {
  /** Screen-field metadata from the last statusTargets() call, per transition id.
   * Used to work out what a rejection is complaining about, without paying a
   * second round-trip for data we just had. */
  private metaByTarget = new Map<string, Record<string, TransitionFieldMeta>>();

  /** The prompts actually ISSUED for a transition, by field id.
   *
   * This deliberately is not re-derived from `metaByTarget` at write time, and
   * that is the whole point: the Resolution fallback in `retryPrompts` synthesizes
   * a prompt for a field the transition screen never declared. `promptableFields`
   * filters its `only` list with `id in fields`, so re-deriving would silently
   * drop that synthesized field — the user would be asked for a Resolution and
   * the retry would POST without it, earning the same refusal again. Remembering
   * what we asked for is the only thing that closes that hole. */
  private promptsByTarget = new Map<string, Map<string, FieldPrompt>>();

  /** Record prompts we are about to put in front of the user, so `toWire` can map
   * their answers back. Merges rather than replaces: a recovery round adds to
   * what the first round already asked. */
  private rememberPrompts(targetId: string, prompts: FieldPrompt[]): void {
    const known = this.promptsByTarget.get(targetId) ?? new Map<string, FieldPrompt>();
    for (const p of prompts) known.set(p.id, p);
    this.promptsByTarget.set(targetId, known);
  }

  constructor(private readonly client: JiraClient) {}

  readonly caps: Capabilities = {
    supportedFilters: ALL_FILTERS,
    sizes: true,
    labels: { add: (key, label) => this.client.addLabel(key, label) },
    sprints: {
      activeId: async () => {
        const id = await this.client.getActiveSprintId();
        return id == null ? null : String(id);
      },
      add: (sprintId, key) => this.client.addIssueToSprint(Number(sprintId), key),
      remove: (key) => this.client.removeIssueFromSprint(key),
    },
    components: {
      list: () => this.client.listComponents(),
      update: (key, delta) => this.client.updateComponents(key, delta),
    },
  };

  list(lens: Filter, size: Size, max = 50): Promise<JiraTask[]> {
    return this.client.fetchTasks(lens, size, max);
  }

  detail(key: string): Promise<JiraDetail> {
    return this.client.getDetail(key);
  }

  status(key: string): Promise<{ status: string | null; category: string | null }> {
    return this.client.getStatus(key);
  }

  me(): Promise<{ id: string; displayName: string } | null> {
    return this.client.getMyself().then((m) =>
      m ? { id: m.accountId, displayName: m.displayName } : null,
    );
  }

  async assignToMe(key: string): Promise<void> {
    const me = await this.client.getMyself();
    // Never call assignIssue with a blank id: Jira reads that as "unassign",
    // which is the opposite of what this method promises. `getMyself()` returns
    // `{ accountId, displayName }` — there is no `id` field on it, so read
    // `accountId` directly rather than coalescing over a property that does not
    // exist. (The seam's `me()` renames it to `id`; the client does not.)
    if (!me) throw new Error("Couldn't resolve your Jira account.");
    await this.client.assignIssue(key, me.accountId);
  }

  async statusTargets(key: string): Promise<StatusTarget[]> {
    const transitions = await this.client.getTransitions(key);
    this.metaByTarget.clear();
    this.promptsByTarget.clear();
    return transitions.map((t: TransitionOption) => {
      // `fields` is absent on anything that didn't come from an expanded
      // getTransitions — the metadata is Jira's JSON, not a guarantee.
      const meta = t.fields ?? {};
      this.metaByTarget.set(t.id, meta);
      const { prompts } = promptableFields(meta);
      this.rememberPrompts(t.id, prompts);
      return {
        id: t.id,
        toName: t.toName,
        toCategory: (t.toCategory || "") as StatusTarget["toCategory"],
        ...(t.name !== t.toName ? { via: t.name } : {}),
        fields: prompts,
      };
    });
  }

  async moveTo(
    key: string,
    targetId: string,
    values: Record<string, string | string[]>,
  ): Promise<void> {
    const meta = this.metaByTarget.get(targetId) ?? {};
    try {
      await this.client.transition(key, targetId, this.toWire(targetId, values));
    } catch (e) {
      if (!(e instanceof JiraApiError)) throw e;
      throw new TaskWriteError(
        describeJiraError(e, fieldDisplayNames(meta)),
        await this.retryPrompts(targetId, meta, e),
      );
    }
  }

  /** Turn raw prompt answers into the JSON Jira's transition body expects.
   * An id with no screen metadata is dropped rather than guessed at — Jira
   * would reject the write anyway, and less informatively. */
  private toWire(
    targetId: string,
    values: Record<string, string | string[]>,
  ): Record<string, unknown> {
    const known = this.promptsByTarget.get(targetId);
    const out: Record<string, unknown> = {};
    for (const [id, raw] of Object.entries(values)) {
      const prompt = known?.get(id);
      // An id we never prompted for is dropped rather than guessed at: without a
      // FieldPrompt there is no way to know whether Jira wants a bare string, an
      // {id} reference or an array, and a wrong shape earns a less informative
      // refusal than sending nothing.
      if (prompt) out[id] = toJiraValue(prompt, raw);
    }
    return out;
  }

  /** What, if anything, is worth asking the user for after a refusal. Screen
   * metadata cannot see custom workflow validators, so the rejection itself is
   * the only place some requirements are ever stated. */
  private async retryPrompts(
    targetId: string,
    meta: Record<string, TransitionFieldMeta>,
    err: JiraApiError,
  ): Promise<FieldPrompt[]> {
    const ids = missingFieldIds(meta, err);
    if (ids.length) {
      const { prompts } = promptableFields(meta, { only: ids });
      if (prompts.length) {
        this.rememberPrompts(targetId, prompts);
        return prompts;
      }
    }
    if (mentionsResolution(err)) {
      // Swallowed on purpose: failing to fetch the list only costs us the
      // recovery attempt, and the original refusal is still reported.
      const resolutions = await this.client.listResolutions().catch(() => []);
      if (resolutions.length) {
        // `resolution` is NOT in `meta` — that is precisely why this fallback
        // exists. It must be remembered, or toWire cannot map the answer and the
        // retry silently POSTs without the field we just asked the user for.
        const synthesized: FieldPrompt[] = [
          { kind: "pick", id: "resolution", name: "Resolution", choices: resolutions },
        ];
        this.rememberPrompts(targetId, synthesized);
        return synthesized;
      }
    }
    return [];
  }
}
