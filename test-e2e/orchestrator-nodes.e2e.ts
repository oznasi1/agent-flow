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
