/**
 * The bridge between local repo names and a Jira project's Components field.
 *
 * A chip on a task card is a local repo name. Jira only accepts a component the
 * project already defines, spelled the way the project spells it. These two
 * helpers translate between the pair, folding case and surrounding whitespace —
 * the same rule `inferServices` matches with, so a repo that produced a chip from
 * a component can always be written back to that component.
 */

/** The project's canonical name for a repo, or null when it defines no component
 *  by that name — which is also the answer for a blank repo name. Two components
 *  folding to the same key is a project misconfiguration invisible from the card,
 *  so the first one wins rather than the write failing. */
export function resolveComponent(repoName: string, projectComponents: string[]): string | null {
  const want = fold(repoName);
  if (!want) return null;
  for (const component of projectComponents) {
    if (fold(component) === want) return component;
  }
  return null;
}

/** `resolveComponent` across a set of repos, keyed by each repo's own spelling —
 *  the form the webview needs to classify a chip without a round trip. Repos with
 *  no component are absent, so a present key means "this one can be synced". */
export function mapRepoComponents(
  repoNames: string[],
  projectComponents: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of repoNames) {
    const component = resolveComponent(name, projectComponents);
    if (component) out[name] = component;
  }
  return out;
}

function fold(s: string): string {
  return s.trim().toLowerCase();
}
