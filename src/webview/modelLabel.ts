/** A model id as a card reads it: `claude-opus-5` → `opus-5`,
 * `claude-3-5-haiku-20241022` → `3-5-haiku`. Strips the vendor prefix and a trailing
 * build date and NOTHING else — an id from a vendor we do not know renders verbatim,
 * because a half-trimmed name reads like a different model, which is worse than a long
 * one. Eight digits, not "trailing numbers": `haiku-4-5` ends in a version. */
export function modelLabel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}
