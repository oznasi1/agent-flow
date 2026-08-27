import { describe, it, expect } from "vitest";
import { renderPrompt, injectSlackDm, insertBeforeFiles, SLACK_DM_SENTENCE, applyExploreVars, prReviewTemplate, PR_REVIEW_AUTOFIX_CLAUSE, composeAgentPrompt, prWorkClause, prWorkLabel, type PromptVars } from "../../../src/engine/prompt";

const V: PromptVars = {
  key: "PROJ-5412",
  summary: "Wizer export",
  url: "https://x/PROJ-5412",
  brief: ".pick-task/TASK.md",
};

describe("renderPrompt", () => {
  it("substitutes all placeholders", () => {
    expect(renderPrompt("{key}: {summary} @ {brief} — {url}", V, [])).toBe(
      "PROJ-5412: Wizer export @ .pick-task/TASK.md — https://x/PROJ-5412",
    );
  });

  it("expands {files} into a relevant-files block when mentions exist", () => {
    expect(renderPrompt("do it{files}", V, ["@webapp/a.ts", "@webapp/b.ts"])).toBe(
      "do it\n\nRelevant files: @webapp/a.ts @webapp/b.ts",
    );
  });

  it("expands {files} to nothing when there are no mentions", () => {
    expect(renderPrompt("do it{files}", V, [])).toBe("do it");
  });

  it("replaces every occurrence of a repeated placeholder", () => {
    expect(renderPrompt("{key} {key} — {key}", V, [])).toBe("PROJ-5412 PROJ-5412 — PROJ-5412");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderPrompt("{key} {nope}", V, [])).toBe("PROJ-5412 {nope}");
  });

  it("renders a custom (debug-style) template", () => {
    expect(renderPrompt("Debug {key}: reproduce then fix. {url}", V, [])).toBe(
      "Debug PROJ-5412: reproduce then fix. https://x/PROJ-5412",
    );
  });

  it("returns a template with no placeholders verbatim", () => {
    expect(renderPrompt("just start", V, ["@a"])).toBe("just start");
  });
});

describe("insertBeforeFiles", () => {
  it("inserts the sentence just before a trailing {files}", () => {
    expect(insertBeforeFiles("do it{files}", " NOW")).toBe("do it NOW{files}");
  });

  it("appends the sentence when there is no {files} placeholder", () => {
    expect(insertBeforeFiles("do it", " NOW")).toBe("do it NOW");
  });

  it("inserts before the first {files} only", () => {
    expect(insertBeforeFiles("a{files}b{files}", " NOW")).toBe("a NOW{files}b{files}");
  });

  it("does not interpret $ patterns in the inserted sentence", () => {
    expect(insertBeforeFiles("x{files}", " $& $1 done")).toBe("x $& $1 done{files}");
  });
});

describe("injectSlackDm", () => {
  it("returns the template unchanged when disabled", () => {
    expect(injectSlackDm("do it{files}", false)).toBe("do it{files}");
  });

  it("inserts the Slack sentence just before a trailing {files}", () => {
    expect(injectSlackDm("do it{files}", true)).toBe(`do it ${SLACK_DM_SENTENCE}{files}`);
  });

  it("appends the Slack sentence when there is no {files} placeholder", () => {
    expect(injectSlackDm("do it", true)).toBe(`do it ${SLACK_DM_SENTENCE}`);
  });

  it("inserts before the first {files} only", () => {
    expect(injectSlackDm("a{files}b{files}", true)).toBe(`a ${SLACK_DM_SENTENCE}{files}b{files}`);
  });
});

describe("applyExploreVars", () => {
  it("fills {env} and {services}", () => {
    expect(applyExploreVars("check {services} on {env}", { env: "staging", services: "api, worker" })).toBe(
      "check api, worker on staging",
    );
  });

  it("replaces every occurrence of each placeholder", () => {
    expect(applyExploreVars("{env}/{services}/{env}", { env: "dev", services: "api" })).toBe("dev/api/dev");
  });

  it("leaves {env} untouched when no environment was collected", () => {
    expect(applyExploreVars("look at {services} on {env}", { services: "api" })).toBe("look at api on {env}");
  });

  it("does not interpret $ patterns in a substituted value", () => {
    expect(applyExploreVars("{env} {services}", { env: "$&", services: "$1" })).toBe("$& $1");
  });

  it("leaves the placeholders renderPrompt owns alone", () => {
    expect(applyExploreVars("{summary} {brief} {env}{files}", { env: "prod", services: "api" })).toBe(
      "{summary} {brief} prod{files}",
    );
  });

  it("returns a template with no explore placeholders verbatim", () => {
    expect(applyExploreVars("just start{files}", { env: "prod", services: "api" })).toBe("just start{files}");
  });
});

