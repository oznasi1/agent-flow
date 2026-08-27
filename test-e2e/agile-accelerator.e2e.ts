import { test, expect } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost, openTasksView, tasksFrame } from "./_helpers/host";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

const WORK = {
  key: "W-9001",
  summary: "Telemetry panel shows stale numbers",
  id: "a0GE2E0000000001",
  assignee: "Ada Lovelace",
};

/** A stand-in for the Salesforce CLI, dropped into the sandbox's `bin` ahead of
 *  the real one on PATH (the same trick `open` and `claude` use).
 *
 *  This is the only place the Agile Accelerator connector's transport can be
 *  exercised for real. Its unit tests inject a fake `SfRunner`, which means
 *  `execSfRunner` — the ~30 lines that actually spawn a process — has never run
 *  in anger, and spec §14 forbids a unit test that spawns one. So the shim is
 *  deliberately shaped around the contract that code exists for:
 *
 *   - `sobject describe` for the PACKAGED candidate exits **non-zero with its
 *     JSON error envelope on stdout**, so the candidate loop has to survive a
 *     real failing process and fall through to the unmanaged object. Note this
 *     alone does NOT prove the envelope was *read* — the loop catches any
 *     rejection just the same, which I confirmed by mutation. The third journey
 *     is the one that pins the stdout contract.
 *   - the unmanaged `ADM_Work__c` then succeeds, so the org looks like the one
 *     GUS actually runs: no `agf__` namespace, a subset of the wanted fields.
 *
 *  Everything downstream — candidate fallback, describe-driven field
 *  intersection, the generated SOQL, record→Task mapping and the rendered card
 *  — is the shipped code path, unmocked. */
function writeSfShim(sb: Sandbox, opts: { queryError?: string } = {}): void {
  const record = JSON.stringify({
    Id: WORK.id,
    Name: WORK.key,
    Subject__c: WORK.summary,
    Status__c: "In Progress",
    Scrum_Team__c: "Falcons",
    Assignee__r: { Name: WORK.assignee },
    LastModifiedDate: "2026-08-21T00:00:00.000+0000",
  });
  const describeOk = JSON.stringify({
    status: 0,
    result: {
      name: "ADM_Work__c",
      // A realistic subset: Priority__c and Product_Tag__c are absent, so the
      // field intersection must simply not select them.
      fields: ["Id", "Name", "Subject__c", "Status__c", "Assignee__c", "Scrum_Team__c", "LastModifiedDate"].map(
        (name) => ({ name }),
      ),
    },
  });
  const notInstalled = JSON.stringify({
    status: 1,
    name: "NOT_FOUND",
    message: "sObject type 'agf__ADM_Work__c' is not supported.",
  });
  const userInfo = JSON.stringify({
    status: 0,
    result: { username: "e2e@fixture.invalid", id: "005E2E0000000001" },
  });

  // Every invocation is appended to a log so the test can assert on the REAL
  // argv the connector built — including that `--json` was appended once and
  // that the SOQL carries the team filter.
  const logPath = path.join(sb.root, "sf-calls.log");
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(logPath)}
case "$*" in
  *"org display user"*)
    printf '%s' ${shQuote(userInfo)}
    exit 0 ;;
  *"--sobject agf__ADM_Work__c"*)
    printf '%s' ${shQuote(notInstalled)}
    exit 1 ;;
  *"--sobject ADM_Work__c"*)
    printf '%s' ${shQuote(describeOk)}
    exit 0 ;;
  *"data query"*)
