// src/tasks/agileAccelerator/describe.ts
// Pure. Takes a describe result as data so every branch is testable without a
// process. This module exists because a SOQL query naming a field that does not
// exist fails ENTIRELY (INVALID_FIELD) rather than degrading — so an unverified
// field name is a total-failure risk, and the field list has to be discovered.
import type { SfDescribeResult } from "./cli";

/** Tried in order. The managed package namespaces its objects; GUS, which is the
 *  same code line without the package wrapper, does not. */
export const WORK_OBJECT_CANDIDATES = ["agf__ADM_Work__c", "ADM_Work__c"] as const;

/** Logical (unprefixed) field names this connector would like. Only `Name` and
 *  `Id` are standard and always present; every entry here is optional as far as
 *  the connector is concerned, and an absent one simply is not selected.
 *  Verified against forcedotcom/git2gus: Subject__c, Status__c, Assignee__c. The
 *  rest are plausible-but-unverified, which is exactly why they go through
 *  `selectable()`. */
export const WANTED_FIELDS = [
  "Subject__c",
  "Status__c",
  "Assignee__c",
  "Priority__c",
  "Product_Tag__c",
] as const;

/** The scope field, whose real API name we could not verify. First match wins. */
export const TEAM_FIELD_CANDIDATES = ["Scrum_Team__c", "Team__c"] as const;

export interface Schema {
  /** The object name that actually resolved, e.g. `agf__ADM_Work__c`. */
  readonly object: string;
  /** `"agf__"` or `""`. */
  readonly prefix: string;
  /** Does this org have the given logical field? */
  has(logical: string): boolean;
  /** The wire name for a logical field, whether or not it exists. */
  field(logical: string): string;
  /** The resolved team field's wire name, or null when the org has none. */
  readonly teamField: string | null;
  /** Wire names for those logical fields that exist, in the order given. */
  selectable(logical: readonly string[]): string[];
}

/** Everything before the object's own name is the namespace. */
export function prefixOf(object: string): string {
  const i = object.lastIndexOf("__");
  const head = object.slice(0, Math.max(i, 0));
  const cut = head.indexOf("__");
  return cut < 0 ? "" : object.slice(0, cut + 2);
}

export function buildSchema(object: string, d: SfDescribeResult): Schema {
  const prefix = prefixOf(object);
  const present = new Set(d.fields.map((f) => f.name));
  const field = (logical: string) => `${prefix}${logical}`;
  const has = (logical: string) => present.has(field(logical));

  return {
    object,
    prefix,
    has,
    field,
    teamField: TEAM_FIELD_CANDIDATES.map(field).find((f) => present.has(f)) ?? null,
    selectable: (logical) => logical.filter(has).map(field),
  };
}
