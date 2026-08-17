import { Filter, Task, Size } from "../../types";
import {
  Capabilities, StatusTarget, TaskProvider, TaskWriteError,
} from "../provider";
import { JiraClient, TaskDetail, TransitionOption } from "./client";
import { describeJiraError, JiraApiError } from "./errors";
import {
  FieldPrompt, fieldDisplayNames, mentionsResolution, missingFieldIds,
  promptableFields, toJiraValue, TransitionFieldMeta,
} from "./transitionFields";

const ALL_FILTERS: readonly Filter[] = [
  "unassigned", "mine", "mysprint", "sprint", "backlog", "all",
];

/** What a project with no Scrum board can honestly answer. `mysprint`, `sprint` and
 * `backlog` are gone because all three are *defined* by `sprint in openSprints()` in
 * `buildJql` — without a sprint board the fallback ladder strips that clause and all
 * three degrade into duplicates of `mine`/`all`, which rendered as three tabs showing
 * the same list and explaining nothing.
 *
 * `unassigned` stays: sprint-stripped it reads "every open issue in the project with
 * nobody on it", which is a genuinely distinct and useful lens. `all` stays for the
 * same reason it is in ALL_FILTERS — it is the JQL builder's fallback default and no
 * tab bar has ever rendered it (see FILTER_ORDER in src/webview/helpers.ts). */
const SPRINTLESS_FILTERS: readonly Filter[] = ["unassigned", "mine", "all"];

/** Adapts JiraClient — the raw REST surface — to the source-agnostic
 * TaskProvider. Everything a view used to know about Jira transitions lives
 * here: which screen fields can be prompted for, how an answer becomes Jira's
 * JSON, and which fields a rejection is really pointing at.
 *
 * JiraClient itself is untouched on purpose, so its own test suite keeps
 * asserting exactly what it asserted before the seam existed. */
export class JiraProvider implements TaskProvider {
  /** Screen-field metadata from the last statusTargets() call, keyed by
   * `${issueKey}:${transitionId}` — never by transition id alone. Transition
   * ids are scoped to a Jira *workflow*, not to an individual issue, so two
   * issues that share a workflow have the exact same transition ids. Keying
   * by id alone would let one issue's cached screen metadata answer for a
   * different issue on the same workflow — not a dropped field, but a write
   * built from the wrong screen (see `moveTo`/`toWire`). */
  private metaByTarget = new Map<string, Record<string, TransitionFieldMeta>>();

  /** The prompts actually ISSUED for a transition, keyed by the same
   * `${issueKey}:${transitionId}` composite as `metaByTarget`, for the same
   * reason: transition ids are per-workflow, so an id-only key would let one
   * issue's `allowedValues` — and therefore its label-to-id mapping — build
   * another issue's write when two issues share a workflow.
   *
   * This deliberately is not re-derived from `metaByTarget` at write time, and
   * that is the whole point: the Resolution fallback in `retryPrompts` synthesizes
   * a prompt for a field the transition screen never declared. `promptableFields`
   * filters its `only` list with `id in fields`, so re-deriving would silently
   * drop that synthesized field — the user would be asked for a Resolution and
   * the retry would POST without it, earning the same refusal again. Remembering
   * what we asked for is the only thing that closes that hole. */
  private promptsByTarget = new Map<string, Map<string, FieldPrompt>>();

  /** The one place a cache key is assembled, so a call site can never forget
   * to fold the issue key in (see the fields above for why that matters). */
  private cacheKey(key: string, targetId: string): string {
    return `${key}:${targetId}`;
  }

  /** Record prompts we are about to put in front of the user, so `toWire` can map
   * their answers back. Merges rather than replaces: a recovery round adds to
   * what the first round already asked. */
  private rememberPrompts(key: string, targetId: string, prompts: FieldPrompt[]): void {
    const cacheKey = this.cacheKey(key, targetId);
    const known = this.promptsByTarget.get(cacheKey) ?? new Map<string, FieldPrompt>();
    for (const p of prompts) known.set(p.id, p);
    this.promptsByTarget.set(cacheKey, known);
  }

  constructor(private readonly client: JiraClient) {}

