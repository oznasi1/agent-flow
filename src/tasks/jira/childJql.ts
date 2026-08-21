// Pure, and imports nothing — the same contract `jql.ts` keeps, so the candidate
// ladder can be asserted without a client, a site or an auth header.

/** A ticket key as a JQL string literal. Keys are `[A-Z][A-Z0-9_]*-\d+` in practice,
 *  but the value reaches us from a webview message and a stored run record, so the
 *  two characters that could end the literal early are removed rather than trusted. */
export function jqlKey(key: string): string {
  return key.replace(/["\\]/g, "");
}

/** Candidate JQL for "the children of `key`", most modern spelling first.
 *
 *  `parent` covers sub-tasks AND epic children on current Jira Cloud. `"Epic Link"`
 *  is the older company-managed spelling and covers epic children only. The caller
 *  takes the FIRST candidate that answers with a non-empty list — not merely the
 *  first that does not error — because on a site where `parent` is valid but models
 *  nothing, an empty answer is indistinguishable from "no children" and would hide a
 *  populated epic. */
export function childrenJql(key: string): string[] {
  const k = jqlKey(key);
  return [`parent = "${k}" ORDER BY key ASC`, `"Epic Link" = "${k}" ORDER BY key ASC`];
}
