import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAgileAcceleratorConnector } from "../../../../src/tasks/agileAccelerator/connector";
import { SfMissingError, type SfCli } from "../../../../src/tasks/agileAccelerator/cli";
import { markTaskNetworkFailure } from "../../../../src/tasks/provider";
import { ConfigurationTarget, window, workspace } from "../../../_mocks/vscode";

let cfg = {
  agileAcceleratorInstanceUrl: "https://gus.lightning.force.com",
  agileAcceleratorTeam: "Falcons",
  agileAcceleratorTargetOrg: "",
};
vi.mock("../../../../src/config", () => ({ getConfig: () => cfg }));

const ctx = { secrets: { get: async () => undefined } } as never;

beforeEach(() => {
  cfg = {
    agileAcceleratorInstanceUrl: "https://gus.lightning.force.com",
    agileAcceleratorTeam: "Falcons",
    agileAcceleratorTargetOrg: "",
  };
});

/** A fake `SfCli`, cast through `unknown` — the same pattern Task 6's
 * `provider.test.ts` uses for `ProviderDeps["cli"]`. `describeImpl`, when given,
 * overrides the whole describe() behaviour (for tests that need to count calls
 * across both `WORK_OBJECT_CANDIDATES`); otherwise the bare `ADM_Work__c`
 * candidate resolves with `fields` and the namespaced `agf__` one 404s, which is
 * what an unmanaged GUS org actually looks like and is what most tests want. */
function fakeCli(
  opts: {
    installed?: boolean;
    fields?: string[];
    describeImpl?: (object: string) => Promise<{ name: string; fields: { name: string }[] }>;
    query?: (soql: string) => Promise<unknown[]>;
    userInfo?: () => Promise<{ username: string; id: string }>;
  } = {},
): SfCli {
  const describeImpl =
    opts.describeImpl ??
    (async (object: string) => {
      if (object === "agf__ADM_Work__c") throw new Error("sObject type 'agf__ADM_Work__c' is not supported");
      return { name: object, fields: (opts.fields ?? ["Name", "Id", "Status__c"]).map((name) => ({ name })) };
    });
  return {
    installed: () => opts.installed ?? true,
    describe: describeImpl,
    query: opts.query ?? (async () => []),
    userInfo: opts.userInfo ?? (async () => ({ username: "jane", id: "005xx0000000001" })),
  } as unknown as SfCli;
}

describe("identity and info", () => {
  it("uses the frozen id", () => {
    expect(makeAgileAcceleratorConnector(ctx).id).toBe("agileAccelerator");
  });

  it("describes itself with a team scope and a W- example key", () => {
    const info = makeAgileAcceleratorConnector(ctx).info();
    expect(info.label).toBe("Agile Accelerator");
    expect(info.scopeNoun).toBe("team");
    expect(info.scopeValue).toBe("Falcons");
    expect(info.endpoint).toBe("https://gus.lightning.force.com");
    expect(info.exampleKey).toMatch(/^W-\d+$/);
    expect(info.endpointSetting).toBe("agentFlow.agileAccelerator.instanceUrl");
    expect(info.scopeSetting).toBe("agentFlow.agileAccelerator.team");
  });

  it("trims the team setting in info(), not just in isConfigured()", () => {
    // A setting with surrounding whitespace must not display differently from
    // Doctor's own probe of it, or from what the provider actually queries.
    cfg = { ...cfg, agileAcceleratorTeam: "  Falcons  " };
    expect(makeAgileAcceleratorConnector(ctx).info().scopeValue).toBe("Falcons");
  });
});

describe("isConfigured", () => {
  it("is true when both required settings are filled in", () => {
    expect(makeAgileAcceleratorConnector(ctx).isConfigured()).toBe(true);
  });

  it("treats a whitespace-only setting as unconfigured", () => {
    cfg = { ...cfg, agileAcceleratorTeam: "   " };
    expect(makeAgileAcceleratorConnector(ctx).isConfigured()).toBe(false);
  });

  it("does not require the optional target org", () => {
    cfg = { ...cfg, agileAcceleratorTargetOrg: "" };
    expect(makeAgileAcceleratorConnector(ctx).isConfigured()).toBe(true);
  });
});

