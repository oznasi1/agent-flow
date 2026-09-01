import { test, expect } from "@playwright/experimental-ct-react";
import * as React from "react";
import { DeckApp } from "../src/webview/DeckApp";
import { WorkflowBlock, WorkflowBlockProps } from "../src/webview/WorkflowBlock";
import { host } from "./_helpers/host";
import { tokenColor, elementColor } from "./_helpers/colors";
import { mkStatus, runsMsg, flowsMsg, shipItOn, gateOn, failedOn, doneOn, place, notify, edge } from "./_helpers/deckFixtures";
import type { Flow } from "../src/engine/orchestrator/model";
import type { StepState, WorkflowStatus } from "../src/engine/orchestrator/attach";

/**
 * §6's whole rule — "amber means exactly one thing on this board and red
 * means a real failure, so a workflow that is merely attached and fine must
 * be neither" — lives ENTIRELY in which CSS custom property a class name is
 * wired to (`deckStyles.ts`'s `.c-wf.*`/`.wf-chip.*`/`.wf-step.*` rules).
 * `test/webview/DeckApp.test.tsx` and `workflowBlock.test.tsx` already assert
 * the class names (jsdom can hold that much) and, separately, regex-match
 * DECK_CSS's own text to check which selectors mention which token name —
 * but neither can catch swapping what `--c-attn` and `--c-danger` themselves
 * RESOLVE TO, or a rule quietly pointed at the wrong variable while every
 * selector and every token NAME stays exactly as written. That swap leaves
 * every class-name assertion and every regex in the existing ~6,300-test
 * suite green while a healthy, advancing workflow paints itself the colour
 * of a real failure.
 *
 * `tokenColor` (test-ct/_helpers/colors.ts) resolves a token the same way
 * the real component would — through `var(--token)` in a live browser — so
 * this stays correct if a token's fallback hex is ever edited; no hex is
 * hardcoded here.
 */

// Guards the method every test below relies on: each one compares an
// element's painted colour to `tokenColor(page, "--some-var")`, so if
// `tokenColor` itself stopped discriminating tokens (a broken selector in
// its throwaway probe, or `playwright/index.tsx` no longer injecting
// TOKENS_CSS at all) every `.not.toBe()` below could start passing for the
// wrong reason and every `.toBe()` could start failing in a way that reads
// as an unrelated colour bug rather than a hole in the test's own premise.
// `tokens.test.ts` already fails CI on a renamed/deleted token; this is the
// CT-side half of the same guarantee — that the four tokens this whole file
// leans on are still four distinct, live values.
test("the four status tokens this file leans on resolve to four different colours", async ({ mount, page }) => {
  await mount(<DeckApp />);
  const [progress, attn, danger, done] = await Promise.all([
    tokenColor(page, "--c-progress"), tokenColor(page, "--c-attn"),
    tokenColor(page, "--c-danger"), tokenColor(page, "--c-done"),
  ]);
  expect(new Set([progress, attn, danger, done]).size).toBe(4);
});

test("an advancing card's chip is the quiet blue, not amber or red", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await host(page, flowsMsg([shipItOn("PROJ-142")]));
  await host(page, runsMsg([mkStatus({ run: { ...mkStatus().run, key: "PROJ-142" } })]));

  const chip = page.locator(".c-wf");
  await expect(chip).toBeVisible();
  const [got, progress, attn, danger] = await Promise.all([
    elementColor(chip), tokenColor(page, "--c-progress"), tokenColor(page, "--c-attn"), tokenColor(page, "--c-danger"),
  ]);
  expect(got).toBe(progress);
  expect(got).not.toBe(attn);
  expect(got).not.toBe(danger);
});

test("a waiting-on-you card's chip is amber", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await host(page, flowsMsg([gateOn("PROJ-142")]));
  await host(page, runsMsg([mkStatus({ run: { ...mkStatus().run, key: "PROJ-142" } })]));

  const chip = page.locator(".c-wf");
  await expect(chip).toBeVisible();
  expect(await elementColor(chip)).toBe(await tokenColor(page, "--c-attn"));
});

test("a stopped card's chip is red", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await host(page, flowsMsg([failedOn("PROJ-142")]));
  await host(page, runsMsg([mkStatus({ run: { ...mkStatus().run, key: "PROJ-142" } })]));

  const chip = page.locator(".c-wf");
  await expect(chip).toBeVisible();
  expect(await elementColor(chip)).toBe(await tokenColor(page, "--c-danger"));
});

