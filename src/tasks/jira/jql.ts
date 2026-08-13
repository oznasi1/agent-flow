import { Filter, Size } from "../../types";

const ORDER = "ORDER BY priority DESC, updated DESC";

/** Size buckets by original time estimate (Jira JQL time units). */
function sizeClause(size: Size): string {
  switch (size) {
    case "s": return 'originalEstimate <= "4h"';
    case "m": return '(originalEstimate > "4h" AND originalEstimate <= "2d")';
    case "l": return 'originalEstimate > "2d"';
    default: return "";
  }
}

/** Build the JQL for a project + filter lens + size. Pure (no vscode) so it's unit-testable. */
export function buildJql(project: string, filter: Filter, size: Size = "any"): string {
  const P = project;
  let where: string;
  switch (filter) {
    case "unassigned":
      where = `project = ${P} AND sprint in openSprints() AND statusCategory != Done AND assignee IS EMPTY`;
      break;
    case "mine":
      where = `project = ${P} AND statusCategory != Done AND assignee = currentUser()`;
      break;
    case "mysprint":
      where = `project = ${P} AND sprint in openSprints() AND assignee = currentUser() AND statusCategory != Done`;
      break;
    case "backlog":
      where = `project = ${P} AND (sprint IS EMPTY OR sprint NOT IN openSprints()) AND statusCategory != Done`;
      break;
    case "sprint":
      where = `project = ${P} AND sprint in openSprints() AND statusCategory != Done`;
      break;
    case "all":
    default:
      where = `project = ${P} AND statusCategory != Done`;
      break;
  }
  const sz = sizeClause(size);
  return `${where}${sz ? ` AND ${sz}` : ""} ${ORDER}`;
}

/** Drop the priority term from the sort — fallback for a project where `priority` is
 * hidden, unavailable or unindexed, which makes Jira reject the whole query rather
 * than ignore the sort. Keeps `updated DESC` so the result is still newest-first
 * rather than arbitrary. Touches only the ORDER BY, never the WHERE, and leaves a
 * query that never sorted by priority exactly as it was. */
export function stripPriorityOrder(jql: string): string {
  return jql.replace(/ORDER BY priority DESC,\s*/i, "ORDER BY ");
}

/** Strip sprint clauses — fallback for projects without a sprint board. */
export function stripSprint(jql: string): string {
  return jql
    .replace(/\s*AND\s+sprint in openSprints\(\)/i, "")
    .replace(/\s*AND\s+\(sprint IS EMPTY OR sprint NOT IN openSprints\(\)\)/i, "")
    .replace(/\s*sprint in openSprints\(\)\s*AND\s*/i, "");
}
