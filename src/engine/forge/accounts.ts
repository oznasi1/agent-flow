// What the footer legend says about the forge's identity, and how the one CLI
// that can answer is parsed. Pure: no spawn, no filesystem, no `vscode`.
//
// Split out of `github.ts` so both halves are testable without a Runner, and so
// `deckView.ts` can reduce the wire slot without reaching into a provider.
import type { AccountSlot } from "../../types";
import type { ForgeAccount, ForgeGap } from "./types";

/**
 * Parse `gh auth status --json hosts` for one host.
 *
 * Structured output rather than the human-readable report, whose wording has
 * changed across gh releases. Note that `--json` also changes the exit code: gh
 * exits 1 when any account has an auth problem, but exits 0 with `--json`
 * "unless there is a fatal error" — so a caller must not treat a clean exit as
 * proof every account is usable. That is what the `state` filter below is for.
 *
 * Total by construction: every malformed shape returns `[]`, because an empty
 * list already means "cannot answer" everywhere it is consumed, and a throw
 * here would take a whole refresh pass down with it.
 *
 * Only `state: "success"` entries survive. An account whose token has gone bad
 * is not a switch target — and if the ACTIVE account is the bad one, `probe()`
 * already reports `signed-out`, and `accountSlot` hands the footer slot to that
 * warning instead.
 *
 * One host, never merged: a GitHub Enterprise host sitting in the same gh
 * config belongs to a different forge instance, and folding its accounts in
 * here would offer the user a switch that changes nothing they can see.
 */
export function parseGhAccounts(stdout: string, host: string): ForgeAccount[] {
  let root: unknown;
  try {
    root = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof root !== "object" || root === null) return [];
  const hosts = (root as { hosts?: unknown }).hosts;
  if (typeof hosts !== "object" || hosts === null) return [];
  const list = (hosts as Record<string, unknown>)[host];
  if (!Array.isArray(list)) return [];
  const out: ForgeAccount[] = [];
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as { login?: unknown; active?: unknown; state?: unknown; scopes?: unknown };
    if (e.state !== "success") continue;
    if (typeof e.login !== "string" || e.login === "") continue;
    out.push({
      login: e.login,
      active: e.active === true,
      scopes: typeof e.scopes === "string" ? e.scopes : "",
    });
  }
  return out;
}

export interface AccountSlotInput {
  accounts: readonly ForgeAccount[];
  /** `undefined` = the forge probe has not resolved yet; `null` = healthy. */
  gap: ForgeGap | null | undefined;
  prFacts: boolean;
  capsAccounts: boolean;
  /** The forge's own CLI name, never a literal — see `FORGE_NOTES`. */
  cli: string;
}

/**
 * What the legend's shared slot should say, or null to say nothing.
 *
 * The slot is shared with `ghNote`, which owns it whenever the forge is missing
 * or signed out — a forge in either state has no account to name, so the two can
 * never both want it. This function is the single place that rule lives; the
 * webview renders whichever of the two it is handed.
 *
 * Silent below two accounts, deliberately. Naming the only account a user has
 * tells them nothing they can act on, and putting a new line in front of every
 * single-account user is exactly what the decision to ship this without a
 * default-off setting depends on not doing.
 */
export function accountSlot(i: AccountSlotInput): AccountSlot | null {
  // Nothing is reading the forge, so its identity describes an unused connection.
  if (!i.prFacts) return null;
  if (!i.capsAccounts) return null;
  // `!== null` rather than a truthiness test: `undefined` means the probe has
  // not come back, which is not the same as healthy, and announcing an identity
  // we have not confirmed we can use would be a guess.
  if (i.gap !== null) return null;
  if (i.accounts.length < 2) return null;
  const active = i.accounts.find((a) => a.active);
  // A list with no active entry names no identity. Saying nothing beats guessing
  // at the first entry and labelling the board with an account it is not using.
  if (!active) return null;
  return { cli: i.cli, login: active.login, canSwitch: true };
}
