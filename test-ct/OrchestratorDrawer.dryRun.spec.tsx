import { test, expect } from "@playwright/experimental-ct-react";
import * as React from "react";
import { OrchestratorDrawer } from "../src/webview/OrchestratorDrawer";
import type { Flow } from "../src/engine/orchestrator/model";
import type { PrEntryMap, PrFacts, RunStatus } from "../src/types";

/**
 * The dry-run panel's one claim jsdom cannot check: the rows scroll and the
 * footer does not.
 *
 * That footer is what keeps the verdict from reading as a promise — it names
 * what `previewFlow` does NOT cover (deckView's per-target dedupe, the resume
 * gate, the ask on a flow's first spend). A first version of the panel put it
 * inside the scrolling box, where a flow with six rules pushed it out of sight;
 * the Vitest suite pins the DOM shape that fixes it, but "shape" is not the
 * claim. The claim is geometry, and only a real engine has any.
 */

const pr = (over: Partial<PrFacts> = {}): PrFacts => ({
  number: 1, url: "u", title: "t", state: "OPEN", isDraft: false,
  ci: { passing: 2, pending: 0, failing: [] }, review: "none", unresolved: null,
  mergeable: "clean", ciAdvisory: false, ...over,
});

const status = (key: string, repo: string, merged: boolean): RunStatus => {
  const prs: PrEntryMap = { [repo]: { facts: pr({ state: merged ? "MERGED" : "OPEN" }), fetchedAt: 1 } };
  return {
    run: { key, summary: "s", url: `https://j/browse/${key}`, createdAt: 1, mode: "multiroot",
      repos: [{ name: repo, path: `/r/${repo}`, isGit: true }], briefPaths: [] },
    column: "progress", ticketStatus: "In Progress", ticketCategory: "indeterminate",
    repos: [{ name: repo, path: `/r/${repo}`, branch: "b", dirty: false, ahead: 0, added: 0, removed: 0, files: 0 }],
    agent: { state: "working", lastActivityMs: 1, slug: null },
    windowOpen: true, prs, agents: [], shelf: "board",
  };
};

/** Ten rules — comfortably more than the panel's height can hold, so the
 *  overflow this test is about is not marginal. */
const N = 10;

const many = (): { flow: Flow; runs: RunStatus[] } => {
  const nodes: Flow["nodes"] = [];
  const edges: Flow["edges"] = [];
  const runs: RunStatus[] = [];
  for (let i = 0; i < N; i++) {
    nodes.push({ id: `a${i}`, kind: "place", x: 20, y: 20 + i * 70, join: "any", runKey: `PROJ-${i}`, repo: `repo-${i}` });
    nodes.push({ id: `p${i}`, kind: "planned", x: 300, y: 20 + i * 70, join: "any",
      ticketKey: `NEXT-${i}`, repos: [`repo-${i}`], mode: "quick", dest: "worktree" });
    edges.push({ id: `e${i}`, from: `a${i}`, to: `p${i}`, cond: { kind: "pr-merged" }, action: "launch", mode: "quick" });
    // Alternating, so the panel carries a mix of verdicts rather than ten
    // identical rows — a uniform list could scroll correctly for a wrong reason.
    runs.push(status(`PROJ-${i}`, `repo-${i}`, i % 2 === 0));
  }
  return { flow: { id: "f1", name: "Ship the migration", armed: false, createdAt: 1_000, nodes, edges }, runs };
};

const noop = () => {};

test("the rows scroll and the disclaimer stays put", async ({ mount, page }) => {
  const { flow, runs } = many();
  await mount(<OrchestratorDrawer
    flows={[flow]} openId={{ kind: "flow", id: "f1" }} runs={runs} pendingResume={[]}
    promptModes={[{ id: "quick", label: "Quick pass" }]} commands={[]} branchCi={{}} templates={[]} draftTemplate={null}
    view="canvas" onView={noop} rows={[]} onOpenCard={noop}
    onClose={noop} onCreate={noop} onOpen={noop} onRename={noop} onSave={noop}
    onDelete={noop} onArm={noop} onResumeApprove={noop} onResumeDisarm={noop} onResetEdge={noop}
    onNewTemplate={noop} onCancelTemplate={noop}
  />);

  await page.getByRole("button", { name: /what would fire/i }).click();
  const panel = page.getByTestId("orch-dryrun");
  await expect(panel).toBeVisible();

  const rows = panel.locator(".rows");
  const footer = panel.locator(".ft");

  // Guard the premise the same way the canvas spec guards its origin: if the
  // rows do not actually overflow, everything below passes for free and proves
  // nothing about a footer that could scroll.
  const overflow = await rows.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(overflow).toBeGreaterThan(0);

  // The whole point: readable before you touch anything.
  await expect(footer).toBeVisible();
  await expect(footer).toBeInViewport();
  await expect(footer).toContainText("first spend still asks");

  const before = await footer.boundingBox();
  await rows.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  // Scrolled to the very bottom of the rows — the state that used to hide it.
  expect(await rows.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const after = await footer.boundingBox();

  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  // Unmoved by the scroll, and still on screen.
  expect(after!.y).toBeCloseTo(before!.y, 0);
  await expect(footer).toBeInViewport();

  // And it is genuinely outside the scrolling box, not merely tall enough to
  // survive this one scroll: the footer's top sits at or below the rows' bottom.
  const rowsBox = await rows.boundingBox();
  expect(after!.y).toBeGreaterThanOrEqual(rowsBox!.y + rowsBox!.height - 1);
});