describe("urls", () => {
  it("returns the instance root for a key it has never seen", () => {
    // Deliberately dull: a guessed deep-link shape that 404s is worse than a
    // landing page, and no search-url shape is verified.
    expect(makeAgileAcceleratorConnector(ctx).taskUrl("W-1")).toBe("https://gus.lightning.force.com");
  });

  it("returns the deep link, via shape.ts's recordUrl, once a key's Id is memoized", async () => {
    const cli = fakeCli({ query: async () => [{ Id: "a01", Name: "W-1", Status__c: "New" }] });
    const c = makeAgileAcceleratorConnector(ctx, () => cli);
    await c.provider().list("all", "any"); // list() calls rememberIds() on every row read back
    expect(c.taskUrl("W-1")).toBe("https://gus.lightning.force.com/lightning/r/ADM_Work__c/a01/view");
  });

  it("recovers a key from a url that carries a W- token", () => {
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.keyFromUrl("https://x/lightning/r/ADM_Work__c/W-42/view")).toBe("W-42");
  });

  it("returns null for our own id-shaped url, rather than guessing a key", () => {
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.keyFromUrl("https://x/lightning/r/ADM_Work__c/a0700000000001AAA/view")).toBeNull();
  });

  it("returns null for another source's url", () => {
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.keyFromUrl("https://x.atlassian.net/browse/ABC-1")).toBeNull();
  });
});

describe("the setup wizard", () => {
  it("writes nothing until the thunk runs, then writes all three settings trimmed and slash-stripped, to Global", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("  https://gus.lightning.force.com///  ")
      .mockResolvedValueOnce("  Falcons  ")
      .mockResolvedValueOnce("  gus  ");
    const c = makeAgileAcceleratorConnector(ctx);
    expect(c.setupSteps).toBe(3);
    const commit = await c.configure(1, 4);
    expect(typeof commit).toBe("function");

    // Both boxes answered (well, all three), yet nothing is written yet —
    // setup.ts may still have a step ahead of this one the user can cancel at.
    expect(workspace.getConfiguration).not.toHaveBeenCalled();

    await commit!();

    const cfgInstance = vi.mocked(workspace.getConfiguration).mock.results[0].value;
    expect(cfgInstance.update).toHaveBeenCalledWith(
      "agentFlow.agileAccelerator.instanceUrl",
      "https://gus.lightning.force.com",
      ConfigurationTarget.Global,
    );
    expect(cfgInstance.update).toHaveBeenCalledWith(
      "agentFlow.agileAccelerator.team",
      "Falcons",
      ConfigurationTarget.Global,
    );
    expect(cfgInstance.update).toHaveBeenCalledWith(
      "agentFlow.agileAccelerator.targetOrg",
      "gus",
      ConfigurationTarget.Global,
    );
  });

  it("returns null when the instance-url step is cancelled, so setup aborts cleanly", async () => {
    vi.mocked(window.showInputBox).mockResolvedValueOnce(undefined);
    expect(await makeAgileAcceleratorConnector(ctx).configure(1, 4)).toBeNull();
    expect(vi.mocked(window.showInputBox)).toHaveBeenCalledTimes(1);
  });

  it("returns null when the team step is cancelled, so setup aborts cleanly", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("https://gus.lightning.force.com")
      .mockResolvedValueOnce(undefined);
    expect(await makeAgileAcceleratorConnector(ctx).configure(1, 4)).toBeNull();
    expect(vi.mocked(window.showInputBox)).toHaveBeenCalledTimes(2);
  });

  it("returns null when the target-org step is cancelled, so setup aborts cleanly", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("https://gus.lightning.force.com")
      .mockResolvedValueOnce("Falcons")
      .mockResolvedValueOnce(undefined);
    expect(await makeAgileAcceleratorConnector(ctx).configure(1, 4)).toBeNull();
    expect(vi.mocked(window.showInputBox)).toHaveBeenCalledTimes(3);
  });
});