  /** Read fresh on every access, from a synchronous snapshot the client keeps — NOT a
   * field computed in the constructor. Two reasons, both load-bearing:
   *
   * A provider is built per operation, but the shape probe is one async round trip that
   * lands *after* the provider that started it is already in use. A field would freeze
   * the optimistic answer into the very instance the panel is reading.
   *
   * And a `null` snapshot must mean "behave exactly as this connector did before
   * detection existed" — every lens, sprints on — not "no sprints". Getting that
   * backwards would strip three tabs off every Scrum user's panel for the lifetime of
   * one failed request. `test/unit/tasksView.test.ts`'s `JIRA_CAPS` constant pins the
   * un-probed answer, so that inertness is enforced rather than merely intended. */
  get caps(): Capabilities {
    const hasSprints = this.client.shapeSnapshot?.()?.hasSprints ?? true;
    return {
      supportedFilters: hasSprints ? ALL_FILTERS : SPRINTLESS_FILTERS,
      sizes: true,
      labels: { add: (key, label) => this.client.addLabel(key, label) },
      ...(hasSprints
        ? {
            sprints: {
              activeId: async () => {
                const id = await this.client.getActiveSprintId();
                return id == null ? null : String(id);
              },
              add: (sprintId: string, key: string) =>
                this.client.addIssueToSprint(Number(sprintId), key),
              remove: (key: string) => this.client.removeIssueFromSprint(key),
            },
          }
        : {}),
      components: {
        list: () => this.client.listComponents(),
        update: (key, delta) => this.client.updateComponents(key, delta),
      },
      // Guarded on the method existing rather than declared unconditionally: the
      // wholesale client mock in test/unit/tasksView.test.ts has no `childrenOf`, and
      // a capability that claims to answer but throws on the first call would turn
      // every Take there into the degraded path. Same defensive shape as
      // `this.client.shapeSnapshot?.()` above.
      ...(typeof this.client.childrenOf === "function"
        ? { children: { of: (key: string) => this.client.childrenOf(key) } }
        : {}),
    };
  }

  /** Learn the project's board setup, so `caps` can narrow. Never rejects: a client
   * with no `loadShape` (the wholesale mock in `test/unit/tasksView.test.ts`) and a
   * board list that cannot be read both mean the same thing here — keep claiming what
   * we already claimed. */
  async refreshCaps(): Promise<void> {
    try {
      await this.client.loadShape?.();
    } catch {
      /* an unlearnable shape leaves the optimistic caps in place, on purpose */
    }
  }

  list(lens: Filter, size: Size, max = 50): Promise<Task[]> {
    return this.client.fetchTasks(lens, size, max);
  }

  detail(key: string): Promise<TaskDetail> {
    return this.client.getDetail(key);
  }

  status(key: string): Promise<{ status: string | null; category: string | null }> {
    return this.client.getStatus(key);
  }

  /** `id` is Jira's accountId, and can be `""` for a `/myself` that answered with a
   * display name but no account id — the seam allows that (see `TaskProvider.me`),
   * because the name alone still drives the header chip and the "mine" affordances. */
  me(): Promise<{ id: string; displayName: string } | null> {
    return this.client.getMyself().then((m) =>
      m ? { id: m.accountId, displayName: m.displayName } : null,
    );
  }

  async assignToMe(key: string, meId?: string): Promise<void> {
    // A caller that already resolved `me()` passes its `id` — which IS the Jira
    // accountId, renamed by the seam — so this makes no second /myself request.
    // `getMyself()` returns `{ accountId, displayName }` with no `id` field, so the
    // fallback reads `accountId` rather than coalescing over a property that does not
    // exist on the client's shape.
    const accountId = meId ?? (await this.client.getMyself())?.accountId;
    // Never call assignIssue with a blank id: Jira reads that as "unassign", which is
    // the opposite of what this method promises. Guards the passed-in id too — an
    // empty string from a caller must fail here, not silently unassign.
    if (!accountId) throw new Error("Couldn't resolve your Jira account.");
    await this.client.assignIssue(key, accountId);
  }

