import { ServiceRef } from "../types";

export interface InferSource {
  summary: string;
  descriptionText?: string;
  labels: string[];
  components: string[];
}

export interface InferResult {
  service: ServiceRef;
  reason: "component" | "label" | "text";
}

/**
 * Infer which local repos a ticket touches, in priority order:
 *   1. components  — a Jira component whose name matches a repo (highest signal)
 *   2. labels      — a label matching a repo
 *   3. text        — a repo name appearing as a whole word in summary/description
 *
 * Matching is against the repo names actually checked out (the source of truth
 * for what can be opened). Returns de-duped results, best reason kept.
 */
export function inferServices(src: InferSource, repos: ServiceRef[]): InferResult[] {
  const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));
  const found = new Map<string, InferResult>();

  const add = (repo: ServiceRef, reason: InferResult["reason"]) => {
    if (!found.has(repo.name)) found.set(repo.name, { service: repo, reason });
  };

  const matchField = (values: string[], reason: InferResult["reason"]) => {
    for (const v of values) {
      const repo = byName.get(v.trim().toLowerCase());
      if (repo) add(repo, reason);
    }
  };

  // 1 + 2 — exact matches from structured fields
  matchField(src.components, "component");
  matchField(src.labels, "label");

  // 3 — whole-word repo-name mentions in free text
  const text = `${src.summary} ${src.descriptionText ?? ""}`.toLowerCase();
  for (const repo of repos) {
    if (found.has(repo.name)) continue;
    const name = repo.name.toLowerCase();
    // Only consider repo names that are specific enough to avoid false hits.
    if (name.length < 5) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegex(name)}([^a-z0-9]|$)`, "i");
    if (re.test(text)) add(repo, "text");
  }

  return [...found.values()];
}

/**
 * The inferred repos that may attach to a task without the user's say-so: only
 * matches the ticket itself records (components) count as confirmed. Label and
 * text matches are guesses — kept solely as a fallback when the ticket confirms
 * nothing at all, because a guess still beats an empty default there (and it is
 * all a source without components can ever offer).
 */
export function confirmedServices(results: InferResult[]): InferResult[] {
  const confirmed = results.filter((r) => r.reason === "component");
  return confirmed.length ? confirmed : results;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