describe("signOut", () => {
  it("does not call the CLI at all — sign-out is advisory only", async () => {
    const installed = vi.fn(() => true);
    const query = vi.fn(async () => []);
    const describeFn = vi.fn(async () => ({ name: "ADM_Work__c", fields: [] }));
    const userInfo = vi.fn(async () => ({ username: "jane", id: "005xx0000000001" }));
    const cli = { installed, query, describe: describeFn, userInfo } as unknown as SfCli;

    const c = makeAgileAcceleratorConnector(ctx, () => cli);
    // An implementation that ran `sf org logout` and returned void would pass an
    // assertion on the return value alone; only "the CLI was never touched"
    // proves this is advisory.
    await expect(c.signOut()).resolves.toBeUndefined();

    expect(installed).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(describeFn).not.toHaveBeenCalled();
    expect(userInfo).not.toHaveBeenCalled();
  });
});

describe("probe()", () => {
  it("reports auth:false naming the install url when sf is not on PATH", async () => {
    const cli = fakeCli({ installed: false });
    const { auth, scope } = await makeAgileAcceleratorConnector(ctx, () => cli).probe();
    expect(auth).toEqual({
      ok: false,
      reason: "auth",
      message: expect.stringContaining("https://developer.salesforce.com/tools/salesforcecli"),
    });
    expect(scope).toBeUndefined(); // never reached — Doctor renders this branch as skip, not pass
  });

  it("reports auth:false naming the install url when userInfo() throws SfMissingError", async () => {
    // Same message as the `installed()` check above, reached a different way —
    // e.g. `sf` uninstalled between the installed() check and the spawn.
    const cli = fakeCli({
      userInfo: async () => {
        throw new SfMissingError("gone");
      },
    });
    const { auth } = await makeAgileAcceleratorConnector(ctx, () => cli).probe();
    expect(auth).toEqual({
      ok: false,
      reason: "auth",
      message: expect.stringContaining("https://developer.salesforce.com/tools/salesforcecli"),
    });
  });

  it("classifies a network-tagged failure as network, not auth", async () => {
    // This is the regression the fix targets: before it, `identity()`'s
    // swallow-to-null meant this branch could never be reached, and a CLI
    // timeout was misreported as `reason: "auth"` — "sign in again" advice for
    // a problem sign-in cannot fix.
    const cli = fakeCli({
      userInfo: async () => {
        throw markTaskNetworkFailure(new Error("The Salesforce CLI timed out."), "ETIMEDOUT");
      },
    });
    const { auth } = await makeAgileAcceleratorConnector(ctx, () => cli).probe();
    expect(auth).toEqual({ ok: false, reason: "network", message: "The Salesforce CLI timed out." });
  });

  it("reports auth ok and scope ok when the org has a team field, trimmed", async () => {
    cfg = { ...cfg, agileAcceleratorTeam: "  Falcons  " };
    const cli = fakeCli({ fields: ["Scrum_Team__c"] });
    const { auth, scope } = await makeAgileAcceleratorConnector(ctx, () => cli).probe();
    expect(auth).toEqual({ ok: true, displayName: "jane" });
    expect(scope).toEqual({ ok: true, name: "Falcons" });
  });

  it("reports scope not-found when the org has no team field", async () => {
    const cli = fakeCli({ fields: ["Name", "Id"] });
    const { scope } = await makeAgileAcceleratorConnector(ctx, () => cli).probe();
    expect(scope).toEqual({ ok: false, reason: "not-found", message: expect.any(String) });
  });
});

describe("schema() retry", () => {
  it("retries after a failed describe instead of caching the failure", async () => {
    let calls = 0;
    const cli = fakeCli({
      describeImpl: async (object) => {
        calls++;
        if (calls <= 2) throw new Error("describe unavailable"); // both candidates fail once each
        return { name: object, fields: [{ name: "Name" }, { name: "Id" }, { name: "Status__c" }] };
      },
    });
    const c = makeAgileAcceleratorConnector(ctx, () => cli);

    await expect(c.provider().list("all", "any")).rejects.toThrow();
    expect(calls).toBe(2);

    await expect(c.provider().list("all", "any")).resolves.toEqual([]);
    expect(calls).toBe(3); // the retry re-tried the first candidate, not stuck on the cached rejection
  });
});

