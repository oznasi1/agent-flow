import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { runCommand } from "./_helpers/palette";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

// The one file in this lane aimed at ORCHESTRATOR_COMMANDS.md § "Not yet proven",
// which states outright that the command path "has never run in [a real editor]":
// which shell you actually get, the settings write, and the chained shape end to
// end. Everything below drives the real host, so those three claims stop being
// assertions about a mock and become facts about a process, a file and a chain.

let sb: Sandbox;
let app: ElectronApplication | undefined;

/** Write a run record straight into the store. HOME is the sandbox, so this is
 *  the same path the extension writes — not a seam. Copied from
 *  `workflows.e2e.ts` (itself copied from `deck-lifecycle.e2e.ts`), which this
 *  file cannot import: neither helper is exported, and the fixtures are cheap
 *  enough that a shared module is not worth the coupling. */
function seedRun(sb: Sandbox, run: Record<string, unknown>): string {
  const dir = path.join(sb.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.key as string}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return file;
}

/** A card that renders as a `.card`, not a Recently-closed row — see
 *  `workflows.e2e.ts`'s `seedCard` for the full reasoning. The two facts this
 *  file leans on: `createdAt: Date.now()` is what keeps `shelf` off `"closed"`
 *  (so there is a clickable card with a drawer at all), and `repos[0]` is the
 *  sandbox's one real git checkout — which is BOTH what makes the `tree-clean`
 *  condition true (`gitState` reads a clean worktree, `conditions.ts`'s `git(c)`
 *  finds it by name) and the directory every command below actually runs in
 *  (`commandCwd`, deckView.ts: with no `cwdRepo`, the cwd is the source place's
 *  repo path in this run). */
function seedCard(sb: Sandbox, key: string) {
  return seedRun(sb, {
    key, summary: `Run ${key}`, url: `https://fixture.invalid/browse/${key}`,
    createdAt: Date.now(), kind: "task", mode: "per-window",
    repos: [{ name: "rocket", path: sb.repoPath, isGit: true, branch: "main" }],
    briefPaths: [],
  });
}

const flowsDir = (sb: Sandbox) => path.join(sb.home, ".agentflow", "flows");

/** Write a flow straight to `~/.agentflow/flows/<id>.json`. That directory IS
 *  the store (`defaultFlowsDir`, store.ts) and HOME is the sandbox, so this is
 *  the same file `writeFlow` writes — the seam `seedRun`/`seedTemplate` already
 *  use for runs and templates, not a shortcut around one.
 *
 *  Two shape rules `store.ts` enforces on the way back in, both load-bearing
 *  here: the filename must equal `<id>.json` (`readFlows` drops a record whose
 *  filename disagrees with its own `id`), and `id` must match `VALID_FLOW_ID`
 *  (`[A-Za-z0-9_-]+`). One rule is deliberately NOT exercised: no edge below
 *  carries an `action`. `writeFlow` fills it from the target on its next write,
 *  and a stored value that disagrees with the target is exactly what
 *  `latchActionMismatches` latches the edge dead for — so writing one by hand
 *  would sabotage the very rule under test. */
function seedFlow(sb: Sandbox, flow: Record<string, unknown>): string {
  const dir = flowsDir(sb);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${flow.id as string}.json`);
  fs.writeFileSync(file, JSON.stringify(flow, null, 2) + "\n");
  return file;
}

interface SeededEdge {
  id: string;
  from: string;
  to: string;
  cond: { kind: string };
  note?: string;
  firedAt?: number;
  firedNote?: string;
  performed?: true;
}

/** The flow as the store holds it right now. Every stamp this file asserts on —
 *  `firedAt`, `firedNote`, `error`, `gateAnswer`, `armed` — is read back through
 *  here, because the file is the durable record of what a pass decided. */
function readFlow(sb: Sandbox, id: string): {
  armed: boolean;
  commandConfirmedAt?: number;
  nodes: Record<string, unknown>[];
  edges: (SeededEdge & { error?: string; gateAnswer?: string })[];
} {
  return JSON.parse(fs.readFileSync(path.join(flowsDir(sb), `${id}.json`), "utf8"));
}

/** Every journal line for a flow, newest last. `.log.jsonl` beside the flow's
 *  own file (`journalPath`, journal.ts); one JSON object per line. Empty when
 *  the journal has never been written. */
function journal(sb: Sandbox, id: string): Record<string, unknown>[] {
  const p = path.join(flowsDir(sb), `${id}.log.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

/** The Agent Flow Deck output channel's text. VS Code backs every extension
 *  output channel with a real file under the session's log directory
 *  (`<user-data-dir>/logs/<session>/exthost…/output_logging_…/N-Agent Flow
 *  Deck.log`) — read as a file, the way `deck-merge.e2e.ts` does, rather than
 *  scraped out of the Output panel. Empty until the channel is written to. */
function outputChannelText(): string {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (n.endsWith("Agent Flow Deck.log")) hits.push(p);
    }
  };
  walk(path.join(sb.userDataDir, "logs"));
  return hits.map((p) => fs.readFileSync(p, "utf8")).join("\n");
}

/** The modal consent dialog — workbench chrome on the top-level page, outside
 *  every `iframe.webview`. `askFirstSpend` (deckView.ts:1508 on 2026-09-04)
 *  raises it with `showWarningMessage(message, { modal: true }, ACT, DISARM)`,
 *  and `window.dialogStyle: "custom"` (set in `boot` below) is what renders it
 *  as DOM Playwright can read and click instead of a native sheet. */
const dialog = (page: Page): Locator => page.locator(".monaco-dialog-box");

/** A workbench notification, toast or centre. `showInformationMessage` /
 *  `showErrorMessage` land here; the DECK's own in-webview toasts do not (see
 *  `deckToast`). */
const notifications = (page: Page, text: string | RegExp): Locator =>
  page.locator(".notification-list-item", { hasText: text });

/** The Deck's OWN toast, inside the webview — `<div className={`toast ${level}`}>`
 *  with a `.toast-msg` (DeckApp.tsx:1408-1411 on 2026-09-04). `this.toast(...)`
 *  in deckView.ts posts one of these, which is a different surface from a
 *  workbench notification and must not be confused for one: `flow:openOutput`'s
 *  three honest refusals are Deck toasts. */
