import { expect, test, type ElectronApplication } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { makeSandbox, type Sandbox } from "./_helpers/sandbox";
import { launchHost } from "./_helpers/host";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

let sb: Sandbox;
let app: ElectronApplication | undefined;

/** Write a run record straight into the store. HOME is the sandbox, so this is
 *  the same path the extension writes — not a seam. Copied from
 *  `deck-lifecycle.e2e.ts`'s `seedRun`, which this file cannot import (it is not
 *  exported, and the two files' fixtures are cheap enough that sharing a helper
 *  module is not worth the coupling). */
function seedRun(sb: Sandbox, run: Record<string, unknown>): string {
  const dir = path.join(sb.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.key as string}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return file;
}

/** A card that renders as a `.card`, not a Recently-closed row. See
 *  `deck-lifecycle.e2e.ts`'s `baseRun` doc comment for the full reasoning — the
 *  short version: `createdAt: Date.now()` keeps `shelf` off `"closed"` for the
 *  life of the test, which is the only thing that makes this a clickable card
 *  with a drawer to open at all.
 *
 *  The key is deliberately ONE the fixture connector's `tasks.json` has never
 *  heard of (`find()` in `src/tasks/fixture/connector.ts` throws for any key it
 *  does not know, and `deckView.ts`'s `ticketStatus` catches that and returns
 *  `null` forever) — this journey never reads a ticket's status or category, so
 *  there is nothing to lose by not registering the key, and `deck-lifecycle.e2e.ts`
 *  already establishes that an unknown key is the normal shape for a seeded E2E
 *  run here. What DOES matter for this file is the url: `keyFromUrl` (the fixture
 *  connector) parses a key out of `https://fixture.invalid/browse/<key>` on the
 *  ONLY charset it accepts REGARDLESS of whether that key is registered, so
 *  `ticketKeyFor` — and therefore `boundTicketKeyOf`/`flow:attach`'s own ticket
 *  key — resolves to exactly this run's own key. A workflow attaches by ticket
 *  key, and this keeps that key unambiguous. */
function seedCard(sb: Sandbox, key: string) {
  return seedRun(sb, {
    key, summary: `Run ${key}`, url: `https://fixture.invalid/browse/${key}`,
    createdAt: Date.now(), kind: "task", mode: "per-window",
    repos: [{ name: "rocket", path: sb.repoPath, isGit: true, branch: "main" }],
    briefPaths: [],
  });
}

/** Write a template envelope straight into `~/.agentflow/templates/<id>.json` —
 *  the same store `readTemplates` (`src/engine/orchestrator/store.ts`) reads,
 *  and the same seam `seedRun` above uses for `~/.agentflow/runs`: HOME is the
 *  sandbox, so this is the path the extension itself writes to on
 *  `flow:saveTemplate`, not a shortcut around it.
 *
 *  The filename must equal `<id>.json` — `readTemplates` skips a template whose
 *  filename disagrees with its own `id` field, on the theory that a mismatch can
 *  only be a copied file, never one the store itself wrote (`store.ts`'s own
 *  comment on that check). */
