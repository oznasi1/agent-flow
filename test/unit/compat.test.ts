import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { ApiTokenAuth } from "../../src/tasks/jira/auth";
import { makeJiraConnector } from "../../src/tasks/jira/connector";
import { runSetup, SETUP_COMPLETE_KEY } from "../../src/setup";
import { ticketKeyFor, Run, WorkspaceMode } from "../../src/types";
import { fakeContext, fakeSecrets } from "../_helpers/factories";
import { window, workspace } from "../_mocks/vscode";
import { FlowIo, readFlows } from "../../src/engine/orchestrator/store";

/** Helper to build a Run object with sensible defaults for testing. */
function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    key: overrides.key ?? "default-key",
    summary: overrides.summary ?? "Default summary",
    url: overrides.url ?? "",
    createdAt: overrides.createdAt ?? Date.now(),
    mode: overrides.mode ?? ("multiroot" as WorkspaceMode),
    repos: overrides.repos ?? [],
    briefPaths: overrides.briefPaths ?? [],
    ...overrides,
  };
}

/** These assertions encode promises made to users who already have Agent Flow
 * installed and configured. Breaking one silently signs them out, re-runs their
 * wizard, or empties their board. If a refactor makes one of these fail, the
 * refactor is wrong — do not update the test. */
describe("compatibility surface (frozen)", () => {
  it("reads the two released SecretStorage keys on getAuthHeader and deletes them on signOut", async () => {
    const secrets = fakeSecrets();
    const auth = new ApiTokenAuth(secrets as never);

    await auth.getAuthHeader();
    expect(secrets.get.mock.calls.map((c) => c[0]).sort()).toEqual([
      "agentFlow.jira.email",
      "agentFlow.jira.token",
    ]);

    await auth.signOut();
    expect(secrets.delete.mock.calls.map((c) => c[0]).sort()).toEqual([
      "agentFlow.jira.email",
      "agentFlow.jira.token",
    ]);
  });

  it("writes the two released SecretStorage keys on signIn", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("user@example.com")
      .mockResolvedValueOnce("apitoken123");
    const secrets = fakeSecrets();
    const auth = new ApiTokenAuth(secrets as never);

    await auth.signIn();
    // Assert on the exact key names passed to store — a future OAuth provider
    // must not change these without updating this test, or existing users will be signed out.
    expect(secrets.store.mock.calls.map((c) => c[0]).sort()).toEqual([
      "agentFlow.jira.email",
      "agentFlow.jira.token",
    ]);
  });

  it("produces Basic auth from the stored email and token", async () => {
    const secrets = fakeSecrets({
      "agentFlow.jira.email": "you@example.com",
      "agentFlow.jira.token": "tok",
    });
    const auth = new ApiTokenAuth(secrets as never);
    const expected = `Basic ${Buffer.from("you@example.com:tok").toString("base64")}`;
    expect(await auth.getAuthHeader()).toBe(expected);
  });

  it("keeps the released globalState and workspaceState keys", () => {
    expect(SETUP_COMPLETE_KEY).toBe("agentFlow.setupComplete");
    // Read from source: SPRINT_ORDER_KEY is module-private by design.
    const src = fs.readFileSync(path.join(__dirname, "../../src/tasksView.ts"), "utf8");
    expect(src).toContain('"agentFlow.sprintOrder"');
  });

  it("recovers a ticket key from a run url already on disk", () => {
    // The real, shipped Jira connector — not a hand-rolled mirror of its
    // /browse/ parsing. This file's charter is that a failure here means the
    // refactor is wrong, and that promise only holds if it pins the actual
    // parser: a mirror can drift from the release (e.g. a future connector
    // change to the marker) without this test ever noticing.
    const jira = makeJiraConnector({ secrets: fakeSecrets() } as never);
    expect(ticketKeyFor(makeRun({ key: "ABC-1", url: "https://x.atlassian.net/browse/ABC-1" }), jira)).toBe("ABC-1");
    expect(ticketKeyFor(makeRun({ key: "a1b2c3", url: "https://x.atlassian.net/browse/ABC-9" }), jira)).toBe("ABC-9");
    expect(ticketKeyFor(makeRun({ key: "explore-foo", url: "" }), jira)).toBe("explore-foo");
    // A record from a different source falls back to the record key.
    expect(ticketKeyFor(makeRun({ key: "FX-1", url: "https://fixture.test/t/FX-1" }), jira)).toBe("FX-1");
    // Whitespace-only after the marker: the real parser trims and treats the
    // empty result as "nothing found", falling back to the record key.
    expect(ticketKeyFor(makeRun({ key: "ABC-2", url: "https://x.atlassian.net/browse/   " }), jira)).toBe("ABC-2");
  });

  it("writes NOTHING when the setup wizard is cancelled at its last step", async () => {
    // The promise: cancelling setup leaves your configuration exactly as it was.
    // An already-configured user who opens "Run Setup…" from the palette sees no
    // prefilled value in either Jira box (placeHolder only), retypes both, then
    // presses Esc at "(3/3) Directory where your repo checkouts live" — and must
    // still have the site URL and project key they had before, with nothing to undo.
    //
    // This drives the REAL Jira connector, not the capability-free test fixture:
    // the fixture has no settings of its own, so a fixture-only version of this
    // assertion passes even while the shipped connector overwrites both settings
    // inside configure(). Zero `update` calls is the only form of this assertion
    // that can fail for the right reason.
    const update = vi.fn(async () => undefined);
    // Scoped with onTestFinished, not a bare mockReturnValue: `clearMocks` clears
    // call history but not implementations, so a replaced implementation is
    // otherwise only un-leaked by `resetVscodeMocks()`'s per-test restore over in
    // test/_setup.ts. Relying on that would make this file's isolation depend on a
    // distant setup file; `onTestFinished` restores even when an assertion throws,
    // so the stub cannot outlive this test by any path.
    //
    // Restored by re-installing the implementation rather than with spyOn +
    // mockRestore: `workspace.getConfiguration` is already a `vi.fn()`, and since
    // vitest 3 `mockRestore()` on a spy over a mock unwraps to the raw underlying
    // function instead of reinstating the mock. That leaves the shared vscode mock
    // a plain function, and the NEXT test dies in `resetVscodeMocks()` on
    // `getConfiguration.mockReset is not a function`.
    const configStub = vi.mocked(workspace.getConfiguration);
    const realConfig = configStub.getMockImplementation();
    configStub.mockReturnValue({
      get: vi.fn(() => ""),
      update,
      inspect: vi.fn(() => ({})),
    } as never);
    onTestFinished(() => {
      configStub.mockReset();
      if (realConfig) configStub.mockImplementation(realConfig);
    });
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("https://x.atlassian.net") // (1/3) site URL
      .mockResolvedValueOnce("ABC") // (2/3) project key
      .mockResolvedValueOnce(undefined); // (3/3) repos root — Esc

    const jira = makeJiraConnector({ secrets: fakeSecrets() } as never);
    const { context, globalState } = fakeContext();
    const ok = await runSetup(context, jira, () => {});

    expect(ok).toBe(false);
    expect(update).not.toHaveBeenCalled();
    // And nothing claims the wizard finished, so it can be re-run/re-offered.
    expect(globalState.get(SETUP_COMPLETE_KEY)).toBeUndefined();
  });

  it("keeps the released settings and command ids in the manifest", () => {
    type ConfigSection = { properties: Record<string, unknown> };
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    ) as {
      contributes: {
        configuration: ConfigSection | ConfigSection[];
        commands: { command: string }[];
      };
    };
    // The manifest may present settings as one section or several; the ids
    // users have in settings.json must survive either shape.
    const sections = Array.isArray(pkg.contributes.configuration)
      ? pkg.contributes.configuration
      : [pkg.contributes.configuration];
    const props = sections.flatMap((s) => Object.keys(s.properties));
    expect(new Set(props).size).toBe(props.length);
    for (const id of [
      "agentFlow.taskSource",
      "agentFlow.forge",
      "agentFlow.jira.baseUrl",
      "agentFlow.jira.project",
      "agentFlow.agileAccelerator.instanceUrl",
      "agentFlow.agileAccelerator.team",
      "agentFlow.agileAccelerator.targetOrg",
      "agentFlow.reposRoot",
      "agentFlow.workspaceDir",
      "agentFlow.githubOrg",
      "agentFlow.repoBlocklist",
      "agentFlow.defaultFilter",
      "agentFlow.filters.size",
      "agentFlow.filters.status",
      "agentFlow.filters.repo",
      "agentFlow.filters.search",
      "agentFlow.seedAgent",
      "agentFlow.agentProvider",
      "agentFlow.agentSurface",
      "agentFlow.workspaceMode",
      "agentFlow.openIn",
      "agentFlow.taskMode",
      "agentFlow.promptModes",
      "agentFlow.commands",
      "agentFlow.explorePrompt",
      "agentFlow.exploreMode",
      "agentFlow.explorePrompts.jiraTicket",
      "agentFlow.explorePrompts.knowledge",
      "agentFlow.explorePrompts.debug",
      "agentFlow.explorePrompts.general",
      "agentFlow.explorePrompts.supervise",
      "agentFlow.explorePrompts.verify",
      "agentFlow.exploreSlackDm",
      "agentFlow.environments",
      "agentFlow.prReviewStatus",
      "agentFlow.prReviewAutoFix",
      "agentFlow.deck.showTokenTotal",
      "agentFlow.prReviewPrompt",
      "agentFlow.worktree",
      "agentFlow.childWorktrees",
      "agentFlow.remoteControl",
      "agentFlow.batchLaunchConfirmThreshold",
      "agentFlow.trackOpenWindows",
      "agentFlow.prFacts",
      "agentFlow.openAgents",
      "agentFlow.deckGrouping",
      "agentFlow.retireFinishedAfterHours",
      "agentFlow.retireAbandonedAfterDays",
      "agentFlow.retireClosedAfterHours",
      "agentFlow.retireInPlaceAfterHours",
      "agentFlow.inflightShowAll",
      "agentFlow.notifyOnActionRequired",
      "agentFlow.prFactsTtlSeconds",
      "agentFlow.reviewRequests",
      "agentFlow.reviewRequestsAlwaysVisible",
      "agentFlow.reviewRequestsTtlSeconds",
      "agentFlow.reviewWrites",
      "agentFlow.mergeWrites",
      "agentFlow.mergeMethod",
      "agentFlow.orchestrator",
      "agentFlow.reviewRequestModes",
      "agentFlow.reviewRequestMode",
      "agentFlow.reviewOpenIn",
      "agentFlow.prWorkOpenIn",
      "agentFlow.reviewRequestPrompt",
      "agentFlow.stampLabelOnWrite",
      "agentFlow.provenanceLabel",
      "agentFlow.telemetry.enabled",
      "agentFlow.refetchIntervalMinutes",
    ]) {
      expect(props).toContain(id);
    }
    expect(pkg.contributes.commands.map((c) => c.command).sort()).toEqual([
      "agentFlow.doctor",
      "agentFlow.openDeck",
      "agentFlow.openMarketplace",
      "agentFlow.refresh",
      "agentFlow.scheduleTick",
      "agentFlow.setup",
      "agentFlow.signIn",
      "agentFlow.signOut",
      "agentFlow.takeTask",
    ]);
  });

  it("keeps the transmitted telemetry wire values", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../src/telemetry/events.ts"), "utf8");
    for (const wire of ['"jira_fetch"', '"jira_write"', '"jira_auth"', "has_jira_auth:"]) {
      expect(src).toContain(wire);
    }
  });

  it("freezes the gate flow's on-disk shape", () => {
    // Nothing else in this file guards the flow store's format. A gate node and
    // the answer stamped on its performer edge are read by every window and by
    // older builds, so their spelling is frozen here too — a frozen JSON STRING
    // run through the real read path (`readFlows`), not an object literal
    // asserted against itself, which would pass whether or not the store could
    // actually parse it.
    const files: Record<string, string> = {
      "/store/flows/f1.json": `${JSON.stringify({
        id: "f1", name: "f", armed: true, createdAt: 1,
        nodes: [{ id: "g", kind: "gate", x: 0, y: 0, join: "any", question: "deploy to prod?" }],
        edges: [{
          id: "ask1", from: "a", to: "g", cond: { kind: "pr-merged" },
          action: "ask", firedAt: 2, performed: true, gateAnswer: "approved",
        }],
      }, null, 2)}\n`,
    };
    const io: FlowIo = {
      readDir: (dir) => Object.keys(files).filter((p) => p.startsWith(dir + "/")).map((p) => path.basename(p)),
      readFile: (p) => files[p] ?? null,
      writeFile: (p, text) => { files[p] = text; },
      remove: (p) => { delete files[p]; },
    };
    const back = readFlows(io, "/store/flows")[0];
    expect(back.nodes[0]).toMatchObject({ kind: "gate", question: "deploy to prod?" });
    expect(back.edges[0]).toMatchObject({ action: "ask", gateAnswer: "approved" });
  });
});
