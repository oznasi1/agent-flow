// The seam's own prompt vocabulary: what a source may ask a user for while moving
// a task, and what counts as a valid answer. It lives here rather than under
// `src/tasks/jira/` because it is not Jira's — `StatusTarget.fields`
// (src/tasks/provider.ts) is declared in these terms for every connector, and the
// host renders them without knowing which source produced them. It only used to
// live in the Jira directory because that is where it was first written.
//
// Deliberately dependency-free, exactly like provider.ts: no `vscode`, no source.

/** What we can ask a user for, and how. Anything a source declares that doesn't
 *  map to one of these is skipped — see the Jira connector's `promptableFields`. */
export type FieldPrompt =
  | { kind: "pick" | "multipick"; id: string; name: string; choices: { id?: string; name: string }[] }
  | { kind: "text" | "number" | "date" | "datetime" | "labels"; id: string; name: string };

/** Message for an invalid entry, or undefined when it's acceptable. Wired to the
 *  InputBox so bad input never costs a round-trip. */
export function validateFieldInput(prompt: FieldPrompt, raw: string): string | undefined {
  const v = raw.trim();
  if (!v) return `${prompt.name} is required.`;
  if (prompt.kind === "number" && !Number.isFinite(Number(v))) return "Enter a number.";
  if ((prompt.kind === "date" || prompt.kind === "datetime") && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return "Use the format YYYY-MM-DD.";
  }
  return undefined;
}
