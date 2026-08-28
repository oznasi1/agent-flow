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
  // ── the unread count rides on this row ────────────────────────────────────
  it("omits the count entirely when every read succeeded", () => {
    // Absent, not zero: the released shape is what the other tests here assert
    // with toEqual, and a consumer reading "no field" needs no zero case.
    expect(accountSlot({ ...base, unreadRuns: 0 })).not.toHaveProperty("unreadRuns");
    expect(accountSlot({ ...base })).not.toHaveProperty("unreadRuns");
  });

  it("carries the count when reads are failing, beside the account that fixes it", () => {
    expect(accountSlot({ ...base, unreadRuns: 6 })?.unreadRuns).toBe(6);
  });

  it("still names the account when reads are failing, rather than standing down", () => {
    // The whole point: the account named here is what a reader would switch to
    // fix the very failure the count reports. Hiding the row would hide the fix.
    const slot = accountSlot({ ...base, unreadRuns: 6 });
    expect(slot?.login).toBe(base.accounts.find((a) => a.active)!.login);
    expect(slot?.canSwitch).toBe(true);
  });

  it("keeps every silence rule even with a count to report", () => {
    // A count must not resurrect a row that some other rule already suppressed:
    // one account is still not a choice, and a gap still owns the slot.
    expect(accountSlot({ ...base, accounts: [acct("a", true)], unreadRuns: 6 })).toBeNull();
    expect(accountSlot({ ...base, gap: { kind: "missing", detail: "" }, unreadRuns: 6 })).toBeNull();
    expect(accountSlot({ ...base, prFacts: false, unreadRuns: 6 })).toBeNull();
    expect(accountSlot({ ...base, capsAccounts: false, unreadRuns: 6 })).toBeNull();
  });
});

describe("an ACTIVE account whose token has gone bad", () => {
  // The hazard this file's own header documents: gh exits 0 with --json even
  // when the ACTIVE account's token is bad ("unless there is a fatal error"),
  // so a clean exit is not proof every account is usable. The dropped-account
  // rule was pinned above only for an INACTIVE bad entry — this pins the active
  // one, whose failure mode is worse: it is the identity the footer would name.
  const ACTIVE_BAD = JSON.stringify({
    hosts: {
      "github.com": [
        { state: "error", active: true, host: "github.com", login: "broken",
          tokenSource: "keyring", scopes: "repo", error: "token invalid" },
        { state: "success", active: false, host: "github.com", login: "healthy",
          tokenSource: "keyring", scopes: "repo" },
        { state: "success", active: false, host: "github.com", login: "spare",
          tokenSource: "keyring", scopes: "repo" },
      ],
    },
  });

  it("drops the active bad account rather than offering it as a switch target", () => {
    expect(parseGhAccounts(ACTIVE_BAD, "github.com")).toEqual([
      { login: "healthy", active: false, scopes: "repo" },
      { login: "spare", active: false, scopes: "repo" },
    ]);
  });

  it("names no identity for that list — the slot stays free for the probe's signed-out warning", () => {
    // Two survivors, so the two-account silence rule is NOT what suppresses the
    // row: it is the no-active rule. That is the whole surfacing story for a bad
    // active account — probe() reports signed-out, and this function stands down
    // instead of labelling the board with an account gh cannot use.
    const accounts = parseGhAccounts(ACTIVE_BAD, "github.com");
    expect(accounts.length).toBeGreaterThanOrEqual(2);
    expect(accountSlot({ accounts, gap: null, prFacts: true, capsAccounts: true, cli: "gh" })).toBeNull();
  });
});