describe("statusOf() batching", () => {
  it("coalesces several concurrent misses — including a repeated key — into exactly one query", async () => {
    let queryCalls = 0;
    let lastSoql = "";
    const cli = fakeCli({
      query: async (soql) => {
        queryCalls++;
        lastSoql = soql;
        return [
          { Id: "a01", Name: "W-1", Status__c: "New" },
          { Id: "a02", Name: "W-2", Status__c: "Fixed" },
        ];
      },
    });
    const c = makeAgileAcceleratorConnector(ctx, () => cli);
    const p = c.provider();

    // Mirrors deckView's `Promise.all(all.map(run => ... ticketStatus ...))`.
    const [s1, s2, s3] = await Promise.all([p.status("W-1"), p.status("W-2"), p.status("W-1")]);

    expect(queryCalls).toBe(1);
    expect(s1).toEqual({ status: "New", category: "new" });
    expect(s2).toEqual({ status: "Fixed", category: "done" });
    expect(s3).toEqual({ status: "New", category: "new" });
    expect(lastSoql).toContain("W-1");
    expect(lastSoql).toContain("W-2");
  });

  it("caches a key the org did not return as unknown, so it does not re-query within the TTL", async () => {
    let queryCalls = 0;
    const cli = fakeCli({
      query: async () => {
        queryCalls++;
        return [{ Id: "a01", Name: "W-1", Status__c: "New" }]; // W-2 never comes back
      },
    });
    const c = makeAgileAcceleratorConnector(ctx, () => cli);
    const p = c.provider();

    const [, missed] = await Promise.all([p.status("W-1"), p.status("W-2")]);
    expect(missed).toEqual({ status: null, category: null });
    expect(queryCalls).toBe(1);

    const secondLook = await p.status("W-2"); // still within the TTL
    expect(secondLook).toEqual({ status: null, category: null });
    expect(queryCalls).toBe(1); // a cache hit, not a second query
  });

  it("resolves every waiter to unknown when the query throws, and does not cache the failure", async () => {
    let queryCalls = 0;
    const cli = fakeCli({
      query: async () => {
        queryCalls++;
        throw new Error("boom");
      },
    });
    const c = makeAgileAcceleratorConnector(ctx, () => cli);
    const p = c.provider();

    expect(await p.status("W-1")).toEqual({ status: null, category: null });
    expect(queryCalls).toBe(1);

    // Not cached: a background poll's failure must not strand the card on
    // "unknown" for the rest of the TTL once the query starts working again.
    expect(await p.status("W-1")).toEqual({ status: null, category: null });
    expect(queryCalls).toBe(2);
  });

  it("re-queries once the TTL has elapsed", async () => {
    let queryCalls = 0;
    const cli = fakeCli({
      query: async () => {
        queryCalls++;
        return [{ Id: "a01", Name: "W-1", Status__c: "New" }];
      },
    });
    let now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const c = makeAgileAcceleratorConnector(ctx, () => cli);
      const p = c.provider();

      expect((await p.status("W-1")).status).toBe("New");
      expect(queryCalls).toBe(1);

      expect((await p.status("W-1")).status).toBe("New"); // still fresh
      expect(queryCalls).toBe(1);

      now += 30_001; // one past the connector's internal 30s TTL
      await p.status("W-1");
      expect(queryCalls).toBe(2);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("provider()", () => {
  it("wires a working provider end to end", async () => {
    const cli = fakeCli({
      query: async () => [{ Id: "a01", Name: "W-1", Status__c: "New" }],
    });
    const c = makeAgileAcceleratorConnector(ctx, () => cli);
    const tasks = await c.provider().list("all", "any");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].key).toBe("W-1");
    expect(tasks[0].url).toBe("https://gus.lightning.force.com/lightning/r/ADM_Work__c/a01/view");
  });
});
