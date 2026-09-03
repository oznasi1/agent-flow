import { test, expect } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import * as React from "react";
import { OrchestratorDrawer } from "../src/webview/OrchestratorDrawer";
import type { Flow } from "../src/engine/orchestrator/model";
import type { FlowTemplate } from "../src/engine/orchestrator/templates";

/**
 * Two CSS-only fixes on the Templates tab (`OrchestratorDrawer.tsx`'s
 * `TemplateRow`) that no `className` assertion can see, because neither
 * changed a class name — both changed what a rule DOES:
 *
 *  - `.orch-tmpl-row .row` carries its own `gap: 6px` (the ancestor
 *    `.orch-hd .row` — see `orchestratorStyles.ts`'s own comment on it — uses
 *    8px and already supplies `display: flex` to every `.row` nested under
 *    `.orch-hd`, template rows included, since before this fix ever landed).
 *    Without the 6px gap here the confirm-delete state's Cancel/Confirm pair
 *    sits closer to the sentence than this row's own siblings do.
 *  - `.orch-kw` is a 40px column sized for "WHEN"/"THEN" (four letters), but
 *    the Save dialog hands it an arbitrary run key (`endLabel` — a place
 *    node's own `runKey`, verbatim). A long one needs a wider, single-line
 *    column that stops short of the select beside it, rather than a cramped
 *    40px cell or one that grows past the select.
 *
 * jsdom has no layout engine: every `span` it renders sits at (0,0) with a
 * 0×0 box regardless of `display`, so "on one line" and "stacked on two
 * lines" produce identical jsdom output. Only real Chromium computes a real
 * line box.
 *
 * A mutation-check surfaced something the original fix's own commit message
 * got wrong, confirmed by walking the git history: `.orch-hd .row` and
 * `.orch-hd .sp` predate the Templates tab fix, and the tab has lived inside
 * `.orch-hd` since ITS first commit too — so the ancestor rule always
 * reached these elements, and the "name and rule count jam together with no
 * gap" bug the fix's commit message describes never actually shipped.
 * `.orch-tmpl-row .sp { flex: 1 }` was accordingly dead (identical property
 * and value to the ancestor `.orch-hd .sp`) and has been deleted;
 * `.orch-tmpl-row .row`'s `display: flex` is kept as insurance against a
 * plausible future refactor (moving the tab out from under `.orch-hd`, the
 * way its own Save dialog already lives in `.orch-body` instead) rather than
 * because it does anything today — see that rule's own comment in
 * `orchestratorStyles.ts`. The two layout tests below still stand as CI
 * gates for the OUTCOME (one line, a real gap), just not ones sensitive to
 * either specific declaration in isolation; a mutation removing flex from
 * BOTH the specific rule and `.orch-hd .row` at once does fail them.
 */

const noop = () => {};

type Box = { x: number; y: number; width: number; height: number };

/** Two boxes are on the same visual line iff their vertical ranges overlap.
 *  Stacked boxes — one below the other, the actual failure mode a "same
 *  line" assertion in this file exists to catch — have disjoint vertical
 *  ranges (zero overlap) no matter the font stack. Top-edge proximity
 *  (`Math.abs(a.y - b.y) < N`) is a proxy for that, and a bad one: a text
 *  span and a `<button>` on the same line legitimately have different box
 *  tops, by an amount that depends on font metrics. That proxy measured
 *  4.5px on GitHub's ubuntu runner for a sentence/button pair that was
 *  genuinely on one line, while measuring under 4px for the same DOM on
 *  macOS — a real font-stack difference, not a layout regression — so it
 *  failed CI on Linux while passing locally. Overlap has no such tolerance
 *  to tune and still fails hard on the regression these tests guard: no
 *  `display: flex` → the block `.sp` breaks the line → the two elements end
 *  up on disjoint vertical ranges. */
function sameLine(a: Box, b: Box): boolean {
  return a.y < b.y + b.height && b.y < a.y + a.height;
}

function templateFrom(flow: Flow, name: string): FlowTemplate {
  return { schema: 1, id: `${flow.id}-tmpl`, name, params: {}, savedAt: 1_000, flow };
}

