// src/tasks/agileAccelerator/soql.ts
// Pure, like jira/jql.ts, so the whole query surface is unit-testable without a
// process. Every field name here comes from the Schema, never from a literal —
// see describe.ts for why.
import type { Filter } from "../../types";
import { WANTED_FIELDS, type Schema } from "./describe";

const ORDER = "ORDER BY LastModifiedDate DESC";

/** Escape a value for a single-quoted SOQL string literal. `team` comes from
 *  user settings and both keys and names flow into WHERE clauses, so this is a
 *  correctness requirement, not a nicety. Backslashes first — otherwise the
 *  backslash this function adds to a quote gets escaped by its own second pass. */
export function soqlEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const lit = (v: string) => `'${soqlEscape(v)}'`;

export interface QueryOpts {
  team: string;
  meId: string;
  meName: string;
  max: number;
}

/** The related-record path for a `__c` lookup field: `agf__Assignee__c` becomes
 *  `agf__Assignee__r.Name`. One helper, used by the SELECT and both WHERE
 *  builders, so the three cannot disagree about the spelling. */
function relatedName(wireField: string): string {
  return `${wireField.replace(/__c$/, "__r")}.Name`;
}

/** Id and Name are standard and always exist; everything else is filtered
 *  through the schema so an absent field is simply not asked for. */
function selectList(schema: Schema): string {
  const optional = schema.selectable(WANTED_FIELDS);
  // Assignee is a lookup: select the readable name alongside the raw id.
  const extras = schema.has("Assignee__c") ? [relatedName(schema.field("Assignee__c"))] : [];
  return ["Id", "Name", "LastModifiedDate", ...optional, ...extras].join(", ");
}

/** The team lives on a lookup, so filter on its related Name rather than its id —
 *  the setting holds a human team name. Dropped entirely when the org has no
 *  team field, which yields a broader but still LIMIT-capped board instead of a
 *  failed query. */
function teamClause(schema: Schema, team: string): string | null {
  if (!schema.teamField || !team.trim()) return null;
  return `${relatedName(schema.teamField)} = ${lit(team.trim())}`;
}

function assigneeClause(schema: Schema, lens: Filter, opts: QueryOpts): string | null {
  if (!schema.has("Assignee__c")) return null;
  const f = schema.field("Assignee__c");
  if (lens === "unassigned") return `${f} = null`;
  if (lens !== "mine") return null;
  if (opts.meId) return `${f} = ${lit(opts.meId)}`;
  // No usable id: match on the readable name instead. The provider refuses to
  // run `mine` at all when neither is available, so this is never unfiltered.
  return opts.meName ? `${relatedName(f)} = ${lit(opts.meName)}` : null;
}

export function buildListQuery(schema: Schema, lens: Filter, opts: QueryOpts): string {
  const where = [teamClause(schema, opts.team), assigneeClause(schema, lens, opts)].filter(
    (c): c is string => c !== null,
  );
  const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  return `SELECT ${selectList(schema)} FROM ${schema.object}${clause} ${ORDER} LIMIT ${opts.max}`;
}

export function buildDetailQuery(schema: Schema, key: string): string {
  return `SELECT ${selectList(schema)} FROM ${schema.object} WHERE Name = ${lit(key)} LIMIT 1`;
}

/** One query for many keys — the reason `status()` can be polled per card
 *  without one process spawn per card. */
export function buildStatusQuery(schema: Schema, keys: readonly string[]): string {
  const inList = keys.map(lit).join(",");
  const status = schema.has("Status__c") ? `, ${schema.field("Status__c")}` : "";
  return `SELECT Id, Name${status} FROM ${schema.object} WHERE Name IN (${inList}) LIMIT ${keys.length}`;
}