const deckToast = (deck: Deck, text: string | RegExp): Locator =>
  deck.frame.locator(".toast", { hasText: text });

/** Base settings for every test here: the feature gate, plus the dialog style
 *  that makes the consent modal readable. */
function boot(extra: Record<string, unknown> = {}): Sandbox {
  return makeSandbox({
    // The setting this whole feature is gated behind — default off, per the
    // "ships inert" rule. Without it `postFlows` sends `enabled: false` with no
    // flows at all and every locator below times out.
    "agentFlow.orchestrator": true,
    // The once-per-flow shell consent these tests drive ("Run" / "Disarm" on a
    // single modal). It stopped being the default in 0.69 — the default asks per
    // command text with Run once / Run the next 5 / Always — so it is pinned
    // here rather than assumed; the mode itself is unchanged.
    "agentFlow.commandConsent": "flow",
    "window.dialogStyle": "custom",
    ...extra,
  });
}

/** Open the card, then the flow attached to it on the drawer's Canvas. Both
 *  halves are the real UI: the block's own Arm control lives on the card, and
 *  the resume gate ("Go") lives only on Canvas. */
async function openCard(deck: Deck, key: string): Promise<Locator> {
  await expect(deck.card(key)).toBeVisible({ timeout: 60_000 });
  await deck.card(key).click();
  const block = deck.workflowBlock();
  await expect(block).toBeVisible({ timeout: 30_000 });
  return block;
}

/** Arm from the card, then answer the resume gate on Canvas.
 *
 *  The gate is not optional and not a test artefact: ORCHESTRATOR_COMMANDS §
 *  "One pass" step 3 says the FIRST evaluation that finds rules already met
 *  "does not act. It reports them and waits for **Go**", and `advanceUnderLock`
 *  implements exactly that (`pendingResume` unless `resumeCleared` holds the
 *  flow). Every flow here is seeded with a condition that is already true, so
 *  every one of them is held once before it can ever act. `flow:resumeApprove`
 *  then calls `refreshBusy()`, so the pass that acts starts immediately rather
 *  than on the next 6 s poll. */
async function armAndGo(deck: Deck, block: Locator): Promise<Locator> {
  await expect(block.locator(".wf-chip")).toHaveText(/disarmed/i, { timeout: 30_000 });
  await block.getByRole("button", { name: "Arm" }).click();
  await block.getByRole("button", { name: /open in workflows/i }).click();
  const orch = deck.frame.locator(".orch-hd");
  await expect(orch).toBeVisible({ timeout: 30_000 });
  const resume = deck.frame.locator('[data-testid="orch-resume"]');
  // Up to two polls: the arm lands between ticks, and the pass that reports the
  // gate is the next one after it.
  await expect(resume).toBeVisible({ timeout: 60_000 });
  await resume.getByRole("button", { name: "Go" }).click();
  return orch;
}

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  sb?.dispose();
});

// ── notify ────────────────────────────────────────────────────────────────────

const NOTIFY_FLOW = (key: string) => ({
  id: "e2e-notify", name: "E2E Notify", armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "notify", message: "E2E-NOTIFY-OK" },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" } }],
});

// Mutation-checked: `isSettled` (model.ts) `return e.firedAt !== undefined || e.error
// !== undefined` → `return e.error !== undefined`, which is "fire on every pass" —
// the notify rule re-fired every 6 s, the journal grew a second `fired` line and the
// count assertion after the 15 s wait failed. That break is sabotage/orchestrator-nodes.patch.
test("a notify rule fires once, pops a VS Code notification and stamps a receipt", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-NOTE");
  seedFlow(sb, NOTIFY_FLOW("E2E-NOTE"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-NOTE");
  await shot(page, testInfo, "1 · the workflow, disarmed on its card");

  await armAndGo(deck, block);

  // `notifyLines` (runner.ts) composes `${flow.name}: ${message}`, and
  // `advanceUnderLock` raises it through `showInformationMessage` — deliberately
  // a workbench notification and not a webview toast, because "an unattended
  // flow fired it precisely because nobody is watching".
  await expect(notifications(page, "E2E Notify: E2E-NOTIFY-OK")).toBeVisible({ timeout: 60_000 });
  await shot(page, testInfo, "2 · the notification, in the user's own window");

  // The receipt on the rule — `performedNote`'s "told you: …", which is what the
  // doc's notify row means by "a receipt on the rule".
  await expect.poll(() => readFlow(sb, "e2e-notify").edges[0].firedNote, { timeout: 30_000 })
    .toBe("told you: E2E-NOTIFY-OK");
  const firedAt = readFlow(sb, "e2e-notify").edges[0].firedAt;
  expect(firedAt).toBeGreaterThan(0);
  expect(journal(sb, "e2e-notify").filter((l) => l.kind === "fired" && l.edge === "e1")).toHaveLength(1);

  // Fires ONCE. 15 s is two full polls plus margin, and the assertion of record
  // is the pair of durable facts: the latch's own timestamp did not move, and the
  // journal — an append-only file nothing rewrites — gained no second `fired`
  // line. A notification count alone could not say this: VS Code retires an
  // information toast on its own, so a re-fire and a dismissal look alike on
  // screen and not at all on disk.
  await page.waitForTimeout(15_000);
  expect(readFlow(sb, "e2e-notify").edges[0].firedAt).toBe(firedAt);
  expect(journal(sb, "e2e-notify").filter((l) => l.kind === "fired" && l.edge === "e1")).toHaveLength(1);

  // And the notification centre, which KEEPS what the toast area retires, holds
  // exactly one — the on-screen half of the same claim.
  await runCommand(page, "Notifications: Show Notifications");
  await expect(page.locator(".notifications-center .notification-list-item", { hasText: "E2E-NOTIFY-OK" }))
    .toHaveCount(1, { timeout: 15_000 });
  await shot(page, testInfo, "3 · one notification, one receipt, after two more polls");
});

// ── gate ──────────────────────────────────────────────────────────────────────

/** place —tree-clean→ gate —gate-approved→ notify. The gate is the only node
 *  whose state a PERSON rather than the world decides (`GateNode`, model.ts), so
 *  the notify terminal downstream is how "your answer moved the flow on" becomes
 *  something outside the flow file can see. */
const GATE_FLOW = (key: string) => ({
  id: "e2e-gate", name: "E2E Gate", armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "gate", question: "E2E-GATE-Q" },
    { id: "n3", x: 440, y: 0, join: "any", kind: "notify", message: "E2E-GATE-FIRED" },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" } },
    { id: "e2", from: "n2", to: "n3", cond: { kind: "gate-approved" } },
  ],
});