describe("prReviewTemplate", () => {
  it("inserts the auto-fix clause just before {files} when autoFix is on", () => {
    const t = prReviewTemplate("Assess the PR for {key}.{files}", true);
    expect(t).toContain(PR_REVIEW_AUTOFIX_CLAUSE);
    expect(t.indexOf(PR_REVIEW_AUTOFIX_CLAUSE)).toBeLessThan(t.indexOf("{files}"));
  });

  it("appends the clause at the end when the prompt has no {files}", () => {
    expect(prReviewTemplate("Assess the PR for {key}.", true)).toBe(
      `Assess the PR for {key}. ${PR_REVIEW_AUTOFIX_CLAUSE}`,
    );
  });

  it("returns the prompt untouched when autoFix is off", () => {
    expect(prReviewTemplate("Assess the PR for {key}.{files}", false)).toBe(
      "Assess the PR for {key}.{files}",
    );
  });
});

describe("composeAgentPrompt", () => {
  it("returns the template untouched when there is no note", () => {
    expect(composeAgentPrompt("do {key}")).toBe("do {key}");
    expect(composeAgentPrompt("do {key}", undefined)).toBe("do {key}");
  });

  it("returns the template untouched for an empty or whitespace-only note", () => {
    // A user who focused the field and typed nothing must not change the prompt.
    expect(composeAgentPrompt("do {key}", "")).toBe("do {key}");
    expect(composeAgentPrompt("do {key}", "   \n ")).toBe("do {key}");
  });

  it("substitutes at {note} when the template has one", () => {
    expect(composeAgentPrompt("a {note} b", "on staging")).toBe("a on staging b");
  });

  it("keeps the relevant-files block last when it appends", () => {
    // The template author put {files} at the end on purpose.
    const out = composeAgentPrompt("work on {key}\n\n{files}", "on staging");
    expect(out.indexOf("on staging")).toBeLessThan(out.indexOf("{files}"));
  });

  it("appends when the template has neither {note} nor {files}", () => {
    const out = composeAgentPrompt("work on {key}", "on staging");
    expect(out).toContain("work on {key}");
    expect(out).toContain("on staging");
  });

  it("does not interpret a dollar sequence in the note", () => {
    // String.replace would turn `$&` into the matched text. The note is user
    // free text, so this is reachable, and silent corruption is the worst case.
    expect(composeAgentPrompt("a {note} b", "cost $& total")).toContain("cost $& total");
    expect(composeAgentPrompt("a {note} b", "use $1 here")).toContain("use $1 here");
    expect(composeAgentPrompt("plain", "cost $& total")).toContain("cost $& total");
  });

  it("leaves brace placeholders inside a note uninterpolated", () => {
    // The composed result never goes back through renderPrompt.
    expect(composeAgentPrompt("a {note} b", "mention {brief} literally"))
      .toContain("mention {brief} literally");
  });

  it("does not leave a {note} placeholder behind when there is no note", () => {
    // A mode author who added {note} must not ship the literal token to an agent.
    expect(composeAgentPrompt("a {note} b")).not.toContain("{note}");
  });
});

describe("prWorkClause", () => {
  it("names the failing checks for a ci reason", () => {
    const c = prWorkClause("ci", "integration, lint");
    expect(c).toContain("integration, lint");
    expect(c.toLowerCase()).toContain("failing");
  });

  it("still says something useful for ci with no detail", () => {
    expect(prWorkClause("ci").toLowerCase()).toContain("failing");
  });

  it("tells the agent to rebase for a conflict reason", () => {
    expect(prWorkClause("conflict").toLowerCase()).toContain("rebase");
  });

  // The review path must stay byte-identical to what Address PR sent before, so
  // an existing user's configured prReviewPrompt reaches the agent unchanged.
  it("adds nothing for a review reason", () => {
    expect(prWorkClause("review")).toBe("");
  });

  it("never interpolates a detail into a regex replacement position", () => {
    // Detail is derived from check names, which are user-controlled on GitHub.
    expect(prWorkClause("ci", "$& $1 $'")).toContain("$& $1 $'");
  });
});

describe("prWorkLabel", () => {
  // The card's own buttons, and the words the destination picker's title repeats.
  // Asserted against the literals the webview rendered before this was extracted, so
  // moving the wording here cannot quietly rename a button.
  it("names each reason with the verb its button already used", () => {
    expect(prWorkLabel("ci")).toBe("Fix CI");
    expect(prWorkLabel("conflict")).toBe("Resolve conflict");
    expect(prWorkLabel("review")).toBe("Address review");
  });
});