function seedTemplate(sb: Sandbox, t: Record<string, unknown>): string {
  const dir = path.join(sb.home, ".agentflow", "templates");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${t.id as string}.json`);
  fs.writeFileSync(file, JSON.stringify(t, null, 2) + "\n");
  return file;
}

/** A one-rule template: a planned session, and a rule that watches it for its
 *  agent's turn to end, then notifies. `instantiate` (templates.ts) refuses a
 *  template with no planned node — this template exists to bind a ticket to —
 *  and `evaluate.ts`'s own `isMet` never launches anything for it: a rule's
 *  SOURCE has to be a place (something already running) before its condition is
 *  ever read ("a planned source has no run to observe yet ... just not ready",
 *  `evaluate.ts`), and the only edge here runs FROM the still-planned node, never
 *  into it. So arming this instantiated workflow in the real host is inert by
 *  construction: no window opens, no session launches, and the rule simply sits
 *  "advancing" forever — exactly the stable state this spec wants to poll
 *  without racing a real agent. */
function shipItTemplate(id: string) {
  return {
    schema: 1, id, name: "Ship it", params: {}, savedAt: Date.now(),
    flow: {
      id: "", name: "Ship it", armed: false, createdAt: 0,
      nodes: [
        { id: "n1", x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: ["rocket"], mode: "implementation", dest: "new-window" },
        { id: "n2", x: 200, y: 0, join: "any", kind: "notify", message: "Ship it is done" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", cond: { kind: "agent-ended-turn" } },
      ],
    },
  };
}

/** A ZERO-rule template: one planned node and no edges at all. Not a mistake —
 *  `workflowState` (attach.ts) computes `done` as the absence of any pending
 *  rule, and `steps.every(...)` over an EMPTY array is vacuously true, so arming
 *  an instantiated copy of this template reads as "done" on the very next
 *  render, with no rule ever having to fire. That is what lets this spec reach
 *  the block's `done`-only Detach button (`WorkflowBlock.tsx`'s `headerAction`)
 *  without a real launch or a real settled rule — the engine's own documented
 *  degenerate case (design doc §5: "`done` is the absence of a pending rule, not
 *  a stored flag"), not a shortcut around it. */
function emptyTemplate(id: string) {
  return {
    schema: 1, id, name: "Nothing to do", params: {}, savedAt: Date.now(),
    flow: {
      id: "", name: "Nothing to do", armed: false, createdAt: 0,
      nodes: [
        { id: "n1", x: 0, y: 0, join: "any", kind: "planned", ticketKey: "", repos: ["rocket"], mode: "implementation", dest: "new-window" },
      ],
      edges: [],
    },
  };
}

test.beforeEach(() => {
  // The setting this whole feature is gated behind — default off, per the
  // design doc's own "ships inert" rule, so this override is what makes the
  // surface reachable at all. Without it `postFlows` (deckView.ts) sends
  // `enabled: false` and an empty `templates`/`flows`, and every locator below
  // would time out against a Deck that never renders a Workflow block.
  sb = makeSandbox({ "agentFlow.orchestrator": true });
});
test.afterEach(async () => { await app?.close(); app = undefined; sb.dispose(); });

test("attaching a template shows it disarmed, and arming grows the card's chip", async ({}, testInfo) => {
  test.setTimeout(240_000);
  seedCard(sb, "E2E-WF");
  seedTemplate(sb, shipItTemplate("e2e-ship-it"));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.card("E2E-WF")).toBeVisible({ timeout: 60_000 });
  // No chip yet — nothing is attached.
  await expect(deck.boardWorkflowChip("E2E-WF")).toHaveCount(0);
  await deck.card("E2E-WF").click();
  await shot(launched.page, testInfo, "1 · card open, no workflow");

  const block = deck.workflowBlock();
  await expect(block).toBeVisible();
  await expect(block).toContainText("No workflow attached");

  await block.getByRole("button", { name: /attach workflow/i }).click();
  await deck.detail().getByRole("button", { name: "Ship it" }).click();

  // `flow:attach` mints a brand-new flow, and DeckApp.tsx's `deck:flows` handler
  // treats EVERY fresh flow the same way regardless of what created it (its own
  // comment: "a create posts a flow we did not have — open it"): it auto-opens
  // the Orchestrator on that flow and closes whatever card drawer was open,
  // because the two drawers share one fixed slot. So attaching does not leave
  // the card drawer sitting open on the newly-disarmed block — it bounces
  // through the Orchestrator first, exactly as pressing "+ New flow" would.
  // `DeckApp.test.tsx`'s own "opening a workflow from the card drawer …" test
  // pins the identical mutual-exclusion contract for the reverse direction.
  const orch = deck.frame.locator(".orch-hd");
  await expect(orch).toBeVisible({ timeout: 30_000 });
  await expect(orch.locator(".orch-name")).toHaveValue("Ship it");
  // Disarmed: the header's own toggle still reads "Arm", not "Armed · disarm"
  // (`orch-arm`'s label in `OrchestratorDrawer.tsx`).
  await expect(orch.getByRole("button", { name: "Arm" })).toBeVisible();
  await shot(launched.page, testInfo, "2 · attach bounces through the Orchestrator, disarmed");

  // Back to the card: closing the Orchestrator and reselecting shows the SAME
  // workflow, disarmed, in the block this feature actually built.
  await deck.frame.getByRole("button", { name: "Close" }).click();
  await deck.card("E2E-WF").click();
  await expect(block.locator(".wf-chip")).toHaveText(/disarmed/i, { timeout: 15_000 });
  await expect(block).toContainText("Ship it");
  await expect(block.getByRole("button", { name: "Arm" })).toBeVisible();
  await shot(launched.page, testInfo, "3 · back on the card, attached and disarmed");

  // Still no card chip — a disarmed workflow shows in the drawer alone until it
  // is armed (the chip's own `{workflow && …}` guard has no "disarmed but shown"
  // branch skipped here — it renders for every attached state, including this
  // one, but confirming the pre-attach absence above is what proves the chip
  // that is about to appear was actually caused by the click below, not already
  // there from some other seam).
  await block.getByRole("button", { name: "Arm" }).click();

  // The card itself grows a workflow chip once armed — `.c-wf` (DeckApp.tsx),
  // named after the template. This is the block and the board reading the exact
  // same derivation (`cardWorkflow`, attach.ts) off the exact same `flows` —
  // they cannot disagree about which workflow a card carries or where it stands.
  const chip = deck.boardWorkflowChip("E2E-WF");
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText("Ship it");
  // `advancing`, never `disarmed` — the rule can never fire (its source is a
  // still-planned node, so `evaluate.ts` reads it as simply not ready yet), but
  // the flow itself is armed, and armed-with-nothing-settled reads `advancing`.
  await expect(chip).toHaveClass(/advancing/);
  await expect(block.locator(".wf-chip")).toHaveText(/advancing/i, { timeout: 30_000 });
  await shot(launched.page, testInfo, "4 · armed, card chip live");
});

test("an attached workflow is a real flow in the Workflows drawer, and Detach clears the card", async ({}, testInfo) => {
  test.setTimeout(240_000);
  seedCard(sb, "E2E-WF2");
  seedTemplate(sb, emptyTemplate("e2e-nothing"));

  const launched = await launchHost(sb);
  app = launched.app;
  const deck = await Deck.open(launched.page);

  await expect(deck.card("E2E-WF2")).toBeVisible({ timeout: 60_000 });
  await deck.card("E2E-WF2").click();

  const block = deck.workflowBlock();
  await block.getByRole("button", { name: /attach workflow/i }).click();
  await deck.detail().getByRole("button", { name: "Nothing to do" }).click();

  // Attaching mints a brand-new flow, which DeckApp.tsx's `deck:flows` handler
  // auto-opens on the Orchestrator (closing the card drawer under it) exactly
  // as it would for "+ New flow" — see the sibling test's own comment on this.
  // That bounce is this test's own round-trip proof for free: the workflow the
  // card drawer will show is not a projection, it is this exact flow.
  const orch = deck.frame.locator(".orch-hd");
  await expect(orch).toBeVisible({ timeout: 30_000 });
  await expect(orch.locator(".orch-name")).toHaveValue("Nothing to do");
  await shot(launched.page, testInfo, "1 · attach bounces through the Orchestrator");

  // The Templates tab is the OTHER half of the round trip: the shape this
  // workflow came from is still a reusable template of its own, independent of
  // any card it has been attached to (design doc §8).
  await orch.getByRole("button", { name: /flows ·/i }).click();
  await deck.frame.getByRole("tab", { name: "Templates" }).click();
  await expect(deck.frame.locator(".orch-tmpl-row")).toContainText("Nothing to do");
  await shot(launched.page, testInfo, "2 · the template, independent of the card");

  // Back to the card to arm from where the design's own controls live.
  await deck.frame.getByRole("button", { name: "Close" }).click();
  await deck.card("E2E-WF2").click();
  await expect(block.locator(".wf-chip")).toHaveText(/disarmed/i, { timeout: 15_000 });

  // Arm a zero-rule workflow: no rule is ever pending, so this reads `done` on
  // the very next render (attach.ts's own documented degenerate case) — the one
  // state, besides `stopped`, whose header offers Detach rather than Disarm.
  await block.getByRole("button", { name: "Arm" }).click();
  await expect(block.locator(".wf-chip")).toHaveText(/done/i, { timeout: 30_000 });
  await shot(launched.page, testInfo, "3 · zero-rule workflow reads done");

  // Detach — the affordance this test is actually about, and the one the
  // block's header offers ONLY in the `done`/`stopped` states just reached.
  await block.getByRole("button", { name: "Detach" }).click();

  // Attachment is derived, never stored (design doc §2): detaching is deleting
  // the flow file, and the block falls straight back to its "none" shape with
  // no separate link left to clear.
  await expect(block).toContainText("No workflow attached", { timeout: 30_000 });
  await expect(deck.boardWorkflowChip("E2E-WF2")).toHaveCount(0);
  await shot(launched.page, testInfo, "4 · detached");
});