// Mutation-checked: `gateAnswer` (evaluate.ts) `return performer?.gateAnswer` →
// `return undefined`, so an approved gate never satisfied `gate-approved`; the
// downstream notification never appeared and the wait for it timed out.
test("a gate asks once and Approve fires the downstream rule", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-GATE");
  seedFlow(sb, GATE_FLOW("E2E-GATE"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-GATE");
  await armAndGo(deck, block);

  // The ask fires the moment the condition is met — `ask` spends nothing
  // (`isSpendAction` excludes it), so no consent modal stands between arming and
  // the question. `performedNote` stamps the question itself as the receipt,
  // because "a gate's whole receipt is the question".
  await expect.poll(() => readFlow(sb, "e2e-gate").edges[0].firedNote, { timeout: 60_000 })
    .toBe("asked you: E2E-GATE-Q");
  const asked = readFlow(sb, "e2e-gate");
  expect(asked.edges[0].performed).toBe(true);
  expect(asked.edges[1].firedAt).toBeUndefined();

  // Approve and Reject, on the gate node itself, with the question as their
  // accessible names (`OrchestratorDrawer.tsx`:2413-2419 on 2026-09-04).
  const approve = deck.frame.getByRole("button", { name: "Approve E2E-GATE-Q" });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await expect(deck.frame.getByRole("button", { name: "Reject E2E-GATE-Q" })).toBeVisible();
  // A gate asks IN THE DRAWER and nowhere else: no workbench notification is
  // raised for the question. Safe as a negative because the ask is already on
  // disk above — the pass that would have notified has been and gone.
  await expect(notifications(page, "E2E-GATE-Q")).toHaveCount(0);
  await shot(page, testInfo, "1 · the gate, asked and waiting on an answer");

  await approve.click();
  await expect.poll(() => readFlow(sb, "e2e-gate").edges[0].gateAnswer, { timeout: 30_000 }).toBe("approved");
  expect(journal(sb, "e2e-gate").filter((l) => l.kind === "answered" && l.answer === "approved")).toHaveLength(1);

  // The downstream rule reads that answer off the ask edge and fires — which is
  // the whole point of two nodes rather than one.
  await expect(notifications(page, "E2E Gate: E2E-GATE-FIRED")).toBeVisible({ timeout: 60_000 });
  const after = readFlow(sb, "e2e-gate");
  expect(after.edges[1].firedNote).toBe("told you: E2E-GATE-FIRED");
  // Latched: the ask was not re-posed to carry the answer forward, so its own
  // stamp is byte-identical to the one taken before Approve.
  expect(after.edges[0].firedAt).toBe(asked.edges[0].firedAt);
  expect(journal(sb, "e2e-gate").filter((l) => l.kind === "fired" && l.edge === "e1")).toHaveLength(1);
  await shot(page, testInfo, "2 · approved, and the downstream rule fired");
});

/** The same shape with nothing downstream: this spec is about the ask edge's own
 *  Reset, and a notify terminal would only add a rule that fires while the
 *  question is being re-posed. */
const GATE_ONLY_FLOW = (key: string) => ({
  id: "e2e-gate-reset", name: "E2E Gate Reset", armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "gate", question: "E2E-RESET-Q" },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" } }],
});

// Mutation-checked: `stripHostStamps` (model.ts) — the deny-list `flow:resetEdge`
// calls — with `delete kept.gateAnswer;` removed, so Reset cleared the receipt but
// left the answer behind; the re-asked edge read as already answered and the
// Approve button never came back.
test("Reset on the asking rule poses the gate's question again", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-GRST");
  seedFlow(sb, GATE_ONLY_FLOW("E2E-GRST"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-GRST");
  await armAndGo(deck, block);

  const approve = deck.frame.getByRole("button", { name: "Approve E2E-RESET-Q" });
  await expect(approve).toBeVisible({ timeout: 60_000 });
  await approve.click();
  await expect.poll(() => readFlow(sb, "e2e-gate-reset").edges[0].gateAnswer, { timeout: 30_000 }).toBe("approved");
  // Answered: the buttons are gone, because `gateStateOf` reports an answer and
  // both renders key off its absence.
  await expect(approve).toHaveCount(0);
  await shot(page, testInfo, "1 · answered, so the gate stops asking");

  // The Actions tray is how a node is SELECTED in either view — its identifier is
  // a real button whose accessible name is `Configure ${endLabel(...)}`, and
  // `endLabel` returns the bare word "gate" for a gate node
  // (orchestratorRule.ts:402 on 2026-09-04).
  await deck.frame.getByRole("button", { name: "Configure gate" }).click();
  const insp = deck.frame.locator('[data-testid="orch-node-inspector"]');
  await expect(insp).toContainText("approved");
  await insp.getByRole("button", { name: "Reset to ask again" }).click();

  // Reset drops the whole set of host stamps — receipt, performer flag and the
  // answer — so the next pass finds an unsettled rule whose condition is still
  // met and poses the question again. The assertion of record is the journal:
  // a SECOND `fired` line for the same edge, which is the one thing Reset's
  // "keeps your configuration, drops the record" promise makes visible on disk.
  await expect.poll(() => journal(sb, "e2e-gate-reset").filter((l) => l.kind === "fired" && l.edge === "e1").length,
    { timeout: 60_000 }).toBe(2);
  const reasked = readFlow(sb, "e2e-gate-reset");
  expect(reasked.edges[0].gateAnswer).toBeUndefined();
  expect(reasked.edges[0].firedNote).toBe("asked you: E2E-RESET-Q");
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "2 · the question, posed again");
});

