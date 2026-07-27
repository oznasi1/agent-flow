/** One field on a transition screen, as Jira describes it under
 *  `GET /transitions?expand=transitions.fields`. */
export interface TransitionFieldMeta {
  required?: boolean;
  name?: string;
  hasDefaultValue?: boolean;
  schema?: { type?: string; system?: string; custom?: string; items?: string };
  allowedValues?: { id?: string; name?: string; value?: string }[];
}

/** What we can ask a user for, and how. Anything Jira declares that doesn't map
 *  to one of these is skipped — see `promptableFields`. */
export type FieldPrompt =
  | { kind: "pick" | "multipick"; id: string; name: string; choices: { id?: string; name: string }[] }
  | { kind: "text" | "number" | "date" | "datetime" | "labels"; id: string; name: string };

/** Split a transition's fields into the prompts we can run and the display names
 *  we had to skip. Without `only`, considers required fields; with it, considers
 *  exactly those ids — the recovery path re-prompts fields Jira rejected even
 *  when the screen metadata never marked them required. */
export function promptableFields(
  fields: Record<string, TransitionFieldMeta>,
  opts: { only?: string[] } = {},
): { prompts: FieldPrompt[]; skipped: string[] } {
  const ids = opts.only
    ? opts.only.filter((id) => id in fields)
    : Object.keys(fields).filter((id) => fields[id]?.required === true);
  const prompts: FieldPrompt[] = [];
  const skipped: string[] = [];
  for (const id of ids) {
    const meta = fields[id] ?? {};
    const prompt = classify(id, meta);
    if (prompt) prompts.push(prompt);
    else skipped.push(meta.name ?? id);
  }
  return { prompts, skipped };
}

function classify(id: string, meta: TransitionFieldMeta): FieldPrompt | null {
  const name = meta.name ?? id;
  const type = meta.schema?.type ?? "";
  // API v3 wants ADF for rich text; a plain string would just earn a second
  // rejection, so treat these as unfillable rather than guessing.
  if (isRichText(meta)) return null;
  if (Array.isArray(meta.allowedValues) && meta.allowedValues.length) {
    const choices = meta.allowedValues
      .map((v) => ({ id: v.id, name: v.name ?? v.value ?? v.id ?? "" }))
      .filter((c) => c.name);
    if (!choices.length) return null;
    return { kind: type === "array" ? "multipick" : "pick", id, name, choices };
  }
  if (type === "array" && meta.schema?.items === "string") return { kind: "labels", id, name };
  if (type === "string") return { kind: "text", id, name };
  if (type === "number") return { kind: "number", id, name };
  if (type === "date") return { kind: "date", id, name };
  if (type === "datetime") return { kind: "datetime", id, name };
  return null;
}

function isRichText(meta: TransitionFieldMeta): boolean {
  const system = meta.schema?.system;
  return system === "description" || system === "environment" || (meta.schema?.custom ?? "").endsWith(":textarea");
}

/** Convert a prompt answer into the JSON shape Jira's transition body expects. */
export function toJiraValue(prompt: FieldPrompt, input: string | string[]): unknown {
  switch (prompt.kind) {
    case "pick":
      return reference(prompt.choices, String(input));
    case "multipick":
      return (Array.isArray(input) ? input : [input]).map((n) => reference(prompt.choices, n));
    case "labels":
      return (Array.isArray(input) ? input : String(input).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    case "number":
      return Number(String(input).trim());
    case "datetime":
      return `${String(input).trim()}T00:00:00.000+0000`;
    case "date":
    case "text":
    default:
      return String(input).trim();
  }
}

/** Prefer the id — it's stable across renames. Fall back to the literal value
 *  for the rare allowedValues entry that ships without one. */
function reference(choices: { id?: string; name: string }[], name: string): { id: string } | { value: string } {
  const hit = choices.find((c) => c.name === name);
  return hit?.id ? { id: hit.id } : { value: name };
}

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

/** Which fields a rejection is pointing at. Explicit `errors` keys win; failing
 *  that, we match field names inside the free-text messages, which is all a
 *  custom workflow validator gives us. */
export function missingFieldIds(
  fields: Record<string, TransitionFieldMeta>,
  err: { fieldErrors: Record<string, string>; messages: string[] },
): string[] {
  const explicit = Object.keys(err.fieldErrors).filter((id) => id in fields);
  if (explicit.length) return explicit;
  const haystack = err.messages.join(" ").toLowerCase();
  if (!haystack) return [];
  return Object.entries(fields)
    .filter(([, meta]) => {
      const name = (meta.name ?? "").toLowerCase();
      // Two characters or fewer matches almost any sentence by accident.
      return name.length > 2 && haystack.includes(name);
    })
    .map(([id]) => id);
}

/** True when the rejection blames Resolution — the one field common enough to
 *  be worth fetching the site-wide list for when screen metadata has nothing. */
export function mentionsResolution(err: { fieldErrors: Record<string, string>; messages: string[] }): boolean {
  return (
    err.messages.some((m) => /resolution/i.test(m)) ||
    Object.keys(err.fieldErrors).some((k) => /resolution/i.test(k))
  );
}

/** id → display name, for rendering field errors in something a human recognises. */
export function fieldDisplayNames(fields: Record<string, TransitionFieldMeta>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, meta] of Object.entries(fields)) if (meta?.name) out[id] = meta.name;
  return out;
}
