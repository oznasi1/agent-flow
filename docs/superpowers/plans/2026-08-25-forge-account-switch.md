# Forge Account Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show which account the forge's CLI is authenticated as in the Deck's footer legend, and let the user switch between accounts from there.

**Architecture:** A new `accounts` capability on the `Forge` seam, implemented by `github.ts` off `gh auth status --json hosts` and refused by `gitlab.ts`. All parsing and all display logic live in one pure leaf module (`src/engine/forge/accounts.ts`) so they are testable without spawning anything. The host reduces the account list to a small wire object before it crosses to the webview, exactly as `ghNote` already does, which keeps `child_process` off every browser bundle's import graph. Switching runs through a VS Code QuickPick plus a modal confirmation, then invalidates every cached forge answer.

**Tech Stack:** TypeScript, React (webview), Vitest, esbuild. `vscode` is aliased to the hand-written mock at `test/_mocks/vscode.ts`.

**Spec:** [docs/superpowers/specs/2026-08-25-forge-account-switch-design.md](../specs/2026-08-25-forge-account-switch-design.md) — read it before Task 1. The plan argues from the spec; both travel together.

## Global Constraints

Copied verbatim from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- **CI gate is exactly four commands, all must pass:** `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
- **`npm run build` is a real gate, not a formality.** `src/engine/forge/*` imports `child_process`. Any module reachable from a browser entry point (`src/webview/index.tsx`, `src/webview/deck.tsx`, `src/webview/marketplace.tsx`) that imports a Node builtin breaks the build **even if the code never runs** — esbuild resolves statically. `tsc` and the whole Vitest suite pass regardless. Never import anything from `src/engine/forge/` into `src/webview/`.
- **`npm test` is ~4,500 tests across 122 files and takes 2+ minutes.** It exceeds the default Bash tool timeout and auto-backgrounds at 120s — pass `timeout: 600000`. **Never pipe vitest through `tail` or `head`**: it loses the failure list. A single failure under CPU contention is usually flake — re-run that file alone before believing it.
- **The existing suite must pass UNMODIFIED.** A test you had to edit to go green is the signal to **stop** and report, not to proceed. This is why `ghAccount` is an optional wire field (Task 3).
- **Coverage thresholds are enforced** by `npm run test:cov`: 90% lines, 90% statements, 85% branches, 85% functions (`vitest.config.ts`).
- **No hardcoded organization values.** No literal `"gh"` in the webview, no site, project key, or account name anywhere.
- **Vocabulary.** A *session* is one run of a coding tool; an *agent* is a worker a session delegates to. Identifiers keep their released spelling. `test/unit/vocabulary.test.ts` enforces this.
- **Docs.** `test/unit/docs.test.ts` asserts only that every id in `FORGE_IDS` appears in `docs/FORGES.md` in backticks — it does **not** diff the `Forge` interface block. (Corrected after Task 2: the earlier claim here was wrong.) This change registers no new forge, so that test passes with or without the docs edit. Update §1's interface block anyway — the spec requires it, and nothing else will catch it going stale.
- **Every user-facing change gets a `## [Unreleased]` entry** in `CHANGELOG.md` (Task 5).
- **Work in a git worktree.** `main` moves fast — several sessions land on it a day, and one is already live in this checkout. Re-check `main`'s HEAD before starting.

---

### Task 1: The pure module — parsing and the display rule

Everything that decides *what the legend says* lives here, with no I/O, so it is
tested without a spawn, a filesystem, or a rendered component.

**Files:**
- Create: `src/engine/forge/accounts.ts`
- Test: `test/unit/engine/forge/accounts.test.ts`

**Interfaces:**
- Consumes: `ForgeAccount` and `ForgeGap` from `./types` — `ForgeGap` exists today; **`ForgeAccount` does not yet and is created in Task 2.** To keep this task independently compilable, declare `ForgeAccount` in Task 2 *first* if you are executing strictly in order, or accept that `npm run typecheck` fails on this one import until Task 2 lands. Task 2's step 1 adds it.
- Produces: `parseGhAccounts(stdout: string, host: string): ForgeAccount[]` and `accountSlot(i: AccountSlotInput): AccountSlot | null`, plus the exported `AccountSlot` interface.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/engine/forge/accounts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { accountSlot, parseGhAccounts } from "../../../../src/engine/forge/accounts";
import type { ForgeAccount } from "../../../../src/engine/forge/types";

/** The real shape, captured from `gh auth status --json hosts` on gh 2.89.0. */
const REAL = JSON.stringify({
  hosts: {
    "github.com": [
      { state: "success", active: true, host: "github.com", login: "oznasi1",
        tokenSource: "keyring", scopes: "gist, read:org, repo, workflow", gitProtocol: "https" },
      { state: "success", active: false, host: "github.com", login: "OznasiAb",
        tokenSource: "keyring", scopes: "gist, read:org, repo", gitProtocol: "https" },
    ],
  },
});

