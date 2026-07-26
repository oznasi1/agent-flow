// Command-palette style fuzzy matching. Pure and dependency-free — it must never
// import "vscode" or "fs" — so the webview and the unit tests share one scorer.

/** Anything that isn't alphanumeric ends a word, so the next char starts one. */
const BOUNDARY = /[^a-z0-9]/;

/**
 * Score `needle` against `hay` as a subsequence: every needle character must
 * appear in `hay`, in order, but not adjacently. Matches that head the field,
 * head a word, run contiguously, or cover the needle as a whole substring score
 * above scattered ones, and a long skip before a character costs a little.
 *
 * Returns `null` when `hay` doesn't contain the subsequence at all; an empty
 * needle matches everything with score 0. Scores are only ever compared with one
 * another, so the absolute values carry no meaning and may go negative.
 */
export function fuzzyScore(needle: string, hay: string): number | null {
  const n = needle.toLowerCase();
  if (!n) return 0;
  const h = hay.toLowerCase();
  let score = 0;
  let from = 0; // first index still available to match
  let prev = -2; // index the previous needle char landed on
  for (const ch of n) {
    const at = h.indexOf(ch, from);
    if (at === -1) return null;
    let bonus = 1;
    if (at === prev + 1) bonus += 8; // continues an unbroken run
    else if (at === 0) bonus += 12; // heads the field
    else if (BOUNDARY.test(h[at - 1])) bonus += 7; // heads a word
    else if (hay[at] !== h[at] && hay[at - 1] === h[at - 1]) bonus += 4; // camelHump
    score += bonus - Math.min(at - from, 6);
    prev = at;
    from = at + 1;
  }
  return h.includes(n) ? score + 15 : score;
}

/**
 * Score a literal, case-insensitive occurrence of `needle` in `hay`, favouring
 * early and word-aligned hits. Returns `null` when it doesn't occur.
 *
 * Free text is matched literally on purpose: a short needle is a subsequence of
 * almost any sentence, so fuzzy-matching prose returns nearly the whole corpus
 * and stops being a filter. Keep `fuzzyScore` for names and other identifiers.
 */
export function phraseScore(needle: string, hay: string): number | null {
  const n = needle.toLowerCase();
  if (!n) return 0;
  const h = hay.toLowerCase();
  const at = h.indexOf(n);
  if (at === -1) return null;
  const aligned = at === 0 || BOUNDARY.test(h[at - 1]);
  return 10 + (aligned ? 5 : 0) - Math.min(at, 20) / 5;
}
