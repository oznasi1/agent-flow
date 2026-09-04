import { expect, test, type Locator, type Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import type { Sandbox } from "./_helpers/sandbox";
import { describeWithHost } from "./_helpers/sharedHost";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

/** Write a run record straight into the store. HOME is the sandbox, so this is
 *  the same path the extension writes — not a seam. Copied from
 *  `workflows.e2e.ts`'s `seedRun`, which copied it from `deck-lifecycle.e2e.ts`
 *  for the same reason neither exports it: the fixtures are cheap and a shared
 *  helper module would couple three journeys' seeds together. */
function seedRun(sb: Sandbox, run: Record<string, unknown>): string {
  const dir = path.join(sb.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.key as string}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return file;
}

/** A card a workflow can bind to. Same shape `workflows.e2e.ts` establishes —
 *  see its `seedCard` doc comment for why the key is one the fixture connector
 *  has never heard of, and why the url still matters (`keyFromUrl` parses a key
 *  out of it regardless of registration, so `ticketKeyFor` resolves to this
 *  run's own key and a workflow's binding is unambiguous).
 *
 *  `createdAt: Date.now()` is kept for the same reason it is there, but it is
 *  NOT what holds these cards on the board here: `justLaunched` expires after
 *  ten minutes (`JUST_LAUNCHED_MS`, src/engine/visibility.ts) and this is a
 *  SHARED host whose seven tests can outlive that. `agentFlow.inflightShowAll`
 *  (below) is what actually pins every record to the board for the whole block
 *  — the same override `deck-board.e2e.ts` uses for the same purpose. */
function seedCard(sb: Sandbox, key: string): string {
  return seedRun(sb, {
    key, summary: `Run ${key}`, url: `https://fixture.invalid/browse/${key}`,
    createdAt: Date.now(), kind: "task", mode: "per-window",
    repos: [{ name: "rocket", path: sb.repoPath, isGit: true, branch: "main" }],
    briefPaths: [],
  });
}

/** Write a flow straight into `~/.agentflow/flows/<id>.json` — the store
 *  itself, shared by every window (`defaultFlowsDir`, store.ts) and re-read on
 *  every 6-second pass (`postFlows`, deckView.ts). Not a seam and not a
 *  shortcut: it is the one door flows come through, and `readFlows` skips any
 *  file whose name disagrees with its own `id`, so the filename is derived from
 *  the record rather than passed in.
 *
 *  Deliberately no `action` field on any edge. `writeFlow` (store.ts) writes
 *  `e.action ?? derived`, and `coerceFlow` LATCHES a stored value that
 *  disagrees with the action its target implies — stamping that edge with an
 *  `error`, which reads as the `stopped` workflow status. Absence is not
 *  disagreement, so leaving the field off is the one shape that can never be
 *  latched by accident. */
function writeFlowFile(sb: Sandbox, flow: Record<string, unknown>): string {
  const dir = path.join(sb.home, ".agentflow", "flows");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${flow.id as string}.json`);
  fs.writeFileSync(file, JSON.stringify(flow, null, 2) + "\n");
  return file;
}

interface StoredFlow {
  armed: boolean;
  nodes: { id: string; kind: string }[];
  edges: { id: string; from: string; to: string; cond: { kind: string } }[];
}

/** Read one flow back off disk. The assertion of record for anything the
 *  drawer WRITES: the DOM says what the webview believes, the file says what
 *  the host actually stored. */
function readFlowFile(sb: Sandbox, id: string): StoredFlow {
  return JSON.parse(
    fs.readFileSync(path.join(sb.home, ".agentflow", "flows", `${id}.json`), "utf8"),
  ) as StoredFlow;
}

const GATE_FLOW = "e2e-orch-gate";
const PLAIN_FLOW = "e2e-orch-plain";

/** The card whose workflow poses a question, and the card whose workflow does
 *  not. Two cards, one workflow each — which is what makes the Workflows
 *  badge's plain count read exactly `2`. */
const GATE_CARD = "E2E-D1";
const PLAIN_CARD = "E2E-D2";

/** `has-uncommitted` throughout, and never `tree-clean`, for one reason worth
 *  stating once: the sandbox repo is committed clean, so `tree-clean` is MET the
 *  moment anything here is armed — which puts the first pass into the resume
 *  hold and stands a Go/Disarm prompt inside the very drawer these tests read.
 *  `has-uncommitted` is its exact negation on the same clean repo: answerable,
 *  always false, and unfirable for no reason at all, so arming raises no warning
 *  either. Nothing in this file needs a rule to fire. */
const UNMET = { kind: "has-uncommitted" };

/** place → gate → notify, with the ask NOT yet stamped.
 *
 *  `waiting-on-you` is derived, never stored: `evaluate.ts`'s `isMet` posts an
 *  `awaiting-answer` note against a gate node only once one of its INCOMING
 *  edges carries both `performed: true` and a `firedAt` — i.e. once the question
 *  has actually been posed — and `workflowState` (attach.ts) turns that note on
 *  the edges LEAVING the gate into a `you` step. So this shape reads `disarmed`
 *  as written, and becomes `waiting-on-you` the moment `gateFlowAsked` stamps
 *  e1. That transition is the whole subject of the first test. */
function gateFlow(): Record<string, unknown> {
  return {
    id: GATE_FLOW, name: "Ask before shipping", armed: false, createdAt: 1_000,
    nodes: [
      { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: GATE_CARD, repo: "rocket" },
      { id: "g1", x: 200, y: 0, join: "any", kind: "gate", question: "Ship it?" },
      { id: "n2", x: 400, y: 0, join: "any", kind: "notify", message: "shipped" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "g1", cond: UNMET },
      { id: "e2", from: "g1", to: "n2", cond: { kind: "gate-approved" } },
    ],
  };
}

/** The same flow with its ask stamped exactly as `applyFired` (runner.ts)
 *  stamps a performed `ask`: `firedAt`, `performed: true`, and the receipt the
 *  rule recorded. Written from the test rather than fired for real because
 *  firing it needs an armed pass whose rule is met, and every rule that IS met
 *  here would also be met on the pass after — the store is shared across
 *  windows by design, and this is exactly the shape another window's pass
 *  leaves behind. */
function gateFlowAsked(): Record<string, unknown> {
  const f = gateFlow();
  (f.edges as Record<string, unknown>[])[0] = {
    id: "e1", from: "n1", to: "g1", cond: UNMET,
    firedAt: Date.now(), performed: true, firedNote: "asked you: Ship it?",
  };
  return f;
}

/** place → notify, one rule, nothing settled: `disarmed` as written and
 *  `advancing` once armed. The second card's whole workflow. */
function plainFlow(): Record<string, unknown> {
  return {
    id: PLAIN_FLOW, name: "Say when it settles", armed: false, createdAt: 2_000,
    nodes: [
      { id: "p1", x: 0, y: 0, join: "any", kind: "place", runKey: PLAIN_CARD, repo: "rocket" },
      { id: "p2", x: 200, y: 0, join: "any", kind: "notify", message: "settled" },
    ],
    edges: [{ id: "f1", from: "p1", to: "p2", cond: UNMET }],
  };
}

/** Walk the Tab order until `target` holds the focus, and fail loudly if it
 *  never does. A count rather than a fixed number of presses: the rows of
 *  controls between the drawer's tablist and its body are conditional (Save as
 *  template is hidden while editing a template, the resize grip while
 *  expanded), and pinning an exact count would pin today's layout rather than
 *  the claim — which is only that the control is REACHABLE without a pointer.
 *
 *  `el === document.activeElement`, evaluated in the webview's own document,
 *  rather than Playwright's `toBeFocused`: this is a poll-and-press loop, and a
 *  failing web-first assertion would spend its whole timeout on every press. */
async function tabTo(page: Page, target: Locator, back = false, max = 40): Promise<void> {
  const key = back ? "Shift+Tab" : "Tab";
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press(key);
  }
  throw new Error(`tabTo: ${max} ${key} presses never reached the target`);
}

/** Pick a `<select>`'s option by typing, which is the only pointer-free way to
 *  set one in this host: Blink pops the NATIVE menu on ArrowDown wherever
 *  `PopsMenuByArrowKeys()` is true (macOS), and a native menu is outside the
 *  page Playwright drives. Typeahead is handled by the closed control itself,
 *  so it changes the value and fires `change` without opening anything.
 *  `prefix` must be unique among that select's options — every call below uses
 *  one letter that is, and says so. */
async function typeAheadSelect(page: Page, select: Locator, prefix: string, expected: string): Promise<void> {
  await expect(select).toBeFocused();
  await page.keyboard.type(prefix);
  await expect(select).toHaveValue(expected, { timeout: 10_000 });
}

describeWithHost(
  "the Orchestrator drawer",
  {
    // The gate this whole feature is behind — default off ("ships inert"), so
    // without it `postFlows` sends `enabled: false` with empty flows and
    // templates and the two header buttons never render at all.
    "agentFlow.orchestrator": true,
    // Every run record renders as a card for the life of this shared host —
    // see `seedCard`'s own comment on why `justLaunched` is not enough.
    "agentFlow.inflightShowAll": true,
  },
  (ctx) => {
    /** Every test opens the Deck through the real palette. `DeckPanel.show`
     *  REVEALS a live panel rather than minting a second one, so this is one
     *  panel across the whole block — and the last test disposes it on
     *  purpose, which is why it is last. */
    const deck = () => Deck.open(ctx.page());

    // Mutation-checked: DeckApp.tsx's `needsYouCount` filter replaced with
    // `activeRows.filter(() => true)` — the badge read "2 needs you" from the
    // start and the plain-count assertion failed.
    test("the Workflows button counts cards and switches to needs-you when one is waiting", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const d = await deck();
      await expect(d.card(GATE_CARD)).toBeVisible({ timeout: 60_000 });
      await expect(d.card(PLAIN_CARD)).toBeVisible({ timeout: 60_000 });

      // Two cards, two workflows, neither waiting on anybody: a plain count of
      // every card carrying one. Not "2 needs you", and not absent — the badge
      // only disappears with no attached workflow at all
      // (`activeRows.length > 0 &&`, DeckApp.tsx:1171 on 2026-09-04).
      await expect(d.orchChipCount("Workflows")).toHaveText("2", { timeout: 60_000 });
      // The `armed` escalation is the badge's other half: full-strength teal is
      // reserved for "needs you" on this surface (orchestratorStyles.ts's own
      // note on `.orch-chip`), so a plain count must not wear it.
      await expect(d.orchChip("Workflows")).not.toHaveClass(/\barmed\b/);
      await shot(ctx.page(), testInfo, "1 · two workflows, plain count");

      // The gate's own rule poses its question. Nothing else about either flow
      // changes.
      writeFlowFile(ctx.sb(), gateFlowAsked());

      // One of the two cards is now waiting on the reader, so the badge stops
      // counting and starts naming — and the button escalates with it. Polled
      // rather than ticked: one pass every 6 seconds (`POLL_MS`) is what
      // re-reads the store.
      await expect(d.orchChipCount("Workflows")).toHaveText("1 needs you", { timeout: 60_000 });
      await expect(d.orchChip("Workflows")).toHaveClass(/\barmed\b/);
      await shot(ctx.page(), testInfo, "2 · one needs you");
    });

    // Mutation-checked: deckView.ts's `allTemplates` reduced to
    // `readTemplates(...)` alone (the starters dropped) — the badge vanished
    // entirely and `textContent()` came back null, failing the count.
    test("the Templates button counts starters too", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const d = await deck();
      await expect(d.orchChip("Templates")).toBeVisible({ timeout: 60_000 });

      // Nothing has ever been saved to `~/.agentflow/templates/` in this
      // sandbox, so every template in this count is a built-in starter — three
      // ship inside the extension (`STARTERS`, src/engine/orchestrator/starters.ts)
      // and `postFlows` prepends them to whatever is on disk. `>= 3` rather
      // than `=== 3`: the claim is that starters are counted, not that there
      // are exactly three of them forever.
      const badge = await d.orchChipCount("Templates").textContent();
      expect(Number(badge)).toBeGreaterThanOrEqual(3);
      // The half that makes the number mean something: there is no templates
      // directory at all, so none of what was counted came off disk.
      expect(fs.existsSync(path.join(ctx.sb().home, ".agentflow", "templates"))).toBe(false);
      await shot(ctx.page(), testInfo, "1 · starters counted");
    });

    // Mutation-checked: DeckApp.tsx's Workflows handler changed to toggle on
    // its own OPEN state rather than its own view (`if (orchOpen) { … }`) — the
    // click closed the drawer instead of switching, and both the still-open and
    // Active-selected assertions failed.
    test("clicking Workflows while Templates shows switches to Active", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const d = await deck();

      await d.orchChip("Templates").click();
      await expect(d.orch()).toBeVisible({ timeout: 30_000 });
      await expect(d.orchTab("Templates")).toHaveAttribute("aria-selected", "true");
      // Three top-level views, and exactly three — the "Flows · N ▾"
      // disclosure that used to bury Templates behind Canvas is gone, and the
      // header is identical on all three screens (one shared `topRow`).
      await expect(d.orchTabs()).toHaveText(["Active", "Templates", "Canvas"]);
      await shot(ctx.page(), testInfo, "1 · Templates showing");

      // Not a toggle against "is the drawer open" — a toggle against THIS
      // button's own view. With Templates showing, Workflows switches.
      await d.orchChip("Workflows").click();
      await expect(d.orch()).toBeVisible();
      await expect(d.orchTab("Active")).toHaveAttribute("aria-selected", "true");
      await expect(d.orchTab("Templates")).toHaveAttribute("aria-selected", "false");
      // Neither header button ever mints a blank flow — the old single
      // "Orchestrator" chip's zero-flows click did, which is what made "no
      // flows yet" also mean "no way to reach Templates at all". Two cards
      // carry a workflow and there are still exactly two rows.
      await expect(d.activeRows()).toHaveCount(2, { timeout: 30_000 });
      await shot(ctx.page(), testInfo, "2 · switched to Active, still open");

      // A SECOND Workflows click, now that Active is what is showing, is the
      // other half of the same rule: that one does close.
      await d.orchChip("Workflows").click();
      await expect(d.orch()).toHaveCount(0, { timeout: 30_000 });
    });

    // Mutation-checked: OrchestratorDrawer.tsx's `if (!flow)` branch restored
    // to its old `return null` — the drawer unmounted on the Canvas click and
    // every assertion after it failed.
    test("the Canvas explains itself when nothing is open", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const d = await deck();

      await d.orchChip("Workflows").click();
      await expect(d.orch()).toBeVisible({ timeout: 30_000 });
      // Neither header button ever addresses a flow — both are surfaces over
      // the whole workspace — so Canvas is reached here with `openId` null,
      // exactly the state that used to paint a blank panel with no way out.
      await d.orchTab("Canvas").click();

      await expect(d.orchTab("Canvas")).toHaveAttribute("aria-selected", "true");
      await expect(d.orch()).toBeVisible();
      await expect(d.orch().locator(".orch-empty")).toContainText("No workflow is open here");
      // The three ways out are the three that already exist elsewhere in the
      // drawer, offered here rather than left to be guessed at.
      await expect(d.orch().getByRole("button", { name: "Active" })).toBeVisible();
      await expect(d.orch().getByRole("button", { name: "+ New flow" })).toBeVisible();
      // An explanation, not a graph: no node is drawn, and `.orch-node` is
      // absent rather than empty — the canvas is not rendered at all.
      await expect(d.orch().locator(".orch-node")).toHaveCount(0);
      await shot(ctx.page(), testInfo, "1 · Canvas with nothing open");

      await d.orch().getByRole("button", { name: "Close" }).click();
      await expect(d.orch()).toHaveCount(0, { timeout: 30_000 });
    });

    // Mutation-checked: DeckApp.tsx's `onOpenCard` stripped to
    // `setSelId(cardId)` alone — the Orchestrator stayed open on top of the
    // card drawer and the `.orch` zero-count assertion failed.
    test("an Active row closes the drawer and opens that card", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const d = await deck();

      await d.orchChip("Workflows").click();
      await expect(d.orch()).toBeVisible({ timeout: 30_000 });

      // One row per CARD carrying a workflow, ranked so the one that most needs
      // a human comes first — `stopped` and `waiting-on-you` ahead of
      // everything else (`RANK`, attach.ts). The gate card has been waiting
      // since the first test, so it leads.
      await expect(d.activeRows()).toHaveCount(2, { timeout: 30_000 });
      await expect(d.activeRows().first()).toContainText(GATE_CARD);
      await expect(d.activeRow(GATE_CARD)).toContainText("Ask before shipping");
      await shot(ctx.page(), testInfo, "1 · Active, needs-you first");

      // The mirror image of the card drawer's own "Open in Workflows ↗": this
      // opens a CARD from its workflow. Both drawers share one fixed slot, so
      // the Orchestrator has to leave as the card detail arrives.
      await d.activeRow(GATE_CARD).click();
      await expect(d.detail()).toBeVisible({ timeout: 30_000 });
      await expect(d.detail()).toHaveAttribute("aria-label", `Detail for ${GATE_CARD}`);
      await expect(d.orch()).toHaveCount(0);
      await shot(ctx.page(), testInfo, "2 · that card's drawer, Orchestrator gone");

      // Leave the board as the next test expects it.
      await d.card(GATE_CARD).click();
      await expect(d.detail()).toHaveCount(0, { timeout: 30_000 });
    });

    // Mutation-checked: flowList.tsx's `NewRuleBar.addRule` returned early
    // before `onSave(next)` — the rule was never written and the on-disk
    // edge-count poll stayed at 2.
    test("List view builds and arms a rule without a pointer", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const page = ctx.page();
      const d = await deck();

      // Getting to the flow is navigation, not the claim: this row is about
      // BUILDING and ARMING a rule without a pointer. The card drawer's own
      // "Open in Workflows ↗" is the route `workflows.e2e.ts` establishes.
      await d.card(GATE_CARD).click();
      await d.workflowBlock().getByRole("button", { name: /open in workflows/i }).click();
      await expect(d.orch()).toBeVisible({ timeout: 30_000 });
      await expect(d.orch().locator(".orch-name")).toHaveValue("Ask before shipping");

      // From here on, no click and no pointer event of any kind — only focus,
      // Tab, Shift+Tab, typeahead and Enter. The starting point is the drawer's
      // own first control (the resize grip, `tabIndex={0}`), focused rather
      // than clicked, so the walk that follows is the drawer's real Tab order.
      await d.orchGrip().focus();
      await tabTo(page, d.orchFlowViewTab("List"));
      await page.keyboard.press("Enter");
      await expect(d.orchFlowViewTab("List")).toHaveAttribute("aria-selected", "true");
      await expect(d.orch().locator("[data-testid=orch-list]")).toBeVisible();
      await shot(page, testInfo, "1 · List view, reached by Tab");

      const bar = d.orch().locator("[data-testid=flowlist-newrule]");
      const from = bar.getByLabel("From node");
      const cond = bar.getByLabel("New rule condition");
      const to = bar.getByLabel("To node");

      // WHEN <place> … — a notify terminal can never be a source, so this
      // flow offers the place and the gate, and `E2E-D1` (the place's own
      // `runKey`, which is what `endLabel` shows) is the only option starting
      // with `e`. The select's VALUE is the node id.
      await tabTo(page, from);
      await typeAheadSelect(page, from, "e", "n1");

      // … <condition> — deliberately not the `pr-merged` the bar reseeds to
      // when a source is chosen: picking one is half of what this row claims.
      // "has uncommitted work" is the only offered condition starting with `h`.
      await tabTo(page, cond);
      await typeAheadSelect(page, cond, "h", "has-uncommitted");

      // THEN notify … — the notify terminal is the only remaining target (the
      // place already has a rule into the gate, and `targets` excludes a
      // duplicate), and the only option starting with `n`.
      await tabTo(page, to);
      await typeAheadSelect(page, to, "n", "n2");

      const add = bar.getByRole("button", { name: "+ Add rule" });
      await tabTo(page, add);
      await page.keyboard.press("Enter");

      // The assertion of record is the file, not the row: `onSave` goes to the
      // host, and the host is what writes the store.
      await expect
        .poll(() => readFlowFile(ctx.sb(), GATE_FLOW).edges.length, { timeout: 60_000 })
        .toBe(3);
      const built = readFlowFile(ctx.sb(), GATE_FLOW).edges[2];
      expect(built.from).toBe("n1");
      expect(built.to).toBe("n2");
      expect(built.cond.kind).toBe("has-uncommitted");
      await shot(page, testInfo, "2 · rule built by keyboard");

      // Arm, still without a pointer. The control sits in the drawer's header,
      // above the body this rule was built in, so the walk back is Shift+Tab.
      await tabTo(page, d.orchArm(), true);
      await expect(d.orchArm()).toHaveText("Arm");
      await page.keyboard.press("Enter");

      await expect(d.orchArm()).toHaveText(/^Armed/, { timeout: 30_000 });
      await expect
        .poll(() => readFlowFile(ctx.sb(), GATE_FLOW).armed, { timeout: 60_000 })
        .toBe(true);
      await shot(page, testInfo, "3 · armed by keyboard");
    });

    // Mutation-checked: deckView.ts's `onDidDispose` guard flipped from
    // `if (!wasArmed) return;` to `if (wasArmed) return;` — the Deck closed
    // silently and the notification never appeared.
    test("closing the Deck with an armed flow says so", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const page = ctx.page();
      const d = await deck();

      // Arm the second card's own workflow from where the design puts that
      // control — the card drawer's Workflow block. Its own arming rather than
      // the previous test's, so this one still means something on its own.
      await d.card(PLAIN_CARD).click();
      const block = d.workflowBlock();
      await expect(block.locator(".wf-chip")).toHaveText(/disarmed/i, { timeout: 30_000 });
      await block.getByRole("button", { name: "Arm" }).click();
      await expect(block.locator(".wf-chip")).toHaveText(/advancing/i, { timeout: 30_000 });
      await expect
        .poll(() => readFlowFile(ctx.sb(), PLAIN_FLOW).armed, { timeout: 60_000 })
        .toBe(true);
      await shot(page, testInfo, "1 · armed");

      // The pass is a timer on the Deck panel: closing the panel stops every
      // armed flow advancing, and there is no cancellable close to gate that
      // on — so the close is allowed and then disclosed. `closeAll` goes
      // through the real palette because `DeckPanel.show` only REVEALS a live
      // panel; nothing short of disposing it exercises this at all.
      await Deck.closeAll(page);

      const notice = page.locator(".notification-list-item", {
        hasText: "A flow is armed, and closing the Deck stops it advancing.",
      });
      await expect(notice).toBeVisible({ timeout: 30_000 });
      // Two ways forward, both offered rather than implied.
      await expect(notice.getByRole("button", { name: "Reopen the Deck" })).toBeVisible();
      await expect(notice.getByRole("button", { name: "Leave it closed" })).toBeVisible();
      // The intent survives the close: the flow is still armed on disk, and the
      // resume hold is what makes coming back safe.
      expect(readFlowFile(ctx.sb(), PLAIN_FLOW).armed).toBe(true);
      await shot(page, testInfo, "2 · closing an armed Deck says so");
    });
  },
  // Seeded before the host boots, all of it: a flow file that appears AFTER the
  // first `deck:flows` post is a "fresh flow" to `DeckApp`, which auto-opens the
  // Orchestrator on Canvas and closes whatever drawer was showing (its own
  // `deck:flows` handler). MODIFYING a flow already posted — which the first
  // test does — is not that, and disturbs nothing.
  (sb) => {
    seedCard(sb, GATE_CARD);
    seedCard(sb, PLAIN_CARD);
    writeFlowFile(sb, gateFlow());
    writeFlowFile(sb, plainFlow());
  },
);
