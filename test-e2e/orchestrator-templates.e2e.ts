import { expect, test, type Locator } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { type Sandbox } from "./_helpers/sandbox";
import { describeWithHost } from "./_helpers/sharedHost";
import { Deck } from "./_helpers/po/deck";
import { shot } from "./_helpers/shot";

// The Templates tab, driven end to end: a live workflow becomes a reusable
// shape, that shape is renamed through Edit, deleted behind a confirmation, and
// the three built-in starters sit beside it marked and undeletable. Then the one
// claim about the dry run that GUIDE.md makes in quoted words.
//
// A SHARED host: every gesture here is a write to `~/.agentflow/templates`, and
// each test addresses its own template by name rather than asserting over the
// whole directory — which is what makes it safe to inherit the previous test's
// disk. The tests are deliberately ORDERED (`describeWithHost` configures
// serial): T1 creates the template T2 renames, T3 deletes what T2 renamed.

/** Write a run record straight into the store. HOME is the sandbox, so this is
 *  the same path the extension writes. Copied from `orchestrator-nodes.e2e.ts`
 *  rather than imported: the helper is not exported there, and a shared module
 *  for a four-line fixture is not worth the coupling. */
function seedRun(sb: Sandbox, run: Record<string, unknown>): string {
  const dir = path.join(sb.home, ".agentflow", "runs");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${run.key as string}.json`);
  fs.writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
  return file;
}

/** A card that renders as a `.card`, not a Recently-closed row: `createdAt:
 *  Date.now()` is what keeps the run off the closed shelf, and `repos[0]` is the
 *  sandbox's one real git checkout — the repo the demoted `planned` node below
 *  inherits. */
function seedCard(sb: Sandbox, key: string) {
  return seedRun(sb, {
    key, summary: `Run ${key}`, url: `https://fixture.invalid/browse/${key}`,
    createdAt: Date.now(), kind: "task", mode: "per-window",
    repos: [{ name: "rocket", path: sb.repoPath, isGit: true, branch: "main" }],
    briefPaths: [],
  });
}

const flowsDir = (sb: Sandbox) => path.join(sb.home, ".agentflow", "flows");

/** Write a flow straight to `~/.agentflow/flows/<id>.json` — that directory IS
 *  the store (`defaultFlowsDir`, store.ts). The filename must equal `<id>.json`
 *  (`readFlows` drops a record whose filename disagrees with its own `id`), and
 *  no edge carries an `action`: `writeFlow` derives it from the target, and a
 *  stored value that disagrees is what `latchActionMismatches` latches the edge
 *  dead for. */