// ── command ───────────────────────────────────────────────────────────────────

/** Three facts in one one-liner, all of them files on disk afterwards:
 *  - `pwd` — which directory the command ran in (`commandCwd`'s "the repo of the
 *    place the rule came from", with no `cwdRepo` set);
 *  - `$0` — WHICH SHELL. ORCHESTRATOR_COMMANDS § "Not yet proven" names this as
 *    unproven precisely because no shell is specified: it is Node's default, and
 *    `sh -c` reports its own path in `$0`;
 *  - the marker itself, through `tee` so the same bytes reach STDOUT as well and
 *    there is real output for the journal and the output channel to carry.
 *
 *  `$HOME` is the sandbox (launchHost points it there), so every path below is
 *  inside the temp root `sb.dispose()` removes. */
const CMD_RUN = (marker: string) =>
  `pwd > "$HOME/cwd.txt"; echo "$0" > "$HOME/shell.txt"; echo ${marker} | tee "$HOME/cmd.txt"`;

const COMMAND_FLOW = (id: string, name: string, key: string, run: string, extra: Record<string, unknown> = {}) => ({
  id, name, armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "command", run },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" } }],
  ...extra,
});

const fileText = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

// Mutation-checked: `spendTarget`'s `run` arm (deckView.ts) `return { action: "run",
// … }` → `return undefined`, which is the documented "run without consent" break:
// the command ran unattended on the pass after Go, the dialog never appeared, and
// the wait for it timed out.
test("a command node asks consent and act runs it through /bin/sh", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-CMD");
  seedFlow(sb, COMMAND_FLOW("e2e-cmd", "E2E Command", "E2E-CMD", CMD_RUN("E2E-CMD-OK")));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-CMD");
  await armAndGo(deck, block);

  // Consent gate two of two. `commandConfirmedAt` is absent on this flow, so the
  // first `run` it would attempt asks — and the modal names the RESOLVED COMMAND
  // TEXT, not the node's label, because approving "Deploy" is not approving
  // `deploy.sh --env=prod`.
  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 60_000 });
  await expect(box).toContainText("E2E Command is ready to run");
  await expect(box).toContainText("echo E2E-CMD-OK | tee");
  // "It will still ask before it starts a session" — this answer authorises shell
  // and nothing else, which is the whole reason the two gates are separate.
  await expect(box).toContainText("before it starts a session");
  // The pass that asks performs NOTHING. Nothing has run at this point, and the
  // modal is still up — so this is the state of the machine, not a race.
  expect(fileText(path.join(sb.home, "cmd.txt"))).toBe("");
  expect(readFlow(sb, "e2e-cmd").commandConfirmedAt).toBeUndefined();
  await shot(page, testInfo, "1 · the consent dialog names the command text");

  // `ACT` is "Run" for a command (`askFirstSpend`, deckView.ts:1466) — "Act" is
  // this spec's own word, not the button's.
  await box.getByRole("button", { name: "Run" }).click();
  await expect.poll(() => readFlow(sb, "e2e-cmd").commandConfirmedAt, { timeout: 30_000 }).toBeGreaterThan(0);

  // THE assertion of record: a file this machine's shell wrote.
  await expect.poll(() => fileText(path.join(sb.home, "cmd.txt")), { timeout: 90_000 }).toContain("E2E-CMD-OK");
  // /bin/sh, read out of the process itself rather than assumed from the platform.
  expect(fileText(path.join(sb.home, "shell.txt")).trim()).toBe("/bin/sh");
  // …in the source place's checkout. `fs.realpathSync` on both sides: the sandbox
  // root is under /var, which is a symlink to /private/var on macOS, and `pwd`
  // reports the resolved path.
  expect(fs.realpathSync(fileText(path.join(sb.home, "cwd.txt")).trim()))
    .toBe(fs.realpathSync(sb.repoPath));

  // The receipt names the command and the repo — "ran deploy" in a flow touching
  // three checkouts does not say what happened.
  const done = readFlow(sb, "e2e-cmd");
  expect(done.edges[0].firedNote).toMatch(/^ran .* in rocket$/);
  expect(done.edges[0].error).toBeUndefined();

  // The journal carries the whole gesture: asked, answered, ran — with the
  // command's own stdout on the `fired` line, which is what `flow:openOutput`
  // later reads back.
  const lines = journal(sb, "e2e-cmd");
  expect(lines.filter((l) => l.kind === "consent-asked" && l.action === "run")).toHaveLength(1);
  expect(lines.filter((l) => l.kind === "consented" && l.answer === "act")).toHaveLength(1);
  const fired = lines.filter((l) => l.kind === "fired" && l.edge === "e1");
  expect(fired).toHaveLength(1);
  expect(fired[0].action).toBe("run");
  expect(String(fired[0].output)).toContain("E2E-CMD-OK");
  // And the output channel, the other half of "read the output" — a real file
  // under the session's log directory.
  expect(outputChannelText()).toContain("running: pwd > ");
  await shot(page, testInfo, "2 · ran, with a receipt and its output journalled");
});

// Mutation-checked: `askFirstSpend`'s (deckView.ts) `else if (answer === DISARM)`
// arm deleted, so Disarm wrote nothing; the flow stayed armed, the next pass asked
// again and the poll for `armed: false` timed out.
test("disarm in the consent dialog disarms the flow", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-CDIS");
  seedFlow(sb, COMMAND_FLOW("e2e-cmd-disarm", "E2E Disarm", "E2E-CDIS", CMD_RUN("E2E-DISARM-RAN")));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-CDIS");
  await armAndGo(deck, block);

  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 60_000 });
  await shot(page, testInfo, "1 · the dialog, before Disarm");
  await box.getByRole("button", { name: "Disarm" }).click();

  // Disarm writes `armed: false` and NOTHING else: no consent stamp, so a later
  // re-arm asks again rather than inheriting an approval nobody gave.
  await expect.poll(() => readFlow(sb, "e2e-cmd-disarm").armed, { timeout: 30_000 }).toBe(false);
  expect(readFlow(sb, "e2e-cmd-disarm").commandConfirmedAt).toBeUndefined();
  expect(journal(sb, "e2e-cmd-disarm").filter((l) => l.kind === "consented" && l.answer === "disarm"))
    .toHaveLength(1);

  // Two more polls' worth of nothing happening. A disarmed flow is not evaluated
  // at all (`evaluateFlow` returns empty for `!flow.armed`), so the file the
  // command would have written never appears.
  await page.waitForTimeout(15_000);
  expect(fileText(path.join(sb.home, "cmd.txt"))).toBe("");
  expect(readFlow(sb, "e2e-cmd-disarm").edges[0].firedAt).toBeUndefined();
  await shot(page, testInfo, "2 · disarmed, and nothing ran");
});

