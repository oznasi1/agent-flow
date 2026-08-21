// src/tasks/agileAccelerator/shape.ts
// Pure. Salesforce records in, seam types out.
import type { Task } from "../../types";
import type { TaskDetail } from "../provider";
import type { Schema } from "./describe";

export type SfRecord = Record<string, unknown>;

/** The object name in a Lightning record url is always unprefixed, even in an
 *  org where the object itself is namespaced. */
const URL_OBJECT = "ADM_Work__c";

/** Statuses that mean the work is over. Seeded from the closed set
 *  forcedotcom/git2gus itself uses (INTEGRATE, FIXED, CLOSED) plus the other
 *  terminal picklist values, and compared case-insensitively because picklist
 *  casing varies between orgs. */
const DONE = new Set(
  ["integrate", "fixed", "closed", "duplicate", "never going to happen", "not a bug", "not reproducible"],
);

/** Statuses that mean nobody has started. */
const NEW = new Set(["new", "triaged", "acknowledged", "more info reqd", "waiting", "backlog"]);

/** Total over an open-ended picklist. An UNRECOGNIZED status is `indeterminate`,
 *  never `done`: only `done` drives run retirement, so a wrong `done` would
 *  silently retire live work. Same reasoning as `StatusTarget.toCategory`'s
 *  `""` member in ../provider.ts. */
export function statusCategoryOf(status: string): "new" | "indeterminate" | "done" {
  const s = status.trim().toLowerCase();
  if (DONE.has(s)) return "done";
  if (NEW.has(s)) return "new";
  return "indeterminate";
}

export function recordUrl(instanceUrl: string, id: string): string {
  return `${instanceUrl.replace(/\/+$/, "")}/lightning/r/${URL_OBJECT}/${id}/view`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function idOf(rec: SfRecord): string {
  return str(rec.Id);
}

export function keyOf(rec: SfRecord): string {
  return str(rec.Name);
}

/** Read a related record's Name, e.g. `agf__Assignee__r.Name`. */
function relatedName(rec: SfRecord, lookupField: string): string {
  const rel = rec[lookupField.replace(/__c$/, "__r")];
  if (!rel || typeof rel !== "object") return "";
  return str((rel as SfRecord).Name);
}

function readStatus(rec: SfRecord, schema: Schema): string {
  return schema.has("Status__c") ? str(rec[schema.field("Status__c")]) : "";
}

/** Salesforce stamps `+0000`; Task.updated is specified as ISO. An unparseable
 *  value becomes an empty string rather than "Invalid Date". */
function isoOf(v: unknown): string {
  const raw = str(v);
  if (!raw) return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function toTask(rec: SfRecord, schema: Schema, instanceUrl: string): Task {
  const status = readStatus(rec, schema);
  const assignee = schema.has("Assignee__c") ? relatedName(rec, schema.field("Assignee__c")) : "";
  return {
    key: keyOf(rec),
    summary: schema.has("Subject__c") ? str(rec[schema.field("Subject__c")]) : "",
    status,
    statusCategory: statusCategoryOf(status),
    priority: schema.has("Priority__c") ? str(rec[schema.field("Priority__c")]) : "",
    assignee: assignee || "Unassigned",
    labels: [],
    components: [],
    // This source declares neither caps.sprints nor caps.sizes, so these are the
    // only honest values. `inOpenSprint` is a required boolean with no "no sprint
    // concept" member; every reader gates on caps.sprints first.
    sprint: null,
    inOpenSprint: false,
    updated: isoOf(rec.LastModifiedDate),
    url: recordUrl(instanceUrl, idOf(rec)),
    estimateSeconds: null,
  };
}

export function toDetail(rec: SfRecord, schema: Schema, instanceUrl: string): TaskDetail {
  const status = readStatus(rec, schema);
  return {
    key: keyOf(rec),
    summary: schema.has("Subject__c") ? str(rec[schema.field("Subject__c")]) : "",
    descriptionText: "",
    labels: [],
    components: [],
    url: recordUrl(instanceUrl, idOf(rec)),
    status: status || null,
    statusCategory: statusCategoryOf(status),
  };
}
