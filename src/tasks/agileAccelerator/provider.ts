// src/tasks/agileAccelerator/provider.ts
import type { Filter, Size, Task } from "../../types";
import {
  Capabilities, StatusTarget, TaskDetail, TaskProvider, TaskWriteError,
} from "../provider";
import type { SfCli } from "./cli";
import type { Schema } from "./describe";
import { buildDetailQuery, buildListQuery } from "./soql";
import { idOf, keyOf, toDetail, toTask, type SfRecord } from "./shape";

/** Injected rather than constructed here: the connector owns the session-lived
 *  describe cache, identity cache, key→Id memo and batched status memo, and a
 *  provider is rebuilt per operation by contract — so anything cached inside a
 *  provider would never be read twice. */
export interface ProviderDeps {
  cli: SfCli;
  schema(): Promise<Schema>;
  identity(): Promise<{ id: string; displayName: string } | null>;
  statusOf(key: string): Promise<{ status: string | null; category: string | null }>;
  rememberIds(pairs: readonly [string, string][]): void;
  team: string;
  instanceUrl: string;
}

export class AgileAcceleratorProvider implements TaskProvider {
  constructor(private readonly deps: ProviderDeps) {}

  /** Static, so `refreshCaps` is deliberately NOT implemented — the seam
   *  requires omitting it rather than shipping a no-op. Optional members are
   *  absent, not false: this source has no labels, sprints, components or
   *  children, and v1 has no writes. */
  readonly caps: Capabilities = {
    supportedFilters: ["mine", "unassigned", "all"],
    sizes: false,
  };

  async list(lens: Filter, _size: Size, max = 50): Promise<Task[]> {
    const me = lens === "mine" ? await this.deps.identity() : null;
    // Without an identity there is no honest "mine". Returning everything would
    // silently show the whole team's board under a tab labelled Mine.
    if (lens === "mine" && !me) return [];

    const schema = await this.deps.schema();
    const soql = buildListQuery(schema, lens, {
      team: this.deps.team,
      meId: me?.id ?? "",
      meName: me?.displayName ?? "",
      max,
    });

    const records = await this.deps.cli.query<SfRecord>(soql);
    this.deps.rememberIds(records.map((r) => [keyOf(r), idOf(r)] as [string, string]));
    return records.map((r) => toTask(r, schema, this.deps.instanceUrl));
  }

  async detail(key: string): Promise<TaskDetail> {
    const schema = await this.deps.schema();
    const [rec] = await this.deps.cli.query<SfRecord>(buildDetailQuery(schema, key));
    // Throwing is right here: the user just opened this card, and the host turns
    // a thrown seam error into a toast. `status()` is the one that must not throw.
    if (!rec) throw new Error(`Couldn't find ${key} in Agile Accelerator.`);
    this.deps.rememberIds([[keyOf(rec), idOf(rec)]]);
    return toDetail(rec, schema, this.deps.instanceUrl);
  }

  /** Delegated to the connector, which batches many keys into one query. */
  status(key: string): Promise<{ status: string | null; category: string | null }> {
    return this.deps.statusOf(key);
  }

  /** Read-only: nowhere to go. The seam treats an empty array as a fully
   *  supported answer — `changeStatus` shows an info toast, not an error. */
  async statusTargets(_key: string): Promise<StatusTarget[]> {
    return [];
  }

  async moveTo(
    _key: string,
    _targetId: string,
    _values: Record<string, string | string[]>,
  ): Promise<void> {
    throw new TaskWriteError("Agile Accelerator is read-only in this version of Agent Flow.", []);
  }

  /** Accepted and ignored, exactly as the fixture connector does. There is no
   *  capability flag to opt out of this one. */
  async assignToMe(_key: string, _meId?: string): Promise<void> {
    /* accepted */
  }

  me(): Promise<{ id: string; displayName: string } | null> {
    return this.deps.identity();
  }
}