// ── neverAutoRun ──────────────────────────────────────────────────────────────

// Mutation-checked: `runCommand`'s (command.ts) `const blocked = blockedBy(resolved.text,
// neverAutoRun ?? [])` → `const blocked: string | undefined = undefined`, i.e. the last
// line before the shell removed while `spendTarget`'s courtesy refusal stayed. `rm -f`
// then really ran under the stored approval, so the rule latched FIRED rather than
// errored and the wait for the pattern in `edges[0].error` timed out.
test("neverAutoRun outranks approval", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot({ "agentFlow.neverAutoRun": ["*rm -f*"] });
  seedCard(sb, "E2E-NAR");
  // The flow ALREADY carries the shell approval — this is the "whatever you
  // approved" half of the claim. Without it the refusal would be indistinguishable
  // from a flow that was simply never consented to.
  seedFlow(sb, COMMAND_FLOW(
    "e2e-never", "E2E Never", "E2E-NAR",
    `rm -f "$HOME/never.txt"`,
    { commandConfirmedAt: Date.now() },
  ));
  const marker = path.join(sb.home, "never.txt");
  fs.writeFileSync(marker, "E2E-NEVER-SURVIVED\n");

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-NAR");
  await armAndGo(deck, block);

  // The rule latches ERRORED, and the message names the PATTERN — the user's next
  // move is editing one line of settings.json and they have to know which.
  await expect.poll(() => readFlow(sb, "e2e-never").edges[0].error, { timeout: 90_000 })
    .toContain('matches the agentFlow.neverAutoRun pattern "*rm -f*"');
  // No `firedAt`: an errored edge is settled without ever having been a success,
  // so it needs a Reset rather than reading as already done.
  expect(readFlow(sb, "e2e-never").edges[0].firedAt).toBeUndefined();

  // THE assertion of record: the file `rm -f` would have deleted is untouched.
  expect(fs.readFileSync(marker, "utf8")).toBe("E2E-NEVER-SURVIVED\n");

  // And no consent was ever offered for it. `spendTarget` refuses a blocked
  // command, so the modal is never raised — "asking someone to approve a command
  // that cannot run either teaches them the approval is theatre or reads as a
  // promise that saying yes will run it". Safe as a negative: the refusal is
  // already on disk above, so the pass that would have asked is over.
  await expect(dialog(page)).toHaveCount(0);
  expect(journal(sb, "e2e-never").filter((l) => l.kind === "consent-asked")).toHaveLength(0);
  expect(journal(sb, "e2e-never").filter((l) => l.kind === "errored" && l.edge === "e1")).toHaveLength(1);

  // The failure escalates past the Deck's own toast to a workbench notification —
  // "failed and stopped" must not die inside an unfocused panel.
  await expect(notifications(page, /neverAutoRun pattern/)).toBeVisible({ timeout: 30_000 });
  // …and the card's chip says the workflow is stopped, not advancing.
  await expect(deck.boardWorkflowChip("E2E-NAR")).toHaveClass(/stopped/, { timeout: 30_000 });
  await shot(page, testInfo, "1 · refused, named, and the file survived");
});

// ── chained commands ──────────────────────────────────────────────────────────

/** The feature's own headline example: `place → deploy.sh → smoke.sh`.
 *  Both commands append to ONE file, so the order they ran in is a fact about
 *  that file's bytes rather than about two timestamps. The second also records
 *  its `pwd`, which is the only way to see that it inherited the first one's
 *  directory — a command node is not a place, so without `chainSourcePlace`'s
 *  walk back through the chain the second rule has no directory at all. */
const CHAIN_FLOW = (key: string) => ({
  id: "e2e-chain", name: "E2E Chain", armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "command", run: `echo one >> "$HOME/chain.txt"` },
    {
      id: "n3", x: 440, y: 0, join: "any", kind: "command",
      run: `pwd > "$HOME/chain2-cwd.txt"; echo two >> "$HOME/chain.txt"`,
    },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" } },
    { id: "e2", from: "n2", to: "n3", cond: { kind: "command-succeeded" } },
  ],
});

// Mutation-checked: `chainSourcePlace` (command.ts) `if (node.kind !== "command") return
// undefined` → `if (true) return undefined`, so the walk back through the chain never
// went THROUGH a command node to reach a place. The second rule then hit `commandCwd`'s
// "nothing upstream of n2 is a place" refusal, `chain.txt` stopped at "one" and the
// `toBe("one\ntwo\n")` poll timed out.
test("command succeeded chains a second command", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-CHN");
  seedFlow(sb, CHAIN_FLOW("E2E-CHN"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-CHN");
  await armAndGo(deck, block);

  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 60_000 });
  await box.getByRole("button", { name: "Run" }).click();

  // Both commands' output, in one file, in the order they ran. `command-succeeded`
  // reads the receipt the FIRST rule stamped, which cannot exist until the first
  // command has finished — so this ordering is the condition working, not a race
  // that happened to resolve this way.
  await expect.poll(() => fileText(path.join(sb.home, "chain.txt")), { timeout: 120_000 })
    .toBe("one\ntwo\n");

  // The second command inherited the first one's directory.
  expect(fs.realpathSync(fileText(path.join(sb.home, "chain2-cwd.txt")).trim()))
    .toBe(fs.realpathSync(sb.repoPath));

  const flow = readFlow(sb, "e2e-chain");
  expect(flow.edges[0].performed).toBe(true);
  expect(flow.edges[1].firedNote).toMatch(/^ran .* in rocket$/);
  expect(flow.edges[1].error).toBeUndefined();
  // ONE consent for the whole chain: the gate is per flow, not per command node,
  // which is exactly why `agentFlow.neverAutoRun` exists as the finer brake.
  expect(journal(sb, "e2e-chain").filter((l) => l.kind === "consent-asked")).toHaveLength(1);
  expect(journal(sb, "e2e-chain").filter((l) => l.kind === "fired")).toHaveLength(2);
  await shot(page, testInfo, "1 · both commands ran, in order, in one checkout");
});