  async statusTargets(key: string): Promise<StatusTarget[]> {
    const transitions = await this.client.getTransitions(key);
    this.metaByTarget.clear();
    this.promptsByTarget.clear();
    return transitions.map((t: TransitionOption) => {
      // `fields` is absent on anything that didn't come from an expanded
      // getTransitions — the metadata is Jira's JSON, not a guarantee.
      const meta = t.fields ?? {};
      this.metaByTarget.set(this.cacheKey(key, t.id), meta);
      // `skipped` is required-but-unpromptable — a rich-text body, an attachment.
      // Carried on the target rather than dropped: the view logs it, which is the
      // only trace that Agent Flow chose not to ask before a write Jira then refuses
      // for exactly that field. Omitted when empty so the property means one thing.
      const { prompts, skipped } = promptableFields(meta);
      this.rememberPrompts(key, t.id, prompts);
      return {
        id: t.id,
        toName: t.toName,
        toCategory: (t.toCategory || "") as StatusTarget["toCategory"],
        ...(t.name !== t.toName ? { via: t.name } : {}),
        fields: prompts,
        ...(skipped.length ? { unfillable: skipped } : {}),
      };
    });
  }

  async moveTo(
    key: string,
    targetId: string,
    values: Record<string, string | string[]>,
  ): Promise<void> {
    const meta = this.metaByTarget.get(this.cacheKey(key, targetId)) ?? {};
    try {
      await this.client.transition(key, targetId, this.toWire(key, targetId, values));
    } catch (e) {
      if (!(e instanceof JiraApiError)) throw e;
      throw new TaskWriteError(
        describeJiraError(e, fieldDisplayNames(meta)),
        await this.retryPrompts(key, targetId, meta, e),
        // For the view's log line: a field-scoped refusal's prose says nothing about
        // whether Jira called it forbidden or malformed.
        e.status,
      );
    }
  }

  /** Turn raw prompt answers into the JSON Jira's transition body expects.
   * An id with no screen metadata is dropped rather than guessed at — Jira
   * would reject the write anyway, and less informatively — UNLESS none of
   * the supplied values resolve to anything remembered for this issue+target
   * at all, in which case dropping everything would silently send an empty
   * write instead of the one the caller asked for. That combination (values
   * given, nothing recognized) only happens when `statusTargets(key)` was
   * never called for this transition on this instance — a caller bug worth
   * failing loudly on, not swallowing. A transition with no fields, called
   * with no values, is the ordinary case and must stay silent. */
  private toWire(
    key: string,
    targetId: string,
    values: Record<string, string | string[]>,
  ): Record<string, unknown> {
    const known = this.promptsByTarget.get(this.cacheKey(key, targetId));
    const entries = Object.entries(values);
    const out: Record<string, unknown> = {};
    let resolvedAny = false;
    for (const [id, raw] of entries) {
      const prompt = known?.get(id);
      // An id we never prompted for is dropped rather than guessed at: without a
      // FieldPrompt there is no way to know whether Jira wants a bare string, an
      // {id} reference or an array, and a wrong shape earns a less informative
      // refusal than sending nothing. A single unrecognized id alongside ones we
      // do recognize keeps exactly this drop-it behaviour — see the all-or-nothing
      // check below for when that silence stops being safe.
      if (prompt) {
        out[id] = toJiraValue(prompt, raw);
        resolvedAny = true;
      }
    }
    if (entries.length > 0 && !resolvedAny) {
      throw new Error(
        `JiraProvider.moveTo(${key}, ${targetId}): received values but none of them ` +
          `match a remembered field prompt. statusTargets(${key}) must be called ` +
          `before moveTo(${key}, ${targetId}, …) so answers can be mapped back to Jira's wire shape.`,
      );
    }
    return out;
  }

  /** What, if anything, is worth asking the user for after a refusal. Screen
   * metadata cannot see custom workflow validators, so the rejection itself is
   * the only place some requirements are ever stated. */
  private async retryPrompts(
    key: string,
    targetId: string,
    meta: Record<string, TransitionFieldMeta>,
    err: JiraApiError,
  ): Promise<FieldPrompt[]> {
    const ids = missingFieldIds(meta, err);
    if (ids.length) {
      const { prompts } = promptableFields(meta, { only: ids });
      if (prompts.length) {
        this.rememberPrompts(key, targetId, prompts);
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
        this.rememberPrompts(key, targetId, synthesized);
        return synthesized;
      }
    }
    return [];
  }
}