/** A place node feeding a notify terminal — `canBindTicket` needs at least
 *  one place or planned node before `Save as template…` is even enabled
 *  (`OrchestratorDrawer.tsx`'s own guard), and `endLabel` reads a place
 *  node's `runKey` verbatim, which is the field the Save dialog's `.orch-kw`
 *  renders. A long, hyphenated key is the realistic shape this is guarding —
 *  Jira project keys are not bounded to four characters. */
const LONG_KEY = "PROJ-142-super-long-run-key";
const flow: Flow = {
  id: "f1", name: "Ship it", armed: false, createdAt: 1_000,
  nodes: [
    { id: "n1", x: 0, y: 0, join: "any", kind: "place", runKey: LONG_KEY, repo: "webapp" },
    { id: "n2", x: 0, y: 0, join: "any", kind: "notify", message: "" },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", cond: { kind: "pr-merged" } }],
};

const props = {
  flows: [flow], openId: { kind: "flow" as const, id: "f1" }, runs: [], pendingResume: [], promptModes: [], commands: [], branchCi: {}, templates: [], draftTemplate: null,
  // Canvas by default: the third test below (the Save-as-template dialog) is
  // a Canvas-only control. The first two override this to "templates" — see
  // `openTemplatesTab`'s own comment for why a click can no longer get there.
  view: "canvas" as const, onView: noop, rows: [], onOpenCard: noop,
  onClose: noop, onCreate: noop, onOpen: noop, onRename: noop, onSave: noop, onDelete: noop,
  onArm: noop, onResumeApprove: noop, onResumeDisarm: noop, onResetEdge: noop,
  onNewTemplate: noop, onCancelTemplate: noop, onEditTemplate: noop,
};

/** The drawer slides in the same way the card drawer does (`ORCH_ANIM_MS` —
 *  see `OrchestratorDrawer.canvas.spec.tsx`'s own header comment) — settle on
 *  the header row before clicking anything positioned by it. */
async function settled(page: Page, selector: string) {
  const el = page.locator(selector);
  let last = await el.boundingBox();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(25);
    const now = await el.boundingBox();
    if (last && now && now.x === last.x && now.y === last.y) return now;
    last = now;
  }
  throw new Error(`${selector} never stopped moving`);
}

// Templates is now a top-level view controlled by `view`/`onView` (Task 9),
// not a sub-tab behind the old "Flows · N ▾" disclosure — so nothing needs
// clicking to reach it any more. `onView` is a plain `noop` here with no
// state feeding back into `view`, so a click would call it without changing
// what renders; the caller mounts with `view="templates"` directly instead
// (see the two mounts below), and this only waits for the header's slide-in
// to settle before anything measures a bounding box against it.
async function openTemplatesTab(page: Page) {
  await settled(page, ".orch-hd");
}

test("a template row keeps its name and rule count on one line, with a real gap between them", async ({ mount, page }) => {
  await mount(<OrchestratorDrawer {...props} view="templates" templates={[templateFrom(flow, "Ship it")]} />);
  await openTemplatesTab(page);

  const name = page.locator(".orch-tmpl-row .t", { hasText: "Ship it" });
  const count = page.locator(".orch-tmpl-row .meta", { hasText: "rule" });
  await expect(name).toBeVisible();
  await expect(count).toBeVisible();

  const nameBox = (await name.boundingBox())!;
  const countBox = (await count.boundingBox())!;
  // Same line: vertical ranges overlap (see `sameLine`'s own comment for why
  // this isn't top-edge proximity). Stacked — the regression this guards —
  // would leave them with zero overlap.
  expect(sameLine(nameBox, countBox)).toBe(true);
  // A real gap, not merely non-overlapping: `.row`'s own `gap: 6px` plus
  // `.sp`'s `flex: 1` is what pushes the count to the row's far end rather
  // than letting it sit flush against the name.
  expect(countBox.x).toBeGreaterThan(nameBox.x + nameBox.width + 4);
});

