import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SUGGESTION_SHAPES, suggestionFor } from "../../../../src/engine/orchestrator/suggestions";
import { ACTION_MISMATCH_PREFIX } from "../../../../src/engine/orchestrator/model";
import { COMMAND_TIMEOUT_MS } from "../../../../src/engine/orchestrator/command";

// The same way `test/unit/docs.test.ts` reads source: from the repo root, so a
// reworded engine message fails HERE, loudly, rather than silently leaving the
// drawer with an error the table no longer recognises.
const read = (p: string) => fs.readFileSync(path.join(__dirname, "../../../..", p), "utf8");

/** One realistic error per shape, worded the way the engine words it today. */
const SAMPLE: Record<string, string> = {
  "worktree": "Couldn't create a git worktree in agent-flow — not launching PROJ-12 in your main checkout. The Agent Flow Deck output channel has the reason.",
  "command-killed": '"deploy" exited with code 124 — the code reported for a command killed after 120000 ms without finishing.',
  "command-timeout": "killed by SIGTERM — it did not finish within 120000 ms.",
  "repo-not-checked-out": 'this command runs in "aws-ops", which isn\'t checked out on this machine — not running it somewhere else.',
  "no-upstream-place": 'nothing upstream of n1 is a place, so the command at n2 has no checkout to run in — give the command node a working directory ("cwdRepo" in the flow file).',
  "source-run-off-board": 'the command at n2 runs where PROJ-1 put "aws-ops", and that run is not on the board — give the command node a working directory ("cwdRepo" in the flow file).',
  "seed-run-off-board": 'the run "PROJ-1" is no longer on the board — not seeding aws-ops.',
  "seed-repo-gone": '"aws-ops" is no longer one of PROJ-1\'s repos — not seeding it.',
  "action-mismatch": `${ACTION_MISMATCH_PREFIX}: it was saved as "launch" but where it points now means "seed". Reset the rule to accept that, or point it somewhere else.`,
  "never-auto-run": '"deploy" matches agentFlow.neverAutoRun pattern "deploy*" — never run unattended.',
  "prompt-mode-gone": 'the prompt mode "tdd" is no longer configured — not launching PROJ-12.',
  "wrong-kind-must-point": "a launch rule must point at planned work, and n2 is not.",
  "wrong-kind-points-at": "this rule points at n2, which is not a place, planned work, a notification, or a command.",
  "not-performed": "launch was not performed",
  "subflow-already-started": "n3 already started a subflow (f9); delete or reset that flow to start it again.",
  "subflow-source-not-place": "a subflow starts from a place — n1 is not one, so there is no card to bind it to.",
  "template-off-disk": "the template this subflow starts (tpl-1) is no longer on disk.",
  "subflow-depth": "this workflow is already 3 subflows deep — not nesting another.",
  "template-no-planned": 'template "Ship it" has no planned step: nothing to bind PROJ-12 to',
  "template-self-subflow": 'template "Ship it" starts itself as a subflow — that would never end',
  "template-no-repo": "this card has no repo to launch in, and the template names none",
  "template-no-prompt-mode": "no prompt mode is configured: set agentFlow.promptModes before attaching a workflow",
  "gate-not-wired": "the gate is not wired to a place, so there is no pull request to ask on",
  "gate-run-off-board": "PROJ-1 is not on the board, so its pull request cannot be found",
  "gate-repo-not-checkout": "aws-ops is not a checkout of PROJ-1",
  "gate-no-pr": "aws-ops has no pull request yet to ask on",
  "gate-forge-cannot": "GitLab cannot carry a gate question — ask on the node instead",
};

describe("suggestionFor", () => {
  it("names a next step for every shape the engine produces, and each sample hits its own shape", () => {
    for (const shape of SUGGESTION_SHAPES) {
      const sample = SAMPLE[shape.id];
      expect(sample, `no sample for shape ${shape.id}`).toBeDefined();
      const hit = SUGGESTION_SHAPES.find((s) => s.match(sample));
      expect(hit?.id, `sample for ${shape.id} was claimed by ${hit?.id}`).toBe(shape.id);
      expect(suggestionFor(sample)).toBe(shape.suggest);
    }
  });

  it("has a sample for nothing that is not a shape", () => {
    expect(Object.keys(SAMPLE).sort()).toEqual(SUGGESTION_SHAPES.map((s) => s.id).sort());
  });

  it("answers undefined — never a generic filler — for an unknown error, and for no error", () => {
    expect(suggestionFor(undefined)).toBeUndefined();
    expect(suggestionFor("")).toBeUndefined();
    expect(suggestionFor('"deploy" exited with code 1.')).toBeUndefined();
    expect(suggestionFor("no worktree")).toBeUndefined();
    // A forge's own post failure is whatever the forge said — no shape claims it.
    expect(suggestionFor("gh: HTTP 502")).toBeUndefined();
  });

  it("every shape is a short imperative sentence, distinct in what it matches", () => {
    const ids = SUGGESTION_SHAPES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const shape of SUGGESTION_SHAPES) {
      expect(shape.suggest.length, shape.id).toBeGreaterThan(20);
      expect(shape.suggest.length, shape.id).toBeLessThan(200);
      expect(shape.suggest, shape.id).toMatch(/[.]$/);
    }
    // No two shapes claim the same sample: each literal lands on exactly one row.
    for (const shape of SUGGESTION_SHAPES) {
      const claimers = SUGGESTION_SHAPES.filter((s) => s.match(shape.literal));
      expect(claimers.map((s) => s.id), `literal of ${shape.id}`).toEqual([shape.id]);
    }
  });

  it("every literal is still present, verbatim, in every source file its row names", () => {
    for (const shape of SUGGESTION_SHAPES) {
      expect(shape.sources.length, shape.id).toBeGreaterThan(0);
      for (const src of shape.sources) {
        expect(read(src).includes(shape.literal), `${shape.id}: ${JSON.stringify(shape.literal)} not in ${src}`).toBe(true);
      }
    }
  });

  it("names the command deadline the engine actually enforces", () => {
    const seconds = `${COMMAND_TIMEOUT_MS / 1000} s`;
    expect(suggestionFor(SAMPLE["command-killed"])).toContain(seconds);
    expect(suggestionFor(SAMPLE["command-timeout"])).toContain(seconds);
  });

  it("the action-mismatch row keys off the model's own prefix, so a re-spelt prefix fails here", () => {
    const row = SUGGESTION_SHAPES.find((s) => s.id === "action-mismatch")!;
    expect(row.literal).toBe(ACTION_MISMATCH_PREFIX);
    expect(row.sources).toContain("src/engine/orchestrator/model.ts");
  });
});
