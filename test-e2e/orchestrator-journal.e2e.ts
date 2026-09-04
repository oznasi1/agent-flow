import { expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

// The file aimed at docs/FLOW_JOURNAL.md. Every claim it makes about the journal
// is a claim about a FILE — `~/.agentflow/flows/<id>.log.jsonl` — written by a
// pass that really ran, so the assertions here are almost all reads of that file
// after driving the real UI. Three things only a real host can say:
//
//  - the four events of one gesture land in write order, each line self-
//    describing (`id`, `at`, `flow`, `sum`);
//  - deleting the flow really does leave the journal behind (`removeFlow`
//    deletes `<id>.json` alone — the doc's "the moment you most want the
//    history is usually just after you deleted the thing that produced it");
//  - a hand-mangled `sum` costs that one line and nothing else, read back
//    through the product's OWN reader rather than through a unit double.
//
// The pure half of all three is already unit-tested (`journal.test.ts`); what is
// unproven below the host is that the panel wires them up at all.

let sb: Sandbox;
let app: ElectronApplication | undefined;

/** Write a run record straight into the store. HOME is the sandbox, so this is
 *  the same path the extension writes — not a seam. Copied from
 *  `orchestrator-nodes.e2e.ts` (itself copied from `workflows.e2e.ts`), which
 *  this file cannot import: neither helper is exported, and the fixtures are
 *  cheap enough that a shared module is not worth the coupling. */
function seedRun(sb: Sandbox, run: Record<string, unknown>): string {
  const dir = path.join(sb.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.key as string}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return file;
}

/** A card that renders as a `.card`, not a Recently-closed row. Two facts this
 *  file leans on, both spelled out in `orchestrator-nodes.e2e.ts`'s copy:
 *  `createdAt: Date.now()` is what keeps the run off the closed shelf (so there
 *  is a clickable card with a drawer at all), and `repos[0]` is the sandbox's one
 *  real git checkout — BOTH what makes `tree-clean` true and the directory every
 *  command below runs in. */
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
 *  the same file `writeFlow` writes.
 *
 *  Two shape rules `store.ts` enforces on the way back in: the filename must
 *  equal `<id>.json` (`readFlows` drops a record whose filename disagrees with
 *  its own `id`), and `id` must match `VALID_FLOW_ID` (`[A-Za-z0-9_-]+`). One
 *  rule is deliberately NOT exercised: no edge below carries an `action`.
 *  `writeFlow` fills it from the target on its next write, and a stored value
 *  that disagrees with the target is what `latchActionMismatches` latches the
 *  edge dead for. */
function seedFlow(sb: Sandbox, flow: Record<string, unknown>): string {
  const dir = flowsDir(sb);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${flow.id as string}.json`);
  fs.writeFileSync(file, JSON.stringify(flow, null, 2) + "\n");
  return file;
}

const flowFile = (sb: Sandbox, id: string) => path.join(flowsDir(sb), `${id}.json`);

/** The journal's own path — `.log.jsonl` beside `<id>.json` (`journalPath`,
 *  journal.ts), which is the first thing FLOW_JOURNAL.md claims. Deliberately
 *  spelled out here rather than imported: this file asserts the LOCATION, so
 *  taking it from the module under test would make that assertion vacuous. */
const journalFile = (sb: Sandbox, id: string) => path.join(flowsDir(sb), `${id}.log.jsonl`);

/** The flow as the store holds it right now. */
function readFlow(sb: Sandbox, id: string): {
  armed: boolean;
  commandConfirmedAt?: number;
  edges: { id: string; firedAt?: number; firedNote?: string; error?: string }[];
} {
  return JSON.parse(fs.readFileSync(flowFile(sb, id), "utf8"));
}

/** Every journal line for a flow, oldest first — one JSON object per line, which
 *  is the "so `jq` works directly" shape. Parsed WITHOUT verifying `sum`, so the
 *  corrupted-line spec below can still see the bad line on disk; `verified`
 *  below is the checking read. Empty when the journal has never been written. */
function journal(sb: Sandbox, id: string): Record<string, unknown>[] {
  const p = journalFile(sb, id);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

/** The raw lines, so a test can assert that a byte nothing should have rewritten
 *  is still there. */
function journalLines(sb: Sandbox, id: string): string[] {
  const p = journalFile(sb, id);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
}

/** The modal consent dialog — workbench chrome on the top-level page, outside
 *  every `iframe.webview`. `askFirstSpend` raises it with
 *  `showWarningMessage(message, { modal: true }, ACT, DISARM)`, and
 *  `window.dialogStyle: "custom"` (set in `boot`) is what renders it as DOM
 *  Playwright can read and click instead of a native sheet. */
const dialog = (page: Page): Locator => page.locator(".monaco-dialog-box");

/** The Deck's OWN toast, inside the webview — `<div className={`toast ${level}`}>`
 *  with a `.toast-msg` (DeckApp.tsx:1408-1411 on 2026-09-04). `flow:openOutput`'s
 *  three honest refusals are Deck toasts, not workbench notifications. */
const deckToast = (deck: Deck, text: string | RegExp): Locator =>
  deck.frame.locator(".toast", { hasText: text });

/** Every UNTITLED editor tab. The Deck itself is a tab (a webview panel in the
 *  editor area), so counting tabs would never be zero — an Output tab is an
 *  `Untitled-N` document (`openTextDocument({ content })`, no uri). */
const untitledTabs = (page: Page): Locator => page.locator(".tabs-container .tab", { hasText: /Untitled/ });

/** Base settings for every test here: the feature gate, plus the dialog style
 *  that makes the consent modal readable. NOTE what is NOT here — there is no
 *  journal setting to switch on. FLOW_JOURNAL § top: "It is written whenever
 *  `agentFlow.orchestrator` is on. There is no separate setting". */
function boot(extra: Record<string, unknown> = {}): Sandbox {
  return makeSandbox({
    "agentFlow.orchestrator": true,
    "window.dialogStyle": "custom",
    ...extra,
  });
}

/** Open the card, then its Workflow block. */
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
 *  every one of them is held once before it can act. Neither half of this
 *  gesture journals anything of its own beyond the `armed` line `flow:arm`
 *  writes — which is why the kind sequence below is exactly four lines long. */
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

/** Leave the drawer and come back to the card. The Output button lives on the
 *  card's own Workflow block, not in the drawer — and `onOpenWorkflow` cleared
 *  the card selection on the way in (DeckApp.tsx:1585 on 2026-09-04), so the
 *  card has to be clicked again rather than merely revealed. */
async function backToCard(deck: Deck, key: string): Promise<Locator> {
  await deck.frame.locator(".orch-hd").getByRole("button", { name: "Close" }).click();
  await expect(deck.frame.locator(".orch-hd")).toHaveCount(0);
  return openCard(deck, key);
}

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  sb?.dispose();
});

/** A command flow: one place already on disk, one command node, one rule whose
 *  condition (`tree-clean`) is true from the first pass. Chosen because it is
 *  the ONE node kind that walks through both consent gates, so a single gesture
 *  produces all four of the event kinds FLOW_JOURNAL's own ordering claim names.
 *  `$HOME` is the sandbox, so the marker file lands inside the temp root
 *  `sb.dispose()` removes. */
const COMMAND_FLOW = (id: string, name: string, key: string, marker: string) => ({
  id, name, armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "command", run: `echo ${marker} | tee "$HOME/cmd.txt"` },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" } }],
});

const fileText = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

// ── the record of one gesture ─────────────────────────────────────────────────

// Mutation-checked: `advanceUnderLock` (deckView.ts:1268) — the `kind: "fired"`
// journal call commented out, which is the plan's own "stop appending `fired`"
// break. The command still ran and the rule still latched, so every UI assertion
// stayed green; only the journal was three lines long and the kind-sequence
// assertion failed. That break is sabotage/orchestrator-journal.patch.
test("the journal records armed, consent and fired events in order", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-JRN");
  seedFlow(sb, COMMAND_FLOW("e2e-journal", "E2E Journal", "E2E-JRN", "E2E-JOURNAL-OK"));
  // Nothing yet: the journal is created by the first event, never up front.
  expect(fs.existsSync(journalFile(sb, "e2e-journal"))).toBe(false);

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-JRN");
  await armAndGo(deck, block);

  const box = dialog(page);
  await expect(box).toBeVisible({ timeout: 60_000 });
  await shot(page, testInfo, "1 · the pass that asked, already journalled");
  // Asked and answered are two lines, and the ask is on disk BEFORE the answer:
  // "an unanswered ask leaves no trace at all" is the hole the `consent-asked`
  // line exists to close, so it has to be readable while the modal is still up.
  await expect
    .poll(() => journal(sb, "e2e-journal").map((l) => l.kind), { timeout: 30_000 })
    .toEqual(["armed", "consent-asked"]);
  // `ACT` is "Run" for a command (`askFirstSpend`, deckView.ts:1466).
  await box.getByRole("button", { name: "Run" }).click();
  await expect.poll(() => fileText(path.join(sb.home, "cmd.txt")), { timeout: 90_000 })
    .toContain("E2E-JOURNAL-OK");

  // THE assertion of record. Four events, in write order — which is file order,
  // because the file is append-only — and nothing else: the resume hold and the
  // Go that clears it journal nothing of their own (see `armAndGo`), so this is
  // an exact sequence rather than a filter.
  await expect.poll(() => journal(sb, "e2e-journal").map((l) => l.kind), { timeout: 60_000 })
    .toEqual(["armed", "consent-asked", "consented", "fired"]);
  const lines = journal(sb, "e2e-journal");

  // Every line self-describing: the five fields FLOW_JOURNAL § The fields says
  // EVERY line has. `flow` is on each one "so a journal stays self-describing if
  // it is copied or concatenated", and `sum` is a property of the LINE.
  for (const l of lines) {
    expect(typeof l.id).toBe("string");
    // A ULID-shaped id: 10 chars of millisecond clock, 4 of within-millisecond
    // sequence, 2 random — fixed width, which is what makes lexical order
    // numeric order.
    expect(String(l.id)).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(typeof l.at).toBe("number");
    expect(l.flow).toBe("e2e-journal");
    expect(String(l.sum)).toMatch(/^[0-9a-f]{8}$/);
  }
  // "Lexical order is chronological order", read off a real four-event history
  // rather than an injected clock: sorting the ids must be a no-op.
  const ids = lines.map((l) => String(l.id));
  expect([...ids].sort()).toEqual(ids);
  expect(lines.map((l) => l.at as number)).toEqual([...lines.map((l) => l.at as number)].sort((a, b) => a - b));

  // …and each kind's own extra fields, per FLOW_JOURNAL § The events.
  expect(lines[0]).toMatchObject({ kind: "armed", armed: true, source: "toggle" });
  // The target is the NODE the spend would act on, not the edge — a rule is
  // identified by what it points at when the question is about money.
  expect(lines[1]).toMatchObject({ kind: "consent-asked", action: "run", target: "n2" });
  expect(lines[2]).toMatchObject({ kind: "consented", answer: "act" });
  expect(lines[3]).toMatchObject({ kind: "fired", edge: "e1", from: "n1", to: "n2", action: "run" });
  expect(String(lines[3].note)).toMatch(/^ran .* in rocket$/);
  // `output` on the `fired` line is what `flow:openOutput` reads back later.
  expect(String(lines[3].output)).toContain("E2E-JOURNAL-OK");

  // The journal sits BESIDE the flow, in the flows directory — the pairing
  // FLOW_JOURNAL opens with, and the reason the extension is `.log.jsonl`
  // rather than `.jsonl`: `readFlows` scans for `.json`, and a journal parsed
  // as a flow would be dropped as malformed.
  expect(fs.existsSync(flowFile(sb, "e2e-journal"))).toBe(true);
  expect(fs.readdirSync(flowsDir(sb)).filter((n) => n.startsWith("e2e-journal")).sort())
    .toEqual(["e2e-journal.json", "e2e-journal.log.jsonl"]);
  // One JSON object per line, `jq`-readable: no wrapping array, and the file
  // ends in a newline rather than mid-record.
  expect(fs.readFileSync(journalFile(sb, "e2e-journal"), "utf8").endsWith("\n")).toBe(true);
  await shot(page, testInfo, "2 · ran, with the whole gesture on disk");
});

// ── the journal outlives its flow ─────────────────────────────────────────────

/** A notify flow: nothing to consent to (`ask`/`notify` spend nothing), so it
 *  reaches a `fired` line with no modal in the way — all this spec needs is a
 *  journal with real history in it before the flow is deleted. */
const NOTIFY_FLOW = (key: string) => ({
  id: "e2e-jrn-del", name: "E2E Journal Delete", armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: key, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "notify", message: "E2E-DEL-NOTIFY" },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" } }],
});

// Mutation-checked: `removeFlow` (store.ts:241) given a second line,
// `io.remove(path.join(dir, `${id}.log.jsonl`))` — the plausible "tidy up after
// yourself" change. The flow file went and so did the journal; the
// `existsSync(journalFile)` assertion after the delete failed.
test("deleting a flow leaves its journal on disk", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-JDEL");
  seedFlow(sb, NOTIFY_FLOW("E2E-JDEL"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-JDEL");
  const orch = await armAndGo(deck, block);

  // Real history first: a flow deleted before it ever did anything would prove
  // nothing about keeping the record of what it did.
  await expect.poll(() => journal(sb, "e2e-jrn-del").filter((l) => l.kind === "fired").length,
    { timeout: 90_000 }).toBe(1);
  const before = journalLines(sb, "e2e-jrn-del");
  expect(before.length).toBeGreaterThanOrEqual(2);
  await shot(page, testInfo, "1 · fired, and journalled, before the delete");

  // Delete from the drawer's own switcher row (OrchestratorDrawer.tsx:1841-1848
  // on 2026-09-04) — a real click on the real verb, not `flow:delete` posted by
  // hand. It closes the whole drawer, which is how the gesture is confirmed
  // as having been taken at all.
  await orch.getByRole("button", { name: "Delete flow" }).click();
  await expect(deck.frame.locator(".orch-hd")).toHaveCount(0, { timeout: 30_000 });

  // THE assertion of record: one file gone, one file kept. Deleting a workflow
  // is deleting `<id>.json` and nothing more, "because the moment you most want
  // the history is usually just after you deleted the thing that produced it".
  await expect.poll(() => fs.existsSync(flowFile(sb, "e2e-jrn-del")), { timeout: 30_000 }).toBe(false);
  expect(fs.existsSync(journalFile(sb, "e2e-jrn-del"))).toBe(true);
  // Kept INTACT, not merely present: byte-identical to what it held before, so
  // this is history surviving rather than a file being re-created empty.
  expect(journalLines(sb, "e2e-jrn-del")).toEqual(before);
  expect(journal(sb, "e2e-jrn-del").filter((l) => l.kind === "fired")).toHaveLength(1);

  // And the board agrees the workflow is gone — the delete really happened,
  // rather than the flow file being lost some other way.
  await expect(deck.boardWorkflowChip("E2E-JDEL")).toHaveCount(0, { timeout: 30_000 });
  await shot(page, testInfo, "2 · the workflow gone, its journal still there");
});

// ── one bad line costs one line ───────────────────────────────────────────────

// Mutation-checked: `readJournal` (journal.ts:257) `if (typeof sum !== "string" ||
// fnv1a(canonicalJson(rest)) !== sum) continue;` deleted, so the mangled line was
// accepted as if it checksummed. Output then opened the corrupted line's text in
// a tab: the toast never appeared and the `untitledTabs` count went to 1.
test("a line with a bad checksum is skipped, not fatal", async ({}, testInfo) => {
  test.setTimeout(240_000);
  sb = boot();
  seedCard(sb, "E2E-JSUM");
  seedFlow(sb, COMMAND_FLOW("e2e-jrn-sum", "E2E Journal Sum", "E2E-JSUM", "E2E-SUM-OK"));

  const launched = await launchHost(sb);
  app = launched.app;
  const page = launched.page;
  const deck = await Deck.open(page);
  const block = await openCard(deck, "E2E-JSUM");
  await armAndGo(deck, block);
  await dialog(page).getByRole("button", { name: "Run" }).click();
  await expect.poll(() => journal(sb, "e2e-jrn-sum").filter((l) => l.kind === "fired").length,
    { timeout: 90_000 }).toBe(1);

  // Mangle exactly one line's checksum — the `fired` one, because it is the line
  // the product is about to read back, and leave its three neighbours untouched.
  // This is the shape a TORN WRITE leaves behind (two windows interleaving a
  // large output mid-line): a line that still parses as JSON while describing an
  // event that did not happen. `sum` is the last field on every line
  // (`serialize`, journal.ts), so replacing its value edits nothing else.
  const p = journalFile(sb, "e2e-jrn-sum");
  const kept = fs.readFileSync(p, "utf8").split("\n").filter((l) => l !== "");
  const firedIdx = kept.findIndex((l) => (JSON.parse(l) as { kind: string }).kind === "fired");
  expect(firedIdx).toBeGreaterThan(0);
  kept[firedIdx] = kept[firedIdx].replace(/"sum":"[0-9a-f]{8}"/, '"sum":"deadbeef"');
  expect(kept[firedIdx]).toContain('"sum":"deadbeef"');
  fs.writeFileSync(p, kept.join("\n") + "\n");
  const corrupted = kept[firedIdx];

  // Read back through the PRODUCT's own reader. `flow:openOutput` calls
  // `readJournal`, and which of its three refusals comes back is what says how
  // the bad line was treated — this is the discriminating assertion of the whole
  // spec. "This step hasn't run yet" is `no-event`: the journal read fine and has
  // OTHER lines, but none for this edge, i.e. the mangled line was skipped and
  // its three neighbours were not. A fatal read, or a read that emptied the
  // journal, would have produced `no-journal` ("Nothing has been recorded…")
  // instead, and an unchecked one would have opened a tab.
  const back = await backToCard(deck, "E2E-JSUM");
  const output = back.getByRole("button", { name: "Output" });
  await expect(output).toBeVisible({ timeout: 30_000 });
  await expect(untitledTabs(page)).toHaveCount(0);
  await output.click();
  await expect(deckToast(deck, "This step hasn't run yet, so there's no output to show."))
    .toBeVisible({ timeout: 15_000 });
  await expect(deckToast(deck, /Nothing has been recorded/)).toHaveCount(0);
  await expect(untitledTabs(page)).toHaveCount(0);
  await shot(page, testInfo, "1 · the corrupted line skipped, the rest read");

  // Not fatal for the DRAWER either: the panel that renders this flow still
  // renders it, name and all. A journal is a record of a flow, never an input to
  // one, so a mangled line must not cost the surface.
  await back.getByRole("button", { name: /open in workflows/i }).click();
  const orch = deck.frame.locator(".orch-hd");
  await expect(orch).toBeVisible({ timeout: 30_000 });
  await expect(orch.locator(".orch-name")).toHaveValue("E2E Journal Sum");

  // And new lines still APPEND past the bad one. Disarm and re-arm from the
  // drawer's own control — two more `armed` events — and the corrupted line is
  // still sitting there, byte-identical: nothing rewrote the file to "repair" it.
  // `.orch-arm` rather than the button's words: it is the drawer's one filled
  // control and the same element in both states ("Arm" / "Armed · disarm",
  // OrchestratorDrawer.tsx:2010-2016 on 2026-09-04), so this cannot pick up the
  // card block's own Arm on the other side of a re-render.
  const armControl = deck.frame.locator(".orch-arm");
  const beforeArm = journalLines(sb, "e2e-jrn-sum").length;
  await armControl.click();
  await expect.poll(() => readFlow(sb, "e2e-jrn-sum").armed, { timeout: 30_000 }).toBe(false);
  await armControl.click();
  await expect.poll(() => readFlow(sb, "e2e-jrn-sum").armed, { timeout: 30_000 }).toBe(true);

  await expect.poll(() => journalLines(sb, "e2e-jrn-sum").length, { timeout: 30_000 })
    .toBe(beforeArm + 2);
  const after = journalLines(sb, "e2e-jrn-sum");
  expect(after[firedIdx]).toBe(corrupted);
  const tail = after.slice(-2).map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(tail[0]).toMatchObject({ kind: "armed", armed: false, source: "toggle", flow: "e2e-jrn-sum" });
  expect(tail[1]).toMatchObject({ kind: "armed", armed: true, source: "toggle", flow: "e2e-jrn-sum" });
  // Appended, not rewritten: the new lines checksum correctly, so the file the
  // corrupt line lives in is still one the reader trusts line by line.
  for (const l of tail) expect(String(l.sum)).toMatch(/^[0-9a-f]{8}$/);
  await shot(page, testInfo, "2 · new lines appended past the bad one");
});