describe("parseGhAccounts", () => {
  it("reads both accounts and which one is active", () => {
    expect(parseGhAccounts(REAL, "github.com")).toEqual([
      { login: "oznasi1", active: true, scopes: "gist, read:org, repo, workflow" },
      { login: "OznasiAb", active: false, scopes: "gist, read:org, repo" },
    ]);
  });

  // An account whose token has gone bad is not a switch target. If the ACTIVE
  // account is the bad one, probe() already reports signed-out and the footer
  // slot goes to that warning instead.
  it("drops an account whose state is not success", () => {
    const j = JSON.stringify({ hosts: { "github.com": [
      { state: "success", active: true, login: "good", scopes: "repo" },
      { state: "timeout", active: false, login: "bad", scopes: "repo" },
    ] } });
    expect(parseGhAccounts(j, "github.com").map((a) => a.login)).toEqual(["good"]);
  });

  it("returns [] for a host it was not asked about", () => {
    expect(parseGhAccounts(REAL, "ghe.internal")).toEqual([]);
  });

  it("defaults absent scopes to the empty string rather than undefined", () => {
    const j = JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, login: "x" }] } });
    expect(parseGhAccounts(j, "github.com")).toEqual([{ login: "x", active: true, scopes: "" }]);
  });

  it("skips an entry with no usable login", () => {
    const j = JSON.stringify({ hosts: { "github.com": [
      { state: "success", active: true, login: "", scopes: "" },
      { state: "success", active: false, login: 7, scopes: "" },
      { state: "success", active: false, login: "real", scopes: "" },
    ] } });
    expect(parseGhAccounts(j, "github.com").map((a) => a.login)).toEqual(["real"]);
  });

  // Total, never throwing: a throw here would take a whole refresh pass down,
  // and every malformed shape means the same thing — we cannot answer.
  it.each([
    ["unparseable bytes", "not json at all"],
    ["an empty string", ""],
    ["a JSON scalar", "42"],
    ["JSON null", "null"],
    ["no hosts key", '{"other":1}'],
    ["hosts as a scalar", '{"hosts":"nope"}'],
    ["the host mapping to a non-array", '{"hosts":{"github.com":{}}}'],
    ["a non-object entry", '{"hosts":{"github.com":[null,3,"x"]}}'],
  ])("returns [] for %s", (_label, raw) => {
    expect(parseGhAccounts(raw, "github.com")).toEqual([]);
  });
});

const acct = (login: string, active: boolean): ForgeAccount => ({ login, active, scopes: "repo" });
const base = { accounts: [acct("a", true), acct("b", false)], gap: null, prFacts: true, capsAccounts: true, cli: "gh" };