${
  opts.queryError
    ? `    printf '%s' ${shQuote(opts.queryError)}\n    exit 1 ;;`
    : `    printf '%s' ${shQuote(JSON.stringify({ status: 0, result: { records: [JSON.parse(record)] } }))}\n    exit 0 ;;`
}
esac
printf '%s' ${shQuote(JSON.stringify({ status: 1, name: "UNEXPECTED", message: "shim got an unhandled command" }))}
exit 1
`;
  const bin = path.join(sb.root, "bin");
  fs.writeFileSync(path.join(bin, "sf"), script, { mode: 0o755 });
}

/** Single-quote for /bin/sh, escaping any embedded single quote. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function sfCalls(sb: Sandbox): string[] {
  const p = path.join(sb.root, "sf-calls.log");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : [];
}

test.beforeEach(() => {
  sb = makeSandbox({
    "agentFlow.taskSource": "agileAccelerator",
    "agentFlow.agileAccelerator.instanceUrl": "https://gus.fixture.invalid",
    "agentFlow.agileAccelerator.team": "Falcons",
  });
  writeSfShim(sb);
});
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("the Agile Accelerator connector reads work items through a real `sf` process", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);

  // The card can only exist if the whole chain worked in the real host:
  // registry resolved agileAccelerator, the connector spawned `sf`, the first
  // describe's non-zero-exit-with-stdout-envelope was parsed rather than
  // thrown away, the second describe built a schema, the SOQL ran, and the
  // record mapped onto a Task.
  const card = frame.locator(".card", { hasText: WORK.key });
  await expect(card).toBeVisible({ timeout: 60_000 });
  await expect(card).toContainText(WORK.summary);
  await shot(page, testInfo, "1 · work item loaded through the sf CLI");

  const calls = sfCalls(sb);

  // The packaged candidate was tried first and its failure did NOT stop the
  // run — this is the execSfRunner contract, proven against a real process
  // exit rather than an injected fake.
  expect(calls.some((c) => c.includes("--sobject agf__ADM_Work__c"))).toBe(true);
  expect(calls.some((c) => c.includes("--sobject ADM_Work__c"))).toBe(true);

  // `--json` is appended by exec(), once, for every call — no call site can
  // forget it and get human-formatted output back.
  for (const c of calls) expect(c.endsWith("--json")).toBe(true);

  // The generated SOQL is schema-driven: it selects the fields the describe
  // advertised and skips the two it did not.
  const query = calls.find((c) => c.includes("data query"));
  expect(query, "the connector should have run a data query").toBeTruthy();
  expect(query).toContain("ADM_Work__c");
  expect(query).toContain("Subject__c");
  expect(query).not.toContain("Priority__c");
  expect(query).not.toContain("Product_Tag__c");

  // The team setting bounds the query rather than being decorative.
  expect(query).toContain("Falcons");
});

test("a missing `sf` gates the panel honestly instead of crashing it", async ({}, testInfo) => {
  test.setTimeout(180_000);

  // Remove the shim: `sf` is now genuinely absent from the sandbox PATH, which
  // is the state a user who has never installed the CLI is in.
  fs.rmSync(path.join(sb.root, "bin", "sf"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);

  // The sign-in gate is the discriminator, and it has to be THIS button rather
  // than a bare `.gate`: App.tsx renders a `.gate` for `authed === null` too
  // ("Connecting to…"), so asserting on the container alone passes while the
  // handshake is merely in flight. Only `authed === false` renders a sign-in
  // button, and with a working `sf` the panel goes straight to cards instead.
  // (Verified by mutation: leaving the shim in place must fail this test.)
  const signIn = frame.locator(".gate button", { hasText: "Sign in to Agile Accelerator" });
  await expect(signIn).toBeVisible({ timeout: 60_000 });

  // Only meaningful once the gate above has settled — a bare `toHaveCount(0)`
  // right after openTasksView passes instantly against an empty webview,
  // asserting nothing at all.
  await expect(frame.locator(".card")).toHaveCount(0);
  await shot(page, testInfo, "2 · no sf on PATH — gated, not crashed");

  // Nothing was spawned, because the binary was never located.
  expect(sfCalls(sb)).toEqual([]);
});

test("a failing query's JSON envelope on stdout reaches the user, not a generic error", async ({}, testInfo) => {
  test.setTimeout(180_000);

  // THE stdout-envelope contract, which is why cli.ts could not reuse the forge
  // seam's `Runner`: `sf` reports failures by exiting NON-ZERO and writing its
  // JSON envelope to STDOUT. A runner that discards stdout on a non-zero exit
  // still "works" for the candidate fallback in the first journey — the loop
  // catches any rejection identically — so that journey proves nothing here.
  // This one does: the envelope's own message can only reach the panel if
  // stdout was read and parsed after a non-zero exit.
  const envelope = JSON.stringify({
    status: 1,
    name: "INVALID_FIELD",
    message: "No such column 'Bogus__c' on entity 'ADM_Work__c'.",
  });
  writeSfShim(sb, { queryError: envelope });

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;

  await openTasksView(page);
  const frame = tasksFrame(page);

  const gateError = frame.locator(".gate-error");
  await expect(gateError).toBeVisible({ timeout: 60_000 });
  // The Salesforce message verbatim — not a stand-in, not a stringified exit code.
  await expect(gateError).toContainText("No such column 'Bogus__c'");
  await shot(page, testInfo, "3 · the sf error envelope, surfaced verbatim");

  // And it got there from a real failing process, not a pre-flight guard.
  expect(sfCalls(sb).some((c) => c.includes("data query"))).toBe(true);
});
