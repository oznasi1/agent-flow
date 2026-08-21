/** A model id as a card reads it: `claude-opus-5` → `opus-5`,
 * `claude-3-5-haiku-20241022` → `3-5-haiku`. Strips the vendor prefix and a trailing
 * build date and NOTHING else — an id from a vendor we do not know renders verbatim,
 * because a half-trimmed name reads like a different model, which is worse than a long
 * one. Eight digits, not "trailing numbers": `haiku-4-5` ends in a version.
 *
 * Accepts a nullish model and returns "" rather than throwing: `AgentActivity.model` is
 * `string | null | undefined` by contract, and AgentsRow's render guard is what keeps an
 * absent model from showing an empty span, not this function. But that guard lives one
 * call away and could be weakened without anyone touching this file — a component that
 * throws during render takes out every row in the drawer, not just the one with nothing
 * to show, so this stays tolerant as defence in depth. */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return "";
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