test("a done card's chip is green", async ({ mount, page }) => {
  await mount(<DeckApp />);
  await host(page, flowsMsg([doneOn("PROJ-142")]));
  await host(page, runsMsg([mkStatus({ run: { ...mkStatus().run, key: "PROJ-142" } })]));

  const chip = page.locator(".c-wf");
  await expect(chip).toBeVisible();
  expect(await elementColor(chip)).toBe(await tokenColor(page, "--c-done"));
});

// WorkflowBlock's own five step marks — the drawer's presentation of the
// same states, and a second place the same swap could hide (the block and
// the card chip read the SAME `state.status`/step `state` but through two
// entirely different stylesheets rules — `.wf-chip`/`.wf-mark` vs `.c-wf`).
const noopBlock: Omit<WorkflowBlockProps, "flow" | "state"> = {
  extraCount: 0, onAttach: () => {}, onArm: () => {}, onDetach: () => {},
  onAnswerGate: () => {}, onResetEdge: () => {}, onOpenInWorkflows: () => {},
};

const blockFlow: Flow = {
  id: "f1", name: "Ship it", armed: true, createdAt: 0,
  nodes: [place("n1", "PROJ-142"), notify("n2")],
  edges: [edge({ id: "e1", from: "n1", to: "n2" })],
};

function oneStep(state: StepState["state"], status: WorkflowStatus) {
  return <WorkflowBlock {...noopBlock} flow={blockFlow} state={{ status, done: 0, total: 1, steps: [{ edgeId: "e1", state }] }} />;
}

test("WorkflowBlock hues its five step marks to the same tokens the card chip uses", async ({ mount, page }) => {
  const cases: StepState["state"][] = ["done", "now", "waiting", "you", "fail"];
  for (const state of cases) {
    const status: WorkflowStatus = state === "you" ? "waiting-on-you" : state === "fail" ? "stopped" : "advancing";
    const component = await mount(oneStep(state, status));
    const mark = page.locator("li.wf-step .wf-mark");
    await expect(mark).toBeVisible();
    const got = await elementColor(mark);
    if (state === "you") expect(got).toBe(await tokenColor(page, "--c-attn"));
    else if (state === "fail") expect(got).toBe(await tokenColor(page, "--c-danger"));
    else if (state === "now") expect(got).toBe(await tokenColor(page, "--c-progress"));
    else if (state === "done") expect(got).toBe(await tokenColor(page, "--c-done"));
    else {
      // "waiting": deliberately the quiet default, never one of the two
      // attention hues — a step merely NEXT IN LINE must not compete
      // visually with a step that actually needs a human. Not asserted as
      // `.toBe(tokenColor(page, "--dim"))`: `--dim` is
      // `var(--vscode-descriptionForeground)` with no literal fallback of
      // its own, so in this plain-browser harness (no VS Code variables
      // defined) it resolves to the same guaranteed-invalid → inherited
      // black every OTHER undeclared property would, making that equality
      // vacuously true regardless of which colour `.wf-mark` actually used.
      // The two inequalities below are what §6 actually asks for here.
      const [attn, danger] = await Promise.all([tokenColor(page, "--c-attn"), tokenColor(page, "--c-danger")]);
      expect(got).not.toBe(attn);
      expect(got).not.toBe(danger);
    }
    await component.unmount();
  }
});

test("the header chip of a waiting-on-you workflow is amber and of a stopped one is red", async ({ mount, page }) => {
  const waiting = await mount(
    <WorkflowBlock {...noopBlock} flow={blockFlow} state={{ status: "waiting-on-you", done: 0, total: 1, steps: [{ edgeId: "e1", state: "waiting" }] }} />,
  );
  const waitingChip = page.locator(".wf-chip");
  expect(await elementColor(waitingChip)).toBe(await tokenColor(page, "--c-attn"));
  await waiting.unmount();

  const stopped = await mount(
    <WorkflowBlock {...noopBlock} flow={blockFlow} state={{ status: "stopped", done: 0, total: 1, steps: [{ edgeId: "e1", state: "waiting" }] }} />,
  );
  const stoppedChip = page.locator(".wf-chip");
  expect(await elementColor(stoppedChip)).toBe(await tokenColor(page, "--c-danger"));
  await stopped.unmount();
});
