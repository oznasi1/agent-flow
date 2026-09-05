// Per-command consent: the record behind `agentFlow.commandConsent: "command"`.
//
// The released gate is two timestamps per flow — approve one `deploy.sh` and
// every command node in that flow, including ones added afterwards, runs
// unattended from then on. That is proportionate for a flow drawn once by hand;
// it is not for a template attached to twenty cards, each instance asking once
// and then spending freely. This module keys the approval to the RESOLVED
// COMMAND TEXT instead — the string the modal shows and `neverAutoRun` matches
// — and lets an approval be for one run, the next few, or always.
//
// Pure over a `Flow`, like `model.ts`, and with no imports beyond it: the host
// reads and writes the record, the drawer may one day show it. `Flow.
// commandConfirmedAt` is never read or written here; the default `"flow"` mode
// keeps using it untouched, which is what lets this ship inert.
import { CommandConsent, Flow } from "./model";

/** How many runs "Run the next N" approves. Five: enough to get a shape through
 * a day's worth of merges without re-asking, few enough that a mis-wired
 * template cannot spend all week on one click. */
export const CONSENT_BATCH = 5;

/** Is running `text` covered by an approval this flow already holds? A record
 * with no `remaining` covers every run; one with `remaining > 0` covers the next
 * `remaining`; a spent record (`0`) or none at all does not, and the flow asks. */
export function consentCovers(flow: Flow, text: string): CommandConsent | undefined {
  const c = flow.commandConsents?.[text];
  if (!c || typeof c !== "object" || typeof c.at !== "number") return undefined;
  if (c.remaining === undefined) return c;
  return typeof c.remaining === "number" && c.remaining > 0 ? c : undefined;
}

/** Record an approval for `text`: `remaining` runs, or every run when it is
 * omitted. Replaces any earlier record for the same text — a fresh answer is
 * the user's current decision, not an increment on an old one. */
export function grantConsent(flow: Flow, text: string, at: number, remaining?: number): Flow {
  const record: CommandConsent = remaining === undefined ? { at } : { at, remaining };
  return { ...flow, commandConsents: { ...(flow.commandConsents ?? {}), [text]: record } };
}

/** One run of `text` happened: count it against a bounded approval. An
 * unbounded one ("always") is untouched, and so is a flow with no record — the
 * run was authorised some other way (the `"flow"` mode's stamp), and inventing
 * a record for it would be inventing consent. Never below zero. */
export function consumeConsent(flow: Flow, text: string): Flow {
  const c = flow.commandConsents?.[text];
  if (!c || typeof c.remaining !== "number") return flow;
  return {
    ...flow,
    commandConsents: { ...flow.commandConsents, [text]: { ...c, remaining: Math.max(0, c.remaining - 1) } },
  };
}