test("the delete confirmation keeps Cancel and Confirm on the same line as the sentence", async ({ mount, page }) => {
  await mount(<OrchestratorDrawer {...props} view="templates" templates={[templateFrom(flow, "Ship it")]} />);
  await openTemplatesTab(page);

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  const sentence = page.getByText(/Delete .Ship it.\?/);
  const cancel = page.getByRole("button", { name: "Cancel" });
  const confirm = page.getByRole("button", { name: "Confirm delete" });
  await expect(sentence).toBeVisible();

  const sentenceBox = (await sentence.boundingBox())!;
  const cancelBox = (await cancel.boundingBox())!;
  const confirmBox = (await confirm.boundingBox())!;
  // Same line: vertical ranges overlap, not top-edge proximity — see
  // `sameLine`'s own comment. This is the assertion that actually flaked:
  // it measured 4.5px of top-edge offset on GitHub's ubuntu runner for a
  // sentence/Cancel pair that was genuinely on one line (a font-metrics
  // difference between a text span and a `<button>`, not a stacking
  // regression), while measuring under 4px on macOS for the same DOM.
  expect(sameLine(sentenceBox, cancelBox)).toBe(true);
  expect(sameLine(cancelBox, confirmBox)).toBe(true);
  // Reading order left to right, each with daylight between it and the next —
  // the failure mode this guards is EVERYTHING landing at x=0 on its own row.
  expect(cancelBox.x).toBeGreaterThan(sentenceBox.x + sentenceBox.width - 4);
  expect(confirmBox.x).toBeGreaterThan(cancelBox.x + cancelBox.width - 4);
});

// Named narrowly on purpose: no DOM API exposes whether an "…" glyph was
// actually painted (that is a rendered-pixel fact, not a computed-style one),
// so this cannot claim to prove "ellipsized" — only what it can actually
// observe. What it proves: the long key gets a WIDER column than the base
// `.orch-kw`'s 40px (sized for "WHEN"/"THEN"), stays on one line rather than
// wrapping into it, and never pushes the select outside the dialog. That is
// the whole visible complaint the fix targets — a cramped, multi-line, or
// colliding cell — even though the exact clipping mechanism (`text-overflow:
// ellipsis` specifically, vs. some other clip) is outside what this test can
// see.
test("a long run key in the Save-as-template dialog widens its own column, stays on one line, and never collides with the select", async ({ mount, page }) => {
  await mount(<OrchestratorDrawer {...props} />);
  await settled(page, ".orch-hd");
  await page.getByRole("button", { name: /Save as template/ }).click();

  const dialog = page.getByTestId("orch-save-template");
  await expect(dialog).toBeVisible();
  const kw = dialog.locator(".orch-kw", { hasText: LONG_KEY });
  await expect(kw).toBeVisible();
  const select = dialog.locator(".orch-sel").first();

  const kwBox = (await kw.boundingBox())!;
  const selectBox = (await select.boundingBox())!;
  const metrics = await kw.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, height: el.getBoundingClientRect().height }));

  // Single line, not wrapped: without `white-space: nowrap` the browser's
  // first instinct for text that doesn't fit a fixed-width box is to WRAP it
  // (Chromium treats a hyphen as a line-break opportunity, so this exact key
  // wraps into ~6 short lines) rather than overflow horizontally — which
  // very nearly defeats the whole point of this test, because a wrapped
  // box's `scrollWidth` comes out only a couple of CSS pixels wider than its
  // `clientWidth` (font-metric rounding), not zero. An assertion that only
  // checked `scrollWidth > clientWidth` passed against BOTH the fixed CSS
  // and a mutant with `white-space: nowrap` deleted — this height check is
  // what tells them apart.
  expect(metrics.height).toBeLessThan(20);
  // The text's real, unwrapped width must exceed the box it was actually
  // given by more than rounding noise — the real fix measures 87px of
  // overflow here (187 vs 100); the wrapped mutant above measured 2.
  expect(metrics.scrollWidth - metrics.clientWidth).toBeGreaterThan(20);

  // Wider than the base `.orch-kw`'s 40px, not just narrower than the cap:
  // an EARLIER version of this test only asserted `kwBox.width <= 100.5`,
  // which the base 40px column (sized for "WHEN"/"THEN") also satisfies —
  // deleting `.orch-tmpl-dialog .orch-kw`'s `width: auto; max-width: 100px`
  // while leaving `white-space: nowrap`/`overflow: hidden` in place produces
  // exactly the cramped 40px cell the fix targeted, showing only "PR…", and
  // every other assertion here still passed. This lower bound is what a
  // mutation-check of that partial deletion actually needs to fail.
  expect(kwBox.width).toBeGreaterThan(60);
  expect(kwBox.width).toBeLessThanOrEqual(100.5);
  expect(kwBox.x + kwBox.width).toBeLessThanOrEqual(selectBox.x + 0.5);
});