// ── reading the output back ───────────────────────────────────────────────────

/** Leave the drawer and come back to the card. The Output button lives on the
 *  card's own Workflow block, not in the drawer — and `onOpenWorkflow` cleared
 *  the card selection on the way in (`DeckApp.tsx`:1585 on 2026-09-04), so the
 *  card has to be clicked again rather than merely revealed. */
async function backToCard(deck: Deck, key: string): Promise<Locator> {
  await deck.frame.locator(".orch-hd").getByRole("button", { name: "Close" }).click();
  await expect(deck.frame.locator(".orch-hd")).toHaveCount(0);
  return openCard(deck, key);
}

/** Every editor tab in the workbench. The Deck itself is one (a webview panel in
 *  the editor area), so this is never empty — which is exactly why the negative
 *  in the toast spec below counts UNTITLED tabs rather than tabs. */
const untitledTabs = (page: Page): Locator => page.locator(".tabs-container .tab", { hasText: /Untitled/ });

// Mutation-checked: `flow:openOutput` (deckView.ts) `const result = findEdgeOutput(events,
// m.edgeId)` → `findEdgeOutput([], m.edgeId)`, so the journal it had just read was
// thrown away: the handler took the `no-journal` refusal, no tab opened and the wait
// for the Untitled tab timed out.
test("a rule's output opens in an editor tab", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-OUT");
  seedFlow(sb, COMMAND_FLOW("e2e-out", "E2E Output", "E2E-OUT", CMD_RUN("E2E-OUTPUT-OK")));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  await armAndGo(deck, await openCard(deck, "E2E-OUT"));
  await dialog(page).getByRole("button", { name: "Run" }).click();
  await expect.poll(() => fileText(path.join(sb.home, "cmd.txt")), { timeout: 90_000 }).toContain("E2E-OUTPUT-OK");

  const block = await backToCard(deck, "E2E-OUT");
  // Offered on the `done` step of a rule whose target is a command node, and on
  // no other rule kind — a launch, a seed, a notify or a gate's ask has no output
  // to read (`canShowOutput`, WorkflowBlock.tsx:127 on 2026-09-04).
  const output = block.getByRole("button", { name: "Output" });
  await expect(output).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "1 · the done step offers Output");
  await output.click();

  // Its own editor tab, never back across the wire to the 620px drawer.
  await expect(untitledTabs(page)).toHaveCount(1, { timeout: 30_000 });
  const editor = page.locator(".part.editor .monaco-editor").first();
  // The one-line provenance header — `${kind} · ${action} · ${edgeId} · ${when}` —
  // so two Output tabs do not read as the same undifferentiated blob.
  await expect(editor).toContainText("fired · run · e1", { timeout: 15_000 });
  // …and the command's actual stdout, read back out of the journal.
  await expect(editor).toContainText("E2E-OUTPUT-OK");
  await shot(page, testInfo, "2 · the journal's copy, in a tab of its own");
});

/** A command rule stamped fired on disk, on a flow that is NEVER armed — so no
 *  pass ever runs and no journal is ever written. That is the one state
 *  `findEdgeOutput`'s `no-journal` refusal is about, and the honest way to reach
 *  it: the step reads `done` (its `firedAt` says so) with nothing behind it. */
const NO_JOURNAL_FLOW = (key: string) => ({
  id: "e2e-nojournal", name: "E2E No Journal", armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "command", run: `echo E2E-NEVER-RAN` },
  ],
  edges: [{
    id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" },
    firedAt: Date.now(), firedNote: "ran echo E2E-NEVER-RAN in rocket", performed: true as const,
  }],
});

// Mutation-checked: `findEdgeOutput` (journal.ts) `if (events.length === 0) return { ok:
// false, reason: "no-journal" }` → `return { ok: true, output: "", … }`, which is the
// blank tab this spec's title forbids: no toast appeared and `untitledTabs`
// went to 1.
test("with nothing journaled the output action is a toast, never a blank tab", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-NOJ");
  seedFlow(sb, NO_JOURNAL_FLOW("E2E-NOJ"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-NOJ");
  // Nothing on disk to read back: the flow was never armed, so no pass recorded
  // anything for it.
  expect(journal(sb, "e2e-nojournal")).toEqual([]);
  await expect(untitledTabs(page)).toHaveCount(0);

  const output = block.getByRole("button", { name: "Output" });
  await expect(output).toBeVisible({ timeout: 30_000 });
  await output.click();

  // One of three honest refusals, and this is the one that also covers a journal
  // that failed to read — `readJournal` cannot tell the two apart, and the
  // wording says so rather than claiming certainty.
  await expect(deckToast(deck, /Nothing has been recorded for this workflow yet/))
    .toBeVisible({ timeout: 10_000 });
  await expect(untitledTabs(page)).toHaveCount(0);
  await shot(page, testInfo, "1 · a toast, and no tab");
});

// ── Save to settings ──────────────────────────────────────────────────────────

const SAVE_RUN = "echo E2E-SAVED-CMD";

const SAVE_FLOW = (key: string) => ({
  id: "e2e-save", name: "E2E Save", armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "command", run: SAVE_RUN },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" } }],
});

const settingsJson = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(sb.userDataDir, "User", "settings.json"), "utf8"));