function seedFlow(sb: Sandbox, flow: Record<string, unknown>): string {
  const dir = flowsDir(sb);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${flow.id as string}.json`);
  fs.writeFileSync(file, JSON.stringify(flow, null, 2) + "\n");
  return file;
}

/** Where `templates.ts`' envelopes land — `defaultTemplatesDir()` is
 *  `~/.agentflow/templates` (store.ts:249), one `<id>.json` per template, and
 *  HOME is the sandbox. Spelled out rather than imported: these specs assert the
 *  LOCATION, so reading it from the module under test would be vacuous. */
const templatesDir = (sb: Sandbox) => path.join(sb.home, ".agentflow", "templates");

interface StoredTemplate {
  schema: number;
  id: string;
  name: string;
  params: Record<string, never>;
  savedAt: number;
  flow: {
    id: string; name: string; armed: boolean; createdAt: number;
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
    launchConfirmedAt?: number;
    commandConfirmedAt?: number;
  };
}

/** Every template envelope on disk. Built-in starters are NOT here — they ship
 *  inside the extension (`STARTERS`, starters.ts) and `readTemplates` skips any
 *  file claiming a `builtin-` id — so this is exactly "the templates the user
 *  owns", which is the set every write below is about. */
function storedTemplates(sb: Sandbox): StoredTemplate[] {
  const dir = templatesDir(sb);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith(".json"))
    .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")) as StoredTemplate);
}

const storedByName = (sb: Sandbox, name: string): StoredTemplate | undefined =>
  storedTemplates(sb).find((t) => t.name === name);

/** The one card the source workflow is attached to. */
const CARD = "E2E-TPL";
/** The card carrying the gate flow the dry-run spec reads. */
const GATE_CARD = "E2E-GTE";

/** A live workflow with one place and one rule: exactly the shape "Save as
 *  template…" is for. Disarmed and left that way — nothing in this file ever
 *  arms it, so no pass ever acts and the fixture is stable to poll against.
 *
 *  The PLACE is the point: `toTemplate` has to demote it back to `planned` (a
 *  place binds a live `runKey`, which is the one thing a template must not
 *  carry), and that demotion is what the save dialog's prompt-mode and
 *  destination rows exist to ask about. */
const SOURCE_FLOW = {
  id: "e2e-tpl-src", name: "E2E Shape", armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: CARD, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "notify", message: "E2E-TPL-NOTIFY" },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" } }],
};

/** A gate that has already ASKED and is still unanswered — the state
 *  `evaluate.ts` posts `awaiting-answer` for, and the only one the dry run has
 *  anything to say about a gate in.
 *
 *  Reached by seeding the ask edge's receipt rather than by arming and waiting:
 *  `firedAt` + `performed` is precisely what `isMet`'s gate branch requires to
 *  distinguish an asked question from an unasked one ("a note for [an unasked
 *  gate] would tell you to answer a question nobody posed"), and it is the same
 *  shape a real pass writes. The flow stays DISARMED, which is the honest
 *  setting for a dry run: `previewFlow` arms a COPY, because "a dry run is the
 *  thing you read *before* arming". */
const GATE_FLOW = {
  id: "e2e-tpl-gate", name: "E2E Gate Preview", armed: false, createdAt: Date.now(),
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: GATE_CARD, repo: "rocket" },
    { id: "n2", x: 220, y: 0, join: "any", kind: "gate", question: "E2E-PREVIEW-Q" },
    { id: "n3", x: 440, y: 0, join: "any", kind: "notify", message: "E2E-PREVIEW-GO" },
  ],
  edges: [
    {
      id: "e1", from: "n1", to: "n2", cond: { kind: "tree-clean" },
      firedAt: Date.now(), firedNote: "asked you: E2E-PREVIEW-Q", performed: true,
    },
    { id: "e2", from: "n2", to: "n3", cond: { kind: "gate-approved" } },
  ],
};

describeWithHost(
  "the Templates tab",
  {
    // The setting this whole feature is gated behind — default off, per the
    // "ships inert" rule. Without it `postFlows` sends `enabled: false` with no
    // templates at all and every locator below times out.
    "agentFlow.orchestrator": true,
  },
  (ctx) => {
    /** The drawer's tab strip — one `role="tablist" aria-label="Orchestrator"`
     *  shared by all three screens (OrchestratorDrawer.tsx:760-770 on
     *  2026-09-04). */
    const tab = (deck: Deck, name: "Active" | "Templates" | "Canvas") =>
      deck.frame.getByRole("tablist", { name: "Orchestrator" }).getByRole("tab", { name });

    /** One row on the Templates tab — `.orch-tmpl-row` (OrchestratorDrawer.tsx:253
     *  on 2026-09-04), addressed by the name it shows. */
    const row = (deck: Deck, name: string) => deck.frame.locator(".orch-tmpl-row", { hasText: name });

    /** Show the Templates screen, from wherever the previous test left the UI.
     *  The drawer may be closed (nothing open yet), on Canvas, or already here —
     *  all three are reached the same way, because the Workflows/Templates header
     *  buttons and the tab strip are the only navigation this surface has. */
    async function templatesTab(deck: Deck): Promise<void> {
      const hd = deck.frame.locator(".orch-hd");
      if (await hd.count() === 0) {
        // The Deck header's own Templates button opens the drawer straight onto
        // this screen (DeckApp.tsx's `orchView` seed for it).
        await deck.frame.getByRole("button", { name: /^Templates/ }).click();
        await expect(hd).toBeVisible({ timeout: 30_000 });
      }
      await tab(deck, "Templates").click();
      await expect(tab(deck, "Templates")).toHaveAttribute("aria-selected", "true");
      await expect(deck.frame.locator(".orch-tmpl-list")).toBeVisible({ timeout: 15_000 });
    }

    /** Open one card's workflow on Canvas. Both halves are the real route: the
     *  block lives on the card, and "Open in Workflows ↗" is the only way from it
     *  into the drawer (WorkflowBlock.tsx:244 on 2026-09-04). Closes whatever the
     *  last test left open first — `onOpenWorkflow` clears the card selection on
     *  the way in, so a card is CLICKED, never merely revealed. */
    async function openOnCanvas(deck: Deck, key: string): Promise<Locator> {
      const hd = deck.frame.locator(".orch-hd");
      if (await hd.count() > 0) {
        await hd.getByRole("button", { name: "Close" }).click();
        await expect(hd).toHaveCount(0, { timeout: 15_000 });
      }
      await expect(deck.card(key)).toBeVisible({ timeout: 60_000 });
      await deck.card(key).click();
      const block = deck.workflowBlock();
      await expect(block).toBeVisible({ timeout: 30_000 });
      await block.getByRole("button", { name: /open in workflows/i }).click();
      await expect(hd).toBeVisible({ timeout: 30_000 });
      return hd;
    }

    // ── saving ────────────────────────────────────────────────────────────────

    // Mutation-checked: `writeTemplate` (store.ts:258) body replaced with `void io;
    // void dir; void t;` — the plan's own "write nothing" break. The dialog closed
    // as if it had saved and the drawer showed only the three starters; the poll for
    // the file on disk timed out.
    test("saving a flow as a template lists it by name with its rule count", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const sb = ctx.sb();
      const deck = await Deck.open(ctx.page());
      // Nothing of the user's own yet. The three starters are not on disk at all
      // (they ship inside the extension), so an empty directory here is the
      // honest "no templates saved".
      expect(storedTemplates(sb)).toEqual([]);

      const orch = await openOnCanvas(deck, CARD);
      await expect(orch.locator(".orch-name")).toHaveValue("E2E Shape");
      await orch.getByRole("button", { name: "Save as template…" }).click();

      const dlg = deck.frame.locator('[data-testid="orch-save-template"]');
      await expect(dlg).toBeVisible({ timeout: 15_000 });
      // One row per place this save has to demote, asking the two things a
      // `PlaceNode` cannot give back — `promoteToPlace` destroyed the planned node
      // they lived on, and a place created by a Take never had them. `endLabel`
      // names the row after the place itself.
      await expect(dlg.getByLabel(/^Prompt mode for /)).toBeVisible();
      await expect(dlg.getByLabel(/^Destination for /)).toBeVisible();
      // Unnamed is unsaveable — a clearer no before the click than a toast after it.
      await expect(dlg.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
      await dlg.getByLabel("Name").fill("E2E Saved Shape");
      await shot(ctx.page(), testInfo, "1 · the save dialog, naming the shape");
      await dlg.getByRole("button", { name: "Save", exact: true }).click();

      // THE assertion of record: an envelope in `~/.agentflow/templates`, one
      // file, named by an id the host minted.
      await expect.poll(() => storedTemplates(sb).map((t) => t.name), { timeout: 30_000 })
        .toEqual(["E2E Saved Shape"]);
      const saved = storedByName(sb, "E2E Saved Shape")!;
      const dir = templatesDir(sb);
      expect(fs.readdirSync(dir)).toEqual([`${saved.id}.json`]);
      expect(saved.schema).toBe(1);
      expect(saved.params).toEqual({});
      expect(saved.savedAt).toBeGreaterThan(0);
      // An ENVELOPE, never a bare flow: a `Flow` sitting in this directory would
      // be indistinguishable from one somebody moved here, and a reader pointed at
      // either would load it as a real, armable workflow.
      expect(saved.flow.edges).toHaveLength(1);

      // The SHAPE, with everything that only makes sense on something that has run
      // taken out (`normalizedTemplateFlow`): no id, disarmed, no creation time.
      expect(saved.flow.id).toBe("");
      expect(saved.flow.armed).toBe(false);
      expect(saved.flow.createdAt).toBe(0);
      // …and no consent, ever. A template carrying `launchConfirmedAt` or
      // `commandConfirmedAt` would multiply one approval by every card it is later
      // attached to.
      expect(saved.flow.launchConfirmedAt).toBeUndefined();
      expect(saved.flow.commandConfirmedAt).toBeUndefined();

      // The place is gone and a `planned` node stands in its place, with the
      // ticket — the ONE parameter — left blank for `instantiate` to bind, and the
      // dialog's two answers stored beside it.
      expect(saved.flow.nodes[0]).toMatchObject({
        id: "n1", kind: "planned", ticketKey: "", repos: ["rocket"], dest: "worktree",
      });
      expect(String(saved.flow.nodes[0].mode).length).toBeGreaterThan(0);
      expect(saved.flow.nodes[1]).toMatchObject({ kind: "notify", message: "E2E-TPL-NOTIFY" });

      // And the row, which is the half a person sees: the name they typed and how
      // many rules the shape holds. Singular "rule", not "rules" — the row counts
      // and says so, and this shape has exactly one.
      await templatesTab(deck);
      const saveRow = row(deck, "E2E Saved Shape");
      await expect(saveRow).toBeVisible({ timeout: 30_000 });
      await expect(saveRow).toContainText("1 rule");
      // Independent of the workflow it came from: `toTemplate` COPIED the shape,
      // so the live flow on E2E-TPL is not "made from" this template and the row
      // says zero rather than one.
      await expect(saveRow).toContainText("on 0 cards");
      await shot(ctx.page(), testInfo, "2 · the shape, listed by name and rule count");
    });

    // ── editing ───────────────────────────────────────────────────────────────

    // Mutation-checked: `flow:writeTemplate`'s update-in-place branch (deckView.ts:4607)
    // `{ ...existing, name: m.name, flow, savedAt: now }` → `{ ...existing, flow,
    // savedAt: now }`, so Save wrote the edited graph back under the OLD name. The
    // file kept "E2E Saved Shape" and the poll for the new name timed out.
    test("editing a saved template renames it", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const sb = ctx.sb();
      const deck = await Deck.open(ctx.page());
      await templatesTab(deck);
      const before = storedByName(sb, "E2E Saved Shape")!;

      // Edit is offered on a user's own template and on no built-in — Duplicate
      // is the supported path to owning an editable copy of a starter.
      await row(deck, "E2E Saved Shape").getByRole("button", { name: "Edit", exact: true }).click();

      // Canvas, opened on the template's OWN graph under its own id. The verbs a
      // WORKFLOW has are absent rather than disabled here: nothing arms, dry-runs
      // or saves-as-template a bare shape, and `editingTemplate`'s own two
      // controls take their place.
      const orch = deck.frame.locator(".orch-hd");
      await expect(orch).toBeVisible({ timeout: 30_000 });
      await expect(orch.locator(".orch-name")).toHaveValue("E2E Saved Shape");
      await expect(orch.getByRole("button", { name: "Arm", exact: true })).toHaveCount(0);
      await expect(orch.getByRole("button", { name: "Save as template…" })).toHaveCount(0);
      await expect(orch.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
      await shot(ctx.page(), testInfo, "1 · the saved template, reopened on Canvas");

      // The name field IS the template's name while editing — one input, not a
      // second piece of state. It commits on blur, into the in-memory working
      // copy; nothing reaches disk until Save.
      await orch.locator(".orch-name").fill("E2E Renamed Shape");
      await orch.locator(".orch-name").blur();
      expect(storedByName(sb, "E2E Renamed Shape")).toBeUndefined();
      await orch.getByRole("button", { name: "Save", exact: true }).click();

      // THE assertion of record: the SAME file, renamed in place. Not a second
      // template — Save on an id already in `templates` is the update branch, and
      // a new file here would leave the picker holding two of the same shape.
      await expect.poll(() => storedTemplates(sb).map((t) => t.name), { timeout: 30_000 })
        .toEqual(["E2E Renamed Shape"]);
      const after = storedByName(sb, "E2E Renamed Shape")!;
      expect(after.id).toBe(before.id);
      expect(fs.readdirSync(templatesDir(sb))).toEqual([`${before.id}.json`]);
      // The shape itself came through unchanged, and still normalized.
      expect(after.flow.edges).toHaveLength(1);
      expect(after.flow.id).toBe("");
      expect(after.flow.armed).toBe(false);
      expect(after.flow.nodes[0]).toMatchObject({ kind: "planned", ticketKey: "", repos: ["rocket"] });
      // Both names live in the envelope, and both moved: `normalizedTemplateFlow`
      // writes the new name onto the inner flow too, so a template whose row says
      // one thing and whose canvas title says another is not reachable.
      expect(after.flow.name).toBe("E2E Renamed Shape");
      expect(after.savedAt).toBeGreaterThanOrEqual(before.savedAt);

      // Saving leaves template-editing entirely, back to the Templates screen,
      // where the row now reads the new name and the old one is gone.
      await expect(tab(deck, "Templates")).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
      await expect(row(deck, "E2E Renamed Shape")).toBeVisible({ timeout: 30_000 });
      await expect(row(deck, "E2E Saved Shape")).toHaveCount(0);
      await shot(ctx.page(), testInfo, "2 · renamed, in place");
    });

    // ── deleting ──────────────────────────────────────────────────────────────

    // Mutation-checked: `TemplateRow`'s Delete (OrchestratorDrawer.tsx:310)
    // `onClick={() => setConfirming(true)}` → `onClick={onDelete}`, i.e. no
    // confirmation at all. The first click deleted the file outright: the
    // confirmation row never appeared and the wait for it timed out.
    test("deleting a template confirms first", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const sb = ctx.sb();
      const deck = await Deck.open(ctx.page());
      await templatesTab(deck);
      const target = storedByName(sb, "E2E Renamed Shape")!;
      const file = path.join(templatesDir(sb), `${target.id}.json`);
      const tmplRow = row(deck, "E2E Renamed Shape");

      await tmplRow.getByRole("button", { name: "Delete", exact: true }).click();
      // The confirmation says both halves — what Delete does, and what it
      // deliberately leaves alone. A workflow built from this template copied the
      // shape, so it is its own independent flow the moment it exists.
      await expect(tmplRow).toContainText("Delete “E2E Renamed Shape”?", { timeout: 15_000 });
      await expect(tmplRow).toContainText("Workflows already made from it keep running.");
      await expect(tmplRow.getByRole("button", { name: "Confirm delete", exact: true })).toBeVisible();
      // Nothing has happened yet: the file is untouched while the question is up.
      expect(fs.existsSync(file)).toBe(true);
      await shot(ctx.page(), testInfo, "1 · the confirmation, before anything is gone");

      // Cancel backs out and leaves the file exactly where it was — and puts the
      // ordinary verbs back, so the row is not left in a half-confirmed state.
      await tmplRow.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(tmplRow.getByRole("button", { name: "Confirm delete", exact: true })).toHaveCount(0);
      await expect(tmplRow.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
      expect(fs.existsSync(file)).toBe(true);
      expect(storedTemplates(sb).map((t) => t.name)).toEqual(["E2E Renamed Shape"]);

      // Confirm does. THE assertion of record: the file is gone from the store.
      await tmplRow.getByRole("button", { name: "Delete", exact: true }).click();
      await tmplRow.getByRole("button", { name: "Confirm delete", exact: true }).click();
      await expect.poll(() => storedTemplates(sb).map((t) => t.name), { timeout: 30_000 }).toEqual([]);
      expect(fs.existsSync(file)).toBe(false);
      await expect(row(deck, "E2E Renamed Shape")).toHaveCount(0, { timeout: 30_000 });
      // The workflow the shape came from is untouched — a delete removes only the
      // template, and `Flow.fromTemplate` dangling is a count nobody asks for any
      // more, never a broken workflow.
      expect(fs.existsSync(path.join(flowsDir(sb), "e2e-tpl-src.json"))).toBe(true);
      await shot(ctx.page(), testInfo, "2 · gone, and only the starters left");
    });

    // ── the built-in starters ─────────────────────────────────────────────────

    // Mutation-checked: `TemplateRow`'s (OrchestratorDrawer.tsx:251) `const builtin =
    // isBuiltinTemplateId(t.id)` → `const builtin = false`, the "a second copy of
    // is-this-a-starter drifts from the host's own check" failure its doc comment
    // names. The Built-in mark vanished and Rename/Edit/Delete appeared on all
    // three starters; both halves of this spec failed.
    test("built-in starters are marked and cannot be deleted", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const deck = await Deck.open(ctx.page());
      await templatesTab(deck);

      // Three starters, served alongside whatever the user owns — and after the
      // spec above, they are all that is left, which is what makes this count
      // exact rather than a lower bound.
      await expect(deck.frame.locator(".orch-tmpl-row")).toHaveCount(3, { timeout: 30_000 });
      for (const name of ["Ship it", "Test & notify", "Review only"]) {
        const starter = row(deck, name);
        await expect(starter).toBeVisible();
        // Marked, quietly: being built-in is neither a warning nor a failure,
        // just a fact about where the shape came from.
        await expect(starter).toContainText("Built-in");
        // ABSENT, not disabled — "a disabled button still needs a reason shown
        // somewhere", and a disabled control would still answer a `getByRole`
        // query while failing server-side.
        await expect(starter.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
        await expect(starter.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
        await expect(starter.getByRole("button", { name: "Edit", exact: true })).toHaveCount(0);
        // Duplicate is the one supported path to owning a version you can change,
        // and it is offered unconditionally.
        await expect(starter.getByRole("button", { name: "Duplicate", exact: true })).toBeVisible();
      }
      await shot(ctx.page(), testInfo, "1 · three starters, marked and undeletable");
    });

    // ── the dry run ───────────────────────────────────────────────────────────

    // Pinned: GUIDE.md § The Deck quotes the dry run's own wording — a rule
    // waiting on a gate "reads \"it is waiting on your answer\" there". The
    // product says "waiting for your answer" (`reasonWhy`, orchestratorRule.ts:1037
    // on 2026-09-04) — no "it is", and "for" rather than "on". The panel, the
    // verdict and the row are all real; only the quoted sentence is not.
    //
    // Mutation-checked: `reasonWhy`'s `awaiting-answer` arm changed to return the
    // doc's exact sentence, which is the fix this pin is waiting for — the test
    // then PASSED, and `test.fail()` reported it as an unexpected pass. So this
    // pin fails for the documented reason and for no other.
    test.fail("a dry run reports a waiting gate in words", async ({}, testInfo) => {
      test.setTimeout(240_000);
      const deck = await Deck.open(ctx.page());
      const orch = await openOnCanvas(deck, GATE_CARD);
      await orch.getByRole("button", { name: "What would fire?" }).click();

      const dry = deck.frame.locator('[data-testid="orch-dryrun"]');
      await expect(dry).toBeVisible({ timeout: 15_000 });
      await shot(ctx.page(), testInfo, "1 · the dry run's verdict on a waiting gate");
      // The one documented fact, and nothing else: a pinned test asserts the doc's
      // claim alone, so what the product DOES say is recorded in the comment above
      // rather than smuggled in here as a second assertion.
      await expect(dry).toContainText("it is waiting on your answer", { timeout: 15_000 });
    });
  },
  (sb) => {
    // `prepare` runs between `makeSandbox` and `launchHost` — the only window in
    // which state the webview reads at init can be shaped. Everything here is a
    // file in the real store.
    seedCard(sb, CARD);
    seedFlow(sb, SOURCE_FLOW);
    seedCard(sb, GATE_CARD);
    seedFlow(sb, GATE_FLOW);
  },
);