describe("accountSlot", () => {
  it("names the active account and offers the switch when there are two", () => {
    expect(accountSlot(base)).toEqual({ cli: "gh", login: "a", canSwitch: true });
  });

  // PR facts off means nothing is reading the forge at all, so naming its
  // identity would describe a connection that is not being used.
  it("says nothing when PR facts are off", () => {
    expect(accountSlot({ ...base, prFacts: false })).toBeNull();
  });

  it("says nothing for a forge that cannot enumerate accounts", () => {
    expect(accountSlot({ ...base, capsAccounts: false })).toBeNull();
  });

  // The warning and the identity share one slot, and a forge that is missing or
  // signed out has no account to name.
  it("yields the slot to a real forge gap", () => {
    expect(accountSlot({ ...base, gap: { kind: "signed-out", detail: "x" } })).toBeNull();
  });

  // undefined is "the probe has not resolved yet" — not the same as healthy.
  it("says nothing while the probe is still unresolved", () => {
    expect(accountSlot({ ...base, gap: undefined })).toBeNull();
  });

  // One account is not a choice, and new chrome for every single-account user
  // is exactly what shipping without a setting is meant to avoid.
  it("says nothing when there is only one account", () => {
    expect(accountSlot({ ...base, accounts: [acct("a", true)] })).toBeNull();
  });

  it("says nothing when there are no accounts at all", () => {
    expect(accountSlot({ ...base, accounts: [] })).toBeNull();
  });

  it("says nothing when no account is marked active", () => {
    expect(accountSlot({ ...base, accounts: [acct("a", false), acct("b", false)] })).toBeNull();
  });

  it("carries the forge's own CLI name rather than assuming gh", () => {
    expect(accountSlot({ ...base, cli: "hgcli" })?.cli).toBe("hgcli");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/forge/accounts.test.ts`
Expected: FAIL — `Failed to resolve import ".../src/engine/forge/accounts"`.

- [ ] **Step 3: Write the implementation**

Create `src/engine/forge/accounts.ts`:

```ts
// What the footer legend says about the forge's identity, and how the one CLI
// that can answer is parsed. Pure: no spawn, no filesystem, no `vscode`.
//
// Split out of `github.ts` so both halves are testable without a Runner, and so
// `deckView.ts` can reduce the wire slot without reaching into a provider.
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

/** The footer legend's account entry: which CLI, acting as whom. */
export interface AccountSlot {
  cli: string;
  login: string;
  canSwitch: boolean;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/forge/accounts.test.ts`
Expected: PASS, all tests.

Note: this will not typecheck until Task 2 adds `ForgeAccount` to `./types`. If you are running `npm run typecheck` between tasks, do Task 2 step 1 now.

- [ ] **Step 5: Mutation-check the tests before trusting them**

Plan-authored tests have been the defect source in this repo before. Prove each assertion can fail:

1. In `accountSlot`, change `i.accounts.length < 2` to `< 1`. Run the file. Expected: the "only one account" test FAILS.
2. Revert. Change `if (i.gap !== null)` to `if (i.gap)`. Run. Expected: the "probe still unresolved" test FAILS.
3. Revert. In `parseGhAccounts`, delete the `if (e.state !== "success") continue;` line. Run. Expected: the "state is not success" test FAILS.
4. Revert all three. Run the file. Expected: PASS.

If any mutation does **not** produce a failure, that test is vacuous — fix the test, not the implementation.

- [ ] **Step 6: Commit**

```bash
git add src/engine/forge/accounts.ts test/unit/engine/forge/accounts.test.ts
git commit -m "feat(forge): parse gh's account list, and decide what the legend says"
```

---

### Task 2: The seam — `ForgeAccount`, `caps.accounts`, and both implementations

**Files:**
- Modify: `src/engine/forge/types.ts`
- Modify: `src/engine/forge/github.ts`
- Modify: `src/engine/forge/gitlab.ts`
- Modify: `docs/FORGES.md` (the `Forge` interface block in §1)
- Test: `test/unit/engine/forge/seam.test.ts` (create)

**Interfaces:**
- Consumes: `parseGhAccounts` from Task 1; `Runner`, `execRunner`, `GH_TIMEOUT_MS` from `../pr/provider`; `resolveBin` from `../pr/which`.
- Produces: `ForgeAccount { login: string; active: boolean; scopes: string }`; `ForgeCaps.accounts: boolean`; `Forge.accounts(): Promise<ForgeAccount[]>`; `Forge.switchAccount(login: string): Promise<{ ok: true } | { ok: false; message: string }>`.

- [ ] **Step 1: Add the types**

In `src/engine/forge/types.ts`, add after the `ForgeGap` declaration:

```ts
/** One account the forge's CLI holds credentials for. `scopes` is display-only —
 *  it goes in the QuickPick's detail line so a user with two similar logins can
 *  tell them apart, and nothing branches on it. */
export interface ForgeAccount {
  login: string;
  active: boolean;
  scopes: string;
}
```

Add to `ForgeCaps`, inside the existing interface:

```ts
  /** Can this forge report which account its CLI acts as, and be told to change
   *  it? Both directions, one flag, for the same reason `changesRequested` is
   *  one flag: a CLI with no multi-account model can neither be asked nor told.
   *  `gh` can do both; `glab` holds one token per host and can do neither. */
  accounts: boolean;
```

Add to `Forge`, after `probe()`:

```ts
  /** Every account the CLI holds credentials for, the active one included.
   *  Resolves `[]` when the forge cannot answer — never a fabricated single
   *  entry, which would be indistinguishable from a user who genuinely has one
   *  account. Must not reject: callers treat it as total. */
  accounts(): Promise<ForgeAccount[]>;
  /** Make `login` the active account, machine-wide. A result object rather than
   *  a `ForgeGap`: a refused switch is not a gap in the forge's health —
   *  `probe()` owns that — and a third `ForgeGap` kind would oblige
   *  `FORGE_NOTES` to carry a footer string for a state no user can reach. The
   *  `{ ok }` shape mirrors `FetchResult` in `../pr/provider`. */
  switchAccount(login: string): Promise<{ ok: true } | { ok: false; message: string }>;
```

- [ ] **Step 2: Write the failing tests**

Create `test/unit/engine/forge/seam.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { resolveForge } from "../../../../src/engine/forge/registry";
import type { Runner } from "../../../../src/engine/pr/provider";

const REAL = JSON.stringify({
  hosts: { "github.com": [
    { state: "success", active: true, login: "oznasi1", scopes: "repo, workflow" },
    { state: "success", active: false, login: "OznasiAb", scopes: "repo" },
  ] },
});

/** A Runner that answers one argv and records every call. */
function runner(reply: (args: string[]) => string | Promise<string>) {
  const calls: string[][] = [];
  const run: Runner = async (_file, args) => { calls.push(args); return reply(args); };
  return { run, calls };
}

describe("the GitHub forge's account capability", () => {
  it("declares that it can enumerate and switch accounts", () => {
    expect(resolveForge("github", () => {}, runner(() => "").run).caps.accounts).toBe(true);
  });

  it("asks gh for structured output, not the human-readable report", async () => {
    const { run, calls } = runner(() => REAL);
    await resolveForge("github", () => {}, run).accounts();
    expect(calls[0]).toEqual(["auth", "status", "--json", "hosts"]);
  });

  it("returns the parsed accounts", async () => {
    const { run } = runner(() => REAL);
    expect(await resolveForge("github", () => {}, run).accounts()).toEqual([
      { login: "oznasi1", active: true, scopes: "repo, workflow" },
      { login: "OznasiAb", active: false, scopes: "repo" },
    ]);
  });

  // Total, not throwing: a rejection here would surface as an unhandled
  // rejection inside a refresh pass.
  it("resolves [] rather than rejecting when gh fails", async () => {
    const run: Runner = async () => { throw new Error("ENOENT"); };
    await expect(resolveForge("github", () => {}, run).accounts()).resolves.toEqual([]);
  });

  it("switches by long-form hostname and user flags", async () => {
    const { run, calls } = runner(() => "");
    expect(await resolveForge("github", () => {}, run).switchAccount("OznasiAb")).toEqual({ ok: true });
    expect(calls[0]).toEqual(["auth", "switch", "--hostname", "github.com", "--user", "OznasiAb"]);
  });

  it("reports a failed switch with gh's own complaint, and does not throw", async () => {
    const run: Runner = async () => { throw new Error("no such account"); };
    const res = await resolveForge("github", () => {}, run).switchAccount("nobody");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toContain("no such account");
  });
});

describe("the GitLab forge's account capability", () => {
  const never: Runner = async () => { throw new Error("no call expected"); };

  // glab stores one token per host and has no `auth switch`. Stated, not faked:
  // a single-entry list would read as "you have exactly one account".
  it("declares that it cannot", () => {
    expect(resolveForge("gitlab", () => {}, never).caps.accounts).toBe(false);
  });

  it("enumerates nothing, without spawning glab", async () => {
    expect(await resolveForge("gitlab", () => {}, never).accounts()).toEqual([]);
  });

  it("refuses to switch, and says why, without spawning glab", async () => {
    const res = await resolveForge("gitlab", () => {}, never).switchAccount("anyone");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.message).toMatch(/one token per host/i);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/unit/engine/forge/seam.test.ts`
Expected: FAIL — `accounts is not a function` on the GitHub cases.

- [ ] **Step 4: Implement on both forges**

In `src/engine/forge/github.ts`, add the `parseGhAccounts` import and a `GH_HOST` constant, change `caps`, and add the two members:

```ts
import { parseGhAccounts } from "./accounts";

/** The only host this forge speaks for. A GitHub Enterprise host in the same gh
 *  config belongs to a different forge instance — see `parseGhAccounts`. */
const GH_HOST = "github.com";
```

```ts
    caps: { changesRequested: true, accounts: true },
```

```ts
    async accounts() {
      try {
        const out = await run(resolveBin("gh") ?? "gh", ["auth", "status", "--json", "hosts"], {
          cwd: process.cwd(),
          timeoutMs: GH_TIMEOUT_MS,
        });
        return parseGhAccounts(out, GH_HOST);
      } catch {
        // Not installed, not signed in, timed out, or a shape this build does
        // not recognise: all the same answer, and it is "we cannot say".
        return [];
      }
    },
    async switchAccount(login) {
      try {
        await run(resolveBin("gh") ?? "gh", ["auth", "switch", "--hostname", GH_HOST, "--user", login], {
          cwd: process.cwd(),
          timeoutMs: GH_TIMEOUT_MS,
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    },
```

`process.cwd()` as the cwd matches `probeGh`: `gh auth` is machine state, not repo state, so there is no repo to run it in.

In `src/engine/forge/gitlab.ts`, change `caps` and add the two members:

```ts
    caps: { changesRequested: false, accounts: false },
```

```ts
    // glab stores one token per host in its config and has no `auth switch`.
    // Both members answer from here rather than spawning: there is nothing to
    // ask, and a fabricated single-entry list would be indistinguishable from a
    // user who genuinely has one account.
    async accounts() {
      return [];
    },
    async switchAccount() {
      return { ok: false, message: "glab holds one token per host and cannot switch accounts" };
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/unit/engine/forge/seam.test.ts test/unit/engine/forge/registry.test.ts`
Expected: PASS. `registry.test.ts` must pass **unmodified** — it asserts `caps.changesRequested` only, so a new `caps` field does not disturb it. If it fails, stop and report.

- [ ] **Step 6: Update the tested docs**

In `docs/FORGES.md` §1, replace the `Forge` interface code block with the current one — it must match `src/engine/forge/types.ts`:

```ts
export interface Forge {
  readonly id: string;
  readonly label: string;
  readonly cli: { name: string; installUrl: string };
  readonly caps: ForgeCaps;
  probe(): Promise<ForgeGap | null>;
  accounts(): Promise<ForgeAccount[]>;
  switchAccount(login: string): Promise<{ ok: true } | { ok: false; message: string }>;
  readonly prs: PrProvider;
  readonly reviews: ReviewProvider;
  branchCi(repoPath: string, branch: string): Promise<BranchCiStatus>;
}
```

In the paragraph below it, change "alongside `ForgeCaps` (what a forge can answer — today, just `changesRequested`)" to name both caps, and add a sentence for `ForgeAccount`:

```markdown
Declared in `src/engine/forge/types.ts`, alongside `ForgeCaps` (what a forge can
answer — `changesRequested`, and `accounts`: whether its CLI has a
multi-account model it can report and change), `ForgeAccount` (one such account:
`login`, `active`, `scopes`) and `ForgeGap` (why `probe()` came back unhappy:
`missing` or `signed-out`).
```

- [ ] **Step 7: Verify docs and types together**

Run: `npx vitest run test/unit/docs.test.ts && npm run typecheck`
Expected: both PASS.

- [ ] **Step 8: Commit**

```bash
git add src/engine/forge/types.ts src/engine/forge/github.ts src/engine/forge/gitlab.ts \
        docs/FORGES.md test/unit/engine/forge/seam.test.ts
git commit -m "feat(forge): add an accounts capability, implemented by gh and refused by glab"
```

---

### Task 3: The wire — host reduction and the two message shapes

**Files:**
- Modify: `src/types.ts` (the `deck:runs` member, and the inbound message union near line 611)
- Modify: `src/deckView.ts`
- Test: `test/unit/engine/forge/accounts.test.ts` (no change — the reduction is already covered by Task 1; this task's own coverage comes from Task 5's deckView tests)

**Interfaces:**
- Consumes: `accountSlot` and `AccountSlot` from Task 1; `Forge.accounts()` and `caps.accounts` from Task 2.
- Produces: the wire field `ghAccount?: AccountSlot | null` on `deck:runs`; the inbound message `{ type: "deck:switchAccount" }`; the private methods `startForgeAccountsRead()`, `dropForgeCaches()`, `reprobeForge()` on `DeckViewProvider` — the latter two consumed by Task 5.

- [ ] **Step 1: Add the wire types**

In `src/types.ts`, add to the `deck:runs` member:

```ts
  /** Which account the forge's CLI is reading as, when that is worth saying.
   *
   * OPTIONAL, and it must stay optional. `test/webview/DeckApp.test.tsx`'s
   * `runsMsg` helper builds this message as an object literal typed
   * `Extract<OutboundMessage, { type: "deck:runs" }>`; a required member stops
   * it compiling, and editing an existing test to go green is the signal to
   * stop. It is also what `agentLabel` already does, so that a message posted
   * before the host reloads carries no such field. */
  ghAccount?: AccountSlot | null;
```

Import the type at the top of `src/types.ts`:

```ts
import type { AccountSlot } from "./engine/forge/accounts";
```

**This import must be `import type`.** `src/types.ts` is reachable from every webview bundle. `accounts.ts` is pure today, but `import type` is erased at build time and so cannot ever add a runtime edge — the same reasoning `forge/types.ts` already documents for its own three imports.

Add to the inbound union, beside `{ type: "deck:clearStale" }`:

```ts
  | { type: "deck:switchAccount" }
```

- [ ] **Step 2: Add the account read to `deckView.ts`**

Add the imports:

```ts
import { accountSlot } from "./engine/forge/accounts";
import type { ForgeAccount } from "./engine/forge/types";
```

Add the fields beside `forgeProbe` / `forgeGap` (near line 349):

```ts
  /** The forge's account list, last time it answered. `[]` until it does. */
  private forgeAccounts: ForgeAccount[] = [];
  private accountsProbe: Promise<ForgeAccount[]> | null = null;
```

Add the reader, modelled on `forgeReady()` directly above it:

```ts
  /** Start the account read if it has not run, and never wait for it.
   *
   * Memoized and fire-and-forget for the same reason `forgeReady`'s probe is: a
   * CLI round trip must not sit in front of a paint. The first pass after the
   * panel opens therefore posts no account slot and the next one does, which is
   * the right trade — the slot is a label, not a blocker.
   */
  private startForgeAccountsRead(): void {
    if (!this.prFacts || !this.forge.caps.accounts) return;
    if (this.accountsProbe !== null) return;
    const p = (this.accountsProbe = this.forge.accounts());
    void p
      .then((list) => {
        // A read orphaned by a switch or a settings flip must not win if it
        // resolves after the fresh one already has — the same guard, and the
        // same reason, as the forge probe above.
        if (this.accountsProbe !== p) return;
        this.forgeAccounts = list;
      })
      // `accounts()` is documented total, so this should be unreachable. It is
      // here because an unhandled rejection inside a refresh is a silent, ugly
      // failure mode this file has been bitten by before.
      .catch(() => { /* nothing to say */ });
  }
```

- [ ] **Step 3: Post the slot**

In `refresh()`, immediately before `this.post({ type: "deck:runs", … })`, add:

```ts
      this.startForgeAccountsRead();
```

And add the field to the posted object, directly after `ghNote`:

```ts
        // `ghNote` and this are one slot in the legend: `accountSlot` returns
        // null whenever a gap owns it, so the two can never both be set.
        ghAccount: accountSlot({
          accounts: this.forgeAccounts,
          gap: this.forgeGap,
          prFacts: this.prFacts,
          capsAccounts: this.forge.caps.accounts,
          cli: this.forge.cli.name,
        }),
```

- [ ] **Step 4: Extract the two cache-clearing methods**

Add these private methods near `forgeReady()`:

```ts
  /** Forget every derived forge verdict. Shared by the `agentFlow.prFacts`
   * toggle and the account switch — two copies would drift. */
  private dropForgeCaches(): void {
    this.branchCi.clear();
    this.branchCiAmbiguous.clear();
  }

  /** Ask the forge everything again from scratch: health, and who it acts as. */
  private reprobeForge(): void {
    this.forgeGap = undefined;
    this.forgeProbe = null;
    this.accountsProbe = null;
    this.forgeAccounts = [];
  }
```

Now rewrite the `agentFlow.prFacts` branch of `onConfigChanged` to call them. **Behavior must not change** — the branch clears caches unconditionally and re-probes only when `prFacts` turns back on:

```ts
    if (e.affectsConfiguration("agentFlow.prFacts")) {
      this.prFacts = cfg.prFacts;
      // Dropped either way. Off: the verdicts must not outlive the source they came
      // from — `branchCiFor` already refuses to serve them, and forgetting them means
      // switching back on cannot re-serve a stamp from before the switch either. On:
      // a fresh start is the point, same as re-probing the forge below.
      this.dropForgeCaches();
      // The user may have (re-)authenticated the forge's CLI since the last probe;
      // a stale gap would otherwise keep PR facts dark for the rest of the session.
      if (cfg.prFacts) this.reprobeForge();
      touched = true;
    }
```

Two methods rather than one: the split between "always" and "only when turning on" is real behavior, and a single method would need a flag argument that re-encodes exactly this condition.

- [ ] **Step 5: Verify nothing regressed**

Run: `npm run typecheck`
Expected: PASS.

Run: `npx vitest run test/unit/deckView.test.ts test/webview/DeckApp.test.tsx test/unit/compat.test.ts`
Expected: PASS, **all three unmodified**. `compat.test.ts` freezes the released wire shape; an added optional field must not disturb it. If any of the three fails, stop and report rather than editing it.

Note: `deckView.test.ts` is large and has been observed to die locally when the dependency tree is stale. If it does, run `npm ci` and retry before assuming a regression.

- [ ] **Step 6: Verify the webview bundle still builds**

Run: `npm run build`
Expected: PASS. This is the gate that catches a non-`import type` edge from `src/types.ts` into `src/engine/forge/`. `tsc` and the whole test suite pass even when this is broken, so do not skip it.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/deckView.ts
git commit -m "feat(deck): read the forge's account list and post it with the board"
```

---

### Task 4: The legend entry

**Files:**
- Modify: `src/webview/DeckApp.tsx` (state near line 360, message handler near line 465, legend near line 943)
- Modify: `src/webview/deckStyles.ts` (legend block near line 415)
- Test: `test/webview/DeckApp.test.tsx` (append; do not edit existing cases)

**Interfaces:**
- Consumes: `deck:runs`'s optional `ghAccount` field from Task 3.
- Produces: a `deck:switchAccount` post, handled in Task 5.

- [ ] **Step 1: Write the failing tests**

Append to `test/webview/DeckApp.test.tsx`. `runsMsg` is spread rather than changed, so every existing case is untouched:

```ts
describe("the forge account in the legend", () => {
  const slot = { cli: "gh", login: "oznasi1", canSwitch: true };

  it("names the CLI and the account it is reading as", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghAccount: slot });
    expect(screen.getByText("oznasi1")).toBeTruthy();
    expect(screen.getByText(/gh as/)).toBeTruthy();
  });

  it("asks the host to switch when the link is pressed", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghAccount: slot });
    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(sent).toHaveBeenCalledWith({ type: "deck:switchAccount" });
  });

  it("shows no switch link when there is nothing to switch to", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghAccount: { ...slot, canSwitch: false } });
    expect(screen.getByText("oznasi1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "switch" })).toBeNull();
  });

  // One slot, and the warning owns it: "gh is not signed in" and "gh as X" are
  // mutually exclusive by construction, but the webview must not render both
  // even if a future host sends both.
  it("yields the slot to the forge warning", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghNote: "gh is not signed in — PR facts off. Run Doctor", ghAccount: slot });
    expect(screen.getByText(/not signed in/)).toBeTruthy();
    expect(screen.queryByText("oznasi1")).toBeNull();
  });

  // The field is optional on the wire, so a host that never sends it — an older
  // build, mid-reload — must render exactly today's legend.
  it("renders nothing when the host says nothing", () => {
    render(<DeckApp />);
    host(runsMsg([mkStatus()]));
    expect(screen.queryByRole("button", { name: "switch" })).toBeNull();
    expect(screen.queryByText(/ as /)).toBeNull();
  });

  it("clears the account when a later post drops it", () => {
    render(<DeckApp />);
    host({ ...runsMsg([mkStatus()]), ghAccount: slot });
    expect(screen.getByText("oznasi1")).toBeTruthy();
    host({ ...runsMsg([mkStatus()]), ghAccount: null });
    expect(screen.queryByText("oznasi1")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/webview/DeckApp.test.tsx -t "forge account in the legend"`
Expected: FAIL — `Unable to find an element with the text: oznasi1`.

- [ ] **Step 3: Add the state and the handler**

In `src/webview/DeckApp.tsx`, beside the `ghNote` state near line 360:

```tsx
  const [ghAccount, setGhAccount] = React.useState<AccountSlot | null>(null);
```

Add to the imports at the top of the file:

```tsx
import type { AccountSlot } from "../engine/forge/accounts";
```

**`import type`, without exception.** A value import here would put `src/engine/forge/` on the Deck bundle's graph and break `npm run build`.

Beside `setGhNote(m.ghNote)` in the `deck:runs` handler near line 465:

```tsx
        // `?? null` for the same reason `agentLabel` has a fallback: an in-flight
        // message posted before this build's host reloads carries no such field.
        setGhAccount(m.ghAccount ?? null);
```

- [ ] **Step 4: Render it**

In the legend near line 943, replace:

```tsx
        {ghNote && <span className="note warn">{ghNote}</span>}
```

with:

```tsx
        {/* One slot. `accountSlot` already returns null whenever a gap owns it,
            so this ternary is belt-and-braces rather than the rule — but a
            legend showing "gh is not signed in" beside "gh as oznasi1" would be
            self-contradicting, and this is the cheapest place to make that
            impossible. */}
        {ghNote
          ? <span className="note warn">{ghNote}</span>
          : ghAccount && (
              <span className="note acct">
                {`${ghAccount.cli} as `}
                <span className="who">{ghAccount.login}</span>
                {ghAccount.canSwitch && (
                  <>
                    {" · "}
                    <button type="button" className="lnk" onClick={() => send({ type: "deck:switchAccount" })}>
                      switch
                    </button>
                  </>
                )}
              </span>
            )}
```

- [ ] **Step 5: Add the styles**

In `src/webview/deckStyles.ts`, after the `.legend .note.warn` rule:

```css
  /* Sits with the other notes, not pushed right: it is a statement of fact
     about the board, the same class of thing as the warn note it replaces. */
  .legend .note.acct { margin-left: 0; }
  /* An identifier, so mono — the same rule the branch chip and the ~/.claude
     path follow. No colour: nothing here is wrong. */
  .legend .note.acct .who { font-family: var(--mono); font-size: var(--t-data);
    color: var(--vscode-foreground); }
  .legend .lnk { background: none; border: 0; padding: 0; font: inherit; color: inherit;
    text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .legend .lnk:hover { color: var(--vscode-foreground); }
```

No `--brand` token is introduced. `test/webview/tokens.test.ts` asserts set equality per stylesheet on brand rules — adding one would fail that gate.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/webview/DeckApp.test.tsx`
Expected: PASS — the new cases and every pre-existing one, unmodified.

- [ ] **Step 7: Verify the bundle**

Run: `npm run build && npx vitest run test/webview/webviewGraph.test.ts test/webview/tokens.test.ts`
Expected: all PASS. `webviewGraph.test.ts` walks the real import graph from each browser entry point; the build is the backstop that also catches bare npm specifiers.

- [ ] **Step 8: Commit**

```bash
git add src/webview/DeckApp.tsx src/webview/deckStyles.ts test/webview/DeckApp.test.tsx
git commit -m "feat(deck): name the forge account in the legend, with a switch link"
```

---

### Task 5: The switch, the invalidation, and the changelog

**Files:**
- Modify: `src/deckView.ts` (message handler near line 3178, plus the new private method)
- Modify: `CHANGELOG.md`
- Test: `test/unit/deckView.test.ts` (append; do not edit existing cases)

**Interfaces:**
- Consumes: `Forge.accounts()` / `Forge.switchAccount()` (Task 2); `dropForgeCaches()` / `reprobeForge()` (Task 3); the `deck:switchAccount` message (Task 3); `readRuns`, `defaultRunsDir`, `removePrEntries`, `defaultPrFactsDir`, all already imported in `deckView.ts`.
- Produces: nothing downstream — this is the last task.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/deckView.test.ts`. This uses the file's **existing** harness — do not add helpers:

- `h.ghRun` is the single injected `execRunner` seam every forge spawn goes through (`vi.mock` of `../../src/engine/pr/provider`, line ~363). Dispatch on argv.
- `h.runs` is the run list `readRuns` returns (`vi.mock` of `../../src/engine/runs`, line ~264).
- `h.removePrEntries` is the spy behind `removePrEntries` (`vi.mock` of `../../src/engine/pr/store`, line ~351).
- `showAndWarm()` opens the panel and drives one refresh; `p._fire(msg)` delivers a webview message; `posts(p)` returns everything posted back.
- `window.showQuickPick` / `window.showWarningMessage` come from `../_mocks/vscode`, already imported at the top and reset between tests.

```ts
describe("switching the forge account", () => {
  const TWO = JSON.stringify({ hosts: { "github.com": [
    { state: "success", active: true, login: "oznasi1", scopes: "repo, workflow" },
    { state: "success", active: false, login: "OznasiAb", scopes: "repo" },
  ] } });
  const ONE = JSON.stringify({ hosts: { "github.com": [
    { state: "success", active: true, login: "solo", scopes: "repo" },
  ] } });

  /** Answer the account calls; leave every other gh spawn as the file's default. */
  const ghAccounts = (json: string, onSwitch: () => string = () => "") => {
    h.ghRun.mockImplementation(async (_f: string, args: string[]) => {
      if (args[0] === "auth" && args[1] === "status") return json;
      if (args[0] === "auth" && args[1] === "switch") return onSwitch();
      return "[]";
    });
  };

  const switched = () =>
    h.ghRun.mock.calls.filter((c) => c[1][0] === "auth" && c[1][1] === "switch");

  it("offers only the accounts that are not already active", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:switchAccount" });
    const items = window.showQuickPick.mock.calls[0][0] as { label: string; detail: string }[];
    expect(items.map((i) => i.label)).toEqual(["OznasiAb"]);
    expect(items[0].detail).toBe("repo");
  });

  // Machine-wide is the whole reason the modal exists.
  it("confirms with a modal that discloses the machine-wide effect", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:switchAccount" });
    const opts = window.showWarningMessage.mock.calls[0][1] as { modal?: boolean; detail?: string };
    expect(opts.modal).toBe(true);
    expect(opts.detail).toMatch(/whole machine/i);
  });

  it("switches nothing when the modal is declined", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:switchAccount" });
    expect(switched()).toHaveLength(0);
    expect(h.removePrEntries).not.toHaveBeenCalled();
  });

  it("switches nothing when the picker is dismissed", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await p._fire({ type: "deck:switchAccount" });
    expect(window.showWarningMessage).not.toHaveBeenCalled();
    expect(switched()).toHaveLength(0);
  });

  it("spawns the switch with the account the user picked", async () => {
    ghAccounts(TWO);
    const p = await showAndWarm();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce("Switch");
    await p._fire({ type: "deck:switchAccount" });
    expect(switched()[0][1]).toEqual(["auth", "switch", "--hostname", "github.com", "--user", "OznasiAb"]);
  });

  // Without this the switch appears inert: every error entry survives, the board
  // re-renders identically, and the user concludes the feature is broken.
  it("forgets every run's stored PR entries, because they are the old identity's answers", async () => {
    h.runs = [mkRun({ key: "ASM-1" }), mkRun({ key: "ASM-2" })];
    ghAccounts(TWO);
    const p = await showAndWarm();
    h.removePrEntries.mockClear();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce("Switch");
    await p._fire({ type: "deck:switchAccount" });
    expect(h.removePrEntries.mock.calls.map((c) => c[1])).toEqual(["ASM-1", "ASM-2"]);
  });

  it("leaves the stored entries alone when the switch fails, and says why", async () => {
    h.runs = [mkRun({ key: "ASM-1" })];
    ghAccounts(TWO, () => { throw new Error("no such account"); });
    const p = await showAndWarm();
    h.removePrEntries.mockClear();
    window.showQuickPick.mockResolvedValueOnce({ label: "OznasiAb" });
    window.showWarningMessage.mockResolvedValueOnce("Switch");
    await p._fire({ type: "deck:switchAccount" });
    expect(h.removePrEntries).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(
      expect.objectContaining({ type: "toast", level: "error", message: expect.stringContaining("no such account") }),
    );
  });

  it("says so rather than opening an empty picker when there is only one account", async () => {
    ghAccounts(ONE);
    const p = await showAndWarm();
    await p._fire({ type: "deck:switchAccount" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(posts(p)).toContainEqual(expect.objectContaining({ type: "toast", level: "info" }));
  });

  // The legend hides the link on such a forge, so this should be unreachable —
  // which is exactly why the host must not depend on it being unreachable.
  it("refuses outright on a forge that cannot switch accounts", async () => {
    setConfig({ forge: "gitlab" });
    const p = await showAndWarm();
    await p._fire({ type: "deck:switchAccount" });
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(switched()).toHaveLength(0);
  });
});
```

Two notes on the harness. `h.runs` is reassigned directly, the way the file's other run fixtures do it — restore it in the block's own `beforeEach` if the surrounding suite does not already reset it. And `showAndWarm()` drives a refresh that itself calls `gh auth status --json hosts`, so `h.removePrEntries.mockClear()` after it is what keeps the assertion about the switch rather than about setup.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/unit/deckView.test.ts -t "switching the forge account"`
Expected: FAIL — the message falls through the handler's switch and nothing happens.

- [ ] **Step 3: Implement the handler**

In `src/deckView.ts`, add the case beside `deck:clearStale` near line 3178:

```ts
      case "deck:switchAccount":
        await this.switchForgeAccount();
        break;
```

Add the method:

```ts
  /**
   * Change which account the forge's CLI acts as.
   *
   * `gh` holds one active account per host, so this is machine state, not
   * workspace state: it changes every editor window, every terminal, and every
   * other tool that shells out to the same CLI. That is why a modal sits in the
   * middle of it — a footer link cannot carry the disclosure, and a user who
   * flips identity without noticing gets a board full of unreadable PRs that
   * look exactly like repos with no PR at all.
   */
  private async switchForgeAccount(): Promise<void> {
    // Belt and braces: the legend hides the link for such a forge, so this
    // message should be unreachable there. A host must not trust that.
    if (!this.forge.caps.accounts) return;
    const accounts = await this.forge.accounts();
    const others = accounts.filter((a) => !a.active);
    if (others.length === 0) {
      this.toast("info", `${this.forge.cli.name} knows only one account — there is nothing to switch to.`);
      return;
    }
    const pick = await vscode.window.showQuickPick(
      // `detail` rather than `description`: scopes are long, and they are the
      // only thing distinguishing two logins that look alike.
      others.map((a) => ({ label: a.login, detail: a.scopes })),
      { title: `Read ${this.forge.label} as…`, placeHolder: "Pick the account to make active" },
    );
    if (!pick) return;
    const go = await vscode.window.showWarningMessage(
      `Make ${pick.label} the active ${this.forge.cli.name} account?`,
      {
        modal: true,
        detail:
          `This changes ${this.forge.cli.name} for your whole machine — every editor window, every ` +
          `terminal, and every other tool that uses it. Agent Flow will forget every PR it has ` +
          `already read and ask again as ${pick.label}.`,
      },
      "Switch",
    );
    if (go !== "Switch") return;
    const res = await this.forge.switchAccount(pick.label);
    if (!res.ok) {
      this.toast("error", `Could not switch ${this.forge.cli.name}: ${res.message}`);
      return;
    }
    this.dropForgeCaches();
    this.reprobeForge();
    // The stored entries are the OLD identity's answers and cannot be
    // re-validated — a `facts: null` written while signed in as an account that
    // could not see the repo is indistinguishable from "there is no PR". Drop
    // them so the next pass asks again, and bump each epoch so a fetch already
    // in flight under the old account cannot write its answer after the switch.
    for (const run of readRuns(defaultRunsDir())) {
      removePrEntries(defaultPrFactsDir(), run.key);
      this.prEpoch.set(run.key, (this.prEpoch.get(run.key) ?? 0) + 1);
    }
    this.toast("success", `${this.forge.cli.name} is now ${pick.label} — re-reading PR state.`);
    await this.refreshBusy();
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/unit/deckView.test.ts`
Expected: PASS — the new cases and every pre-existing one, unmodified.

- [ ] **Step 5: Mutation-check the invalidation**

The invalidation is the step whose absence makes the feature silently useless, so prove its test is real:

1. Delete the `removePrEntries(...)` line inside the loop. Run `npx vitest run test/unit/deckView.test.ts -t "forgets every run's stored PR entries"`. Expected: FAIL.
2. Restore it. Change `if (go !== "Switch") return;` to `if (go === "never") return;`. Run `-t "declined"`. Expected: FAIL.
3. Restore. Run the file. Expected: PASS.

If either mutation passes, the test is vacuous — fix the test.

- [ ] **Step 6: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`:

```markdown
- The Deck's footer now names which account your forge's CLI is reading as, when
  you have more than one — `gh as oznasi1` — with a **switch** link beside it.
  Switching is machine-wide, so it confirms first, and it forgets every PR it
  has already read so the board is answered by the account you just chose. A
  wrong active account used to be invisible: every read failed, and a failed
  read looks exactly like a repo with no PR. GitLab has no multi-account model,
  so nothing appears there.
```

- [ ] **Step 7: Run the full gate**

```bash
npm run typecheck && npm test && npm run build
```

Use `timeout: 600000` on the `npm test` call. Do **not** pipe it through `tail` or `head`. Expected: all pass. A single unrelated failure under CPU contention is usually flake — re-run that one file alone before believing it.

- [ ] **Step 8: Check coverage on what you added**

```bash
npm run test:cov
```

Expected: thresholds hold — 90% lines/statements, 85% branches/functions. `accounts.ts` should be at or near 100%; if `deckView.ts`'s new method drags branches under, add the missing case to `deckView.test.ts` rather than lowering a threshold.

- [ ] **Step 9: Commit**

```bash
git add src/deckView.ts CHANGELOG.md test/unit/deckView.test.ts
git commit -m "feat(deck): switch the forge account, and forget what the old one told us"
```

---

## Verification checklist

Before calling this done, confirm each with actual command output — never from memory:

- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes, with **no existing test file modified**. `git diff --stat main -- test/` should show only additions to `DeckApp.test.tsx` and `deckView.test.ts`, plus the two new files.
- [ ] `npm run build` passes — the only gate that catches a Node builtin reaching a browser bundle.
- [ ] `npm run test:cov` passes its thresholds.
- [ ] `docs/FORGES.md`'s interface block matches `src/engine/forge/types.ts` (`test/unit/docs.test.ts`).
- [ ] `CHANGELOG.md` has the `## [Unreleased]` entry.
- [ ] Manually, in a dev host (**F5**, or VS Code's own `code --extensionDevelopmentPath=…` — the Cursor CLI silently drops the flag): with two `gh` accounts the legend reads `gh as <login> · switch`; the link opens a picker listing only the other account; declining the modal changes nothing; accepting it re-reads the board. With one account, the legend is unchanged from today.
