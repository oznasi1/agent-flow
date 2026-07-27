/** A non-2xx response from Jira. Keeps the error envelope intact so callers can
 *  react to the failing fields structurally instead of matching on prose — the
 *  transition flow uses `fieldErrors` to decide what to re-prompt for. */
export class JiraApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly fieldErrors: Record<string, string>,
    readonly messages: string[],
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

/** Read Jira's standard error envelope. Anything else — HTML error pages, proxy
 *  text, empty bodies — becomes a status sentence rather than a raw dump, which
 *  is what used to reach the panel verbatim. */
export function parseJiraError(status: number, body: string): JiraApiError {
  const messages: string[] = [];
  const fieldErrors: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      const envelope = parsed as { errorMessages?: unknown; errors?: unknown };
      if (Array.isArray(envelope.errorMessages)) {
        for (const m of envelope.errorMessages) {
          if (typeof m === "string" && m.trim()) messages.push(m.trim());
        }
      }
      if (envelope.errors && typeof envelope.errors === "object") {
        for (const [id, msg] of Object.entries(envelope.errors as Record<string, unknown>)) {
          if (typeof msg === "string" && msg.trim()) fieldErrors[id] = msg.trim();
        }
      }
    }
  } catch {
    /* not JSON — the status sentence below is the whole message */
  }
  return new JiraApiError(status, render(status, messages, fieldErrors), fieldErrors, messages);
}

/** Re-render an error with human field names (the transition flow knows them
 *  from the transition metadata; the client that threw does not). */
export function describeJiraError(e: JiraApiError, fieldNames: Record<string, string> = {}): string {
  return render(e.status, e.messages, e.fieldErrors, fieldNames);
}

function render(
  status: number,
  messages: string[],
  fieldErrors: Record<string, string>,
  fieldNames: Record<string, string> = {},
): string {
  const parts = messages.map(sentence);
  for (const [id, msg] of Object.entries(fieldErrors)) {
    parts.push(`${fieldNames[id] ?? id}: ${sentence(msg)}`);
  }
  return parts.length ? parts.join(" ") : statusSentence(status);
}

/** Fragments are joined into one line, so each needs to end like a sentence. */
function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function statusSentence(status: number): string {
  if (status === 404) return "Jira couldn't find that issue (404).";
  if (status === 429) return "Jira is rate-limiting requests (429) — try again shortly.";
  if (status >= 500) return `Jira is having trouble (${status}) — try again shortly.`;
  if (status >= 400) return `Jira rejected the request (${status}).`;
  return `Jira returned an error (${status}).`;
}