// Mutation-checked: `saveCommand` (deckView.ts) `const entries = authored ?? [...DEFAULT_COMMANDS]`
// → `const entries = authored ?? []`, the exact break the doc's second bullet warns
// about ("an explicit array replaces the default, and writing just your command
// would have dropped the example out of the picker"). The shipped `verify-on-dev`
// example vanished from settings.json and the `toContain("verify-on-dev")` failed.
test("Save to settings writes agentFlow.commands into the real settings.json", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-SAVE");
  seedFlow(sb, SAVE_FLOW("E2E-SAVE"));
  // The setting is UNTOUCHED to begin with — which is the case the doc's "seeded
  // from the shipped example first" rule is about.
  expect(settingsJson()["agentFlow.commands"]).toBeUndefined();

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-SAVE");
  await block.getByRole("button", { name: /open in workflows/i }).click();
  await expect(deck.frame.locator(".orch-hd")).toBeVisible({ timeout: 30_000 });

  // The Actions tray is how a node is selected in either view; a free-text
  // command node's own identifier IS its command text (`commandLabel`,
  // orchestratorRule.ts:380 on 2026-09-04, under the 24-char cap here).
  await deck.frame.getByRole("button", { name: `Configure ${SAVE_RUN}` }).click();
  const insp = deck.frame.locator('[data-testid="orch-node-inspector"]');
  await expect(insp).toBeVisible({ timeout: 15_000 });
  await insp.getByLabel("Name for settings").fill("E2E Deploy");
  await shot(page, testInfo, "1 · a free-text command, named");
  await insp.getByRole("button", { name: "Save to settings" }).click();

  // THE assertion of record, and the reason this spec exists: ORCHESTRATOR_COMMANDS
  // § "Not yet proven" said this path had "only ever run against a mock
  // configuration, never a real `settings.json`". This is a real one.
  await expect.poll(() => JSON.stringify(settingsJson()["agentFlow.commands"] ?? null), { timeout: 30_000 })
    .toContain("E2E Deploy");
  const saved = settingsJson()["agentFlow.commands"] as { id: string; label: string; run: string }[];
  // The list GAINED an entry: the shipped example is still in front of it, because
  // an explicit array replaces the default and writing only the new command would
  // have dropped the example out of the picker the user was looking at.
  expect(saved.map((c) => c.id)).toEqual(["verify-on-dev", "e2e-deploy"]);
  expect(saved[1]).toEqual({ id: "e2e-deploy", label: "E2E Deploy", run: SAVE_RUN });

  // The NODE is left as free text. Saving means "keep this for next time", not
  // "rewire this node" — and `resolveCommand` refuses a node carrying both.
  const node = readFlow(sb, "e2e-save").nodes[1];
  expect(node.run).toBe(SAVE_RUN);
  expect(node.commandId).toBeUndefined();

  // Once the text matches an entry the Save row gives way to the honest end
  // state, which is also why pressing Save twice cannot fill the picker with
  // duplicates.
  await expect(deck.frame.locator('[data-testid="orch-command-saved"]'))
    .toContainText("Saved in settings as", { timeout: 30_000 });
  await expect(deck.frame.locator('[data-testid="orch-command-saved"]')).toContainText("E2E Deploy");
  await expect(insp.getByRole("button", { name: "Save to settings" })).toHaveCount(0);
  await shot(page, testInfo, "2 · saved, in the scope that holds the setting");
});

// ── the card's own gate buttons ─────────────────────────────────────────────
// GUIDE § The Deck: "the node shows **Approve** and **Reject**", and the card
// drawer's Workflow block renders exactly those two buttons for a `you` step.
//
// This test was pinned with `test.fail()` when it was written, because clicking
// them did nothing: `WorkflowBlock` sent `step.edgeId`, and a `you` step's edge
// points AWAY from the gate (`evaluate.ts` posts `awaiting-answer` against
// `e.from`), while `flow:answerGate` accepts only the edge that ASKED — so the
// write was silently dropped and the question stayed open. The Orchestrator
// drawer was unaffected, which is why nothing else caught it, and both unit
// tests missed the seam from opposite sides.
//
// The fix extracted `gateAskEdge` (model.ts) as the one definition of that edge
// and pointed all three surfaces at it. The pin is gone; this now proves the
// card's buttons work.
test("Approve on the card's own workflow block answers the gate", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-GATE");
  seedFlow(sb, GATE_FLOW("E2E-GATE"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-GATE");
  await armAndGo(deck, block);

  // Wait for the ask on disk, so the buttons below are the real waiting state
  // rather than a half-rendered pass.
  await expect.poll(() => readFlow(sb, "e2e-gate").edges[0].firedNote, { timeout: 60_000 })
    .toBe("asked you: E2E-GATE-Q");

  // Back to the card, where the block's `you` step carries the two buttons.
  await backToCard(deck, "E2E-GATE");
  const cardBlock = deck.workflowBlock();
  const approve = cardBlock.locator(".wf-step.wf-you .dd-pact", { hasText: "Approve" });
  await expect(approve).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, "1 · the card's own Approve, as the guide describes it");

  await approve.click();

  // The answer lands on the ASK edge — edges[0] — which is the edge the drawer
  // has always written and the only one the engine reads back through.
  await expect.poll(() => readFlow(sb, "e2e-gate").edges[0].gateAnswer, { timeout: 30_000 })
    .toBe("approved");
  // And the downstream rule fires on it, which is what makes the answer real
  // rather than merely recorded.
  await expect(notifications(page, "E2E Gate: E2E-GATE-FIRED")).toBeVisible({ timeout: 60_000 });
  await shot(page, testInfo, "2 · answered from the card, and the downstream rule fired");
});

// ── the picker ────────────────────────────────────────────────────────────────

/** Three configured commands, so the picker has something to filter and to tick
 *  more than once. `detail` is distinct from every label on purpose: the doc
 *  claims search spans BOTH lines a row prints, and a query that matched a label
 *  would not prove that. */
const PICK_COMMANDS = [
  { id: "e2e-deploy", label: "E2E Deploy", run: "echo deploy", detail: "stage the release" },
  { id: "e2e-smoke", label: "E2E Smoke", run: "echo smoke", detail: "walk the launch pad" },
  { id: "e2e-other", label: "E2E Other", run: "echo other" },
];

/** A one-node flow, so the drawer has a Canvas to open and the picker's Graph
 *  bar renders. No edges: nothing here evaluates, arms or fires. */
const PICK_FLOW = (key: string) => ({
  id: "e2e-pick", name: "E2E Pick", armed: false, createdAt: Date.now(),
  nodes: [{ id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" }],
  edges: [],
});

// Mutation-checked: OrchestratorDrawer.tsx `addCommands` — `next = addCommandNode(next, …)` → `next = addCommandNode(flow, …)`, the exact "one node per trip" regression the fold exists to prevent; only the last tick survived, the flow held 2 nodes instead of 3 and the count assertion failed.
test("Add command is a search-and-tick list that creates one node per tick in a single write", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot({ "agentFlow.commands": PICK_COMMANDS });
  seedCard(sb, "E2E-PICK");
  seedFlow(sb, PICK_FLOW("E2E-PICK"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-PICK");
  await block.getByRole("button", { name: /open in workflows/i }).click();
  await expect(deck.frame.locator(".orch-hd")).toBeVisible({ timeout: 30_000 });

  // The trigger is a `MultiCombo`, not a menu (combo.tsx:145-155): a button that
  // opens a listbox, addressed by its aria-label so the "+ Add place…" combo
  // beside it cannot be mistaken for it.
  await deck.frame.getByRole("button", { name: "Add a command" }).click();
  const pop = deck.frame.locator(".combo-pop");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  // One tickable row per configured command, and NOT one for free text — that is
  // the picker's footer action (combo.tsx:206-215), which is the doc's own point.
  await expect(pop.getByRole("option")).toHaveCount(3);
  await expect(pop.locator(".combo-foot").getByRole("button", { name: "Free-text command…" })).toBeVisible();
  await shot(page, testInfo, "3 · three tickable commands, free text in the footer");

  // Search spans both printed lines: "release" appears only in E2E Deploy's
  // `detail`, so a label-only filter would find nothing here.
  const search = pop.getByLabel("Filter commands…");
  await search.fill("release");
  await expect(pop.getByRole("option")).toHaveCount(1);
  await pop.getByRole("option").first().click();
  await expect(pop.getByRole("option").first()).toHaveAttribute("aria-selected", "true");

  // Ticks accumulate across queries — the whole reason this is a list and not a
  // menu. A second query, a second tick, one Add.
  await search.fill("Smoke");
  await expect(pop.getByRole("option")).toHaveCount(1);
  await pop.getByRole("option").first().click();
  await expect(pop.locator(".combo-n")).toHaveText("2 selected");
  await shot(page, testInfo, "4 · two ticked across two queries");
  await pop.locator(".combo-add").click();

  // ONE node per tick. `commit` orders values by the options list, not by tick
  // order (combo.tsx:136-141), so deploy precedes smoke whatever was clicked
  // first.
  await expect.poll(() => readFlow(sb, "e2e-pick").nodes.length, { timeout: 30_000 }).toBe(3);
  const nodes = readFlow(sb, "e2e-pick").nodes as { id: string; kind: string; commandId?: string; y: number }[];
  expect(nodes.slice(1).map((n) => [n.kind, n.commandId])).toEqual([
    ["command", "e2e-deploy"],
    ["command", "e2e-smoke"],
  ]);
  // A SINGLE write, and this is the observable difference: `addCommandNode`
  // mints both `id` and `y` from the flow it is handed (orchestratorRule.ts:765-773),
  // so two independent writes off the same flow would collide on both. Distinct
  // ids and distinct rows is the fold having happened.
  expect(nodes[1].id).not.toBe(nodes[2].id);
  expect(nodes[1].y).not.toBe(nodes[2].y);
  await shot(page, testInfo, "5 · two command nodes on the canvas");
});

// Mutation-checked: OrchestratorDrawer.tsx `attachMany` — folded over `flow` instead of its own output, the same break as the command picker's; only one place node landed and the count assertion failed.
test("Add place is a search-and-tick list too, ticking two places in one write", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  // Two more cards, so `placeCandidates` (OrchestratorDrawer.tsx:124-136) has
  // two rows: one per (run, repo) pair not already in the flow. The flow's own
  // node already holds E2E-PICK/rocket, so that pair is deduped out.
  seedCard(sb, "E2E-PICK");
  seedCard(sb, "E2E-PLACE1");
  seedCard(sb, "E2E-PLACE2");
  seedFlow(sb, PICK_FLOW("E2E-PICK"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-PICK");
  await block.getByRole("button", { name: /open in workflows/i }).click();
  await expect(deck.frame.locator(".orch-hd")).toBeVisible({ timeout: 30_000 });

  // The place picker lives on the LIST view's Add bar only
  // (OrchestratorDrawer.tsx:2205-2212) — the Canvas's Graph bar carries Tidy,
  // Notify, Gate, planned work and the command picker, but no place one. The
  // drawer opens on Canvas, so switch views first. (`+ Add place…` is also
  // hidden outright while a TEMPLATE is being edited; this is a workflow.)
  await deck.orchFlowViewTab("List").click();
  await deck.frame.getByRole("button", { name: "Add a place" }).click();
  const pop = deck.frame.locator(".combo-pop");
  await expect(pop).toBeVisible({ timeout: 15_000 });
  await expect(pop.getByRole("option")).toHaveCount(2);
  // The repo lives on the row's SECOND line, and the search reaches it — "a
  // place's repo is findable and not merely visible".
  await pop.getByLabel("Filter places…").fill("rocket");
  await expect(pop.getByRole("option")).toHaveCount(2);
  await pop.getByRole("option").nth(0).click();
  await pop.getByRole("option").nth(1).click();
  await expect(pop.locator(".combo-n")).toHaveText("2 selected");
  await pop.locator(".combo-add").click();

  await expect.poll(() => readFlow(sb, "e2e-pick").nodes.length, { timeout: 30_000 }).toBe(3);
  const nodes = readFlow(sb, "e2e-pick").nodes as { id: string; kind: string; runKey?: string; y: number }[];
  expect(nodes.slice(1).map((n) => n.kind)).toEqual(["place", "place"]);
  expect(new Set(nodes.slice(1).map((n) => n.runKey))).toEqual(new Set(["E2E-PLACE1", "E2E-PLACE2"]));
  expect(nodes[1].id).not.toBe(nodes[2].id);
  await shot(page, testInfo, "6 · two place nodes from one Add");
});
