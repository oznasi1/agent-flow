import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import {
  expandHome,
  getConfig,
  DEFAULT_PROMPT_MODES,
  DEFAULT_EXPLORE_PROMPT,
  DEFAULT_EXPLORE_JIRA_TICKET_PROMPT,
  DEFAULT_EXPLORE_DEBUG_PROMPT,
  DEFAULT_EXPLORE_GENERAL_PROMPT,
  DEFAULT_PR_REVIEW_PROMPT,
} from "../../src/config";
import { setConfig } from "../_mocks/vscode";
import pkg from "../../package.json";

describe("expandHome", () => {
  it("expands a bare ~ to the home directory", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });

  it("expands a leading ~/ prefix", () => {
    expect(expandHome("~/projects")).toBe(path.join(os.homedir(), "projects"));
  });

  it("leaves an absolute path untouched", () => {
    expect(expandHome("/opt/repos")).toBe("/opt/repos");
  });

  it("leaves a relative path (no ~) untouched", () => {
    expect(expandHome("repos/here")).toBe("repos/here");
  });

  it("does not expand a ~ that is not at the start", () => {
    expect(expandHome("/a/~/b")).toBe("/a/~/b");
  });
});

describe("getConfig — defaults", () => {
  it("applies the documented defaults when nothing is configured", () => {
    const c = getConfig();
    expect(c).toMatchObject({
      baseUrl: "",
      project: "",
      reposRoot: expandHome("~/projects"),
      workspaceDir: expandHome("~/projects"),
      githubOrg: "",
      repoBlocklist: [],
      defaultFilter: "mysprint",
      seedAgent: true,
      workspaceMode: "auto",
      taskMode: "ask",
      worktree: "ask",
      stampLabelOnWrite: true,
      provenanceLabel: "claude-code",
    });
    expect(c.promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });
});

describe("getConfig — normalization", () => {
  it("trims trailing slashes off the base URL", () => {
    setConfig({ "jira.baseUrl": "https://example.atlassian.net///" });
    expect(getConfig().baseUrl).toBe("https://example.atlassian.net");
  });

  it("expands ~ in path settings", () => {
    setConfig({ reposRoot: "~/repos", workspaceDir: "~/ws" });
    const c = getConfig();
    expect(c.reposRoot).toBe(path.join(os.homedir(), "repos"));
    expect(c.workspaceDir).toBe(path.join(os.homedir(), "ws"));
  });

  it("honors explicit boolean settings", () => {
    setConfig({ seedAgent: false, stampLabelOnWrite: false });
    const c = getConfig();
    expect(c.seedAgent).toBe(false);
    expect(c.stampLabelOnWrite).toBe(false);
  });

  it("passes through project and filter values", () => {
    setConfig({ "jira.project": "XYZ", defaultFilter: "mine" });
    const c = getConfig();
    expect(c.project).toBe("XYZ");
    expect(c.defaultFilter).toBe("mine");
  });

  it("keeps a valid repoBlocklist and drops empty/non-string entries", () => {
    setConfig({ repoBlocklist: ["infra", "", "tooling", 42, null] });
    expect(getConfig().repoBlocklist).toEqual(["infra", "tooling"]);
  });

  it("falls back to an empty repoBlocklist for a non-array value", () => {
    setConfig({ repoBlocklist: "nonsense" });
    expect(getConfig().repoBlocklist).toEqual([]);
  });

  it("honors a custom provenanceLabel", () => {
    setConfig({ provenanceLabel: "automated" });
    expect(getConfig().provenanceLabel).toBe("automated");
  });

  it("passes through openIn: pick-existing", () => {
    setConfig({ openIn: "pick-existing" });
    expect(getConfig().openIn).toBe("pick-existing");
  });
});

describe("getConfig — PR review", () => {
  it("applies the PR-review defaults when nothing is configured", () => {
    const c = getConfig();
    expect(c.prReviewStatus).toBe("PR initiated");
    expect(c.prReviewAutoFix).toBe(true);
    expect(c.prReviewPrompt).toBe(DEFAULT_PR_REVIEW_PROMPT);
  });

  it("honors a custom prReviewStatus", () => {
    setConfig({ prReviewStatus: "PR approved" });
    expect(getConfig().prReviewStatus).toBe("PR approved");
  });

  it("honors prReviewAutoFix = false", () => {
    setConfig({ prReviewAutoFix: false });
    expect(getConfig().prReviewAutoFix).toBe(false);
  });

  it("honors a custom prReviewPrompt", () => {
    setConfig({ prReviewPrompt: "Look at the PR for {key}{files}" });
    expect(getConfig().prReviewPrompt).toBe("Look at the PR for {key}{files}");
  });

  it("falls back to the default status for an empty string", () => {
    setConfig({ prReviewStatus: "" });
    expect(getConfig().prReviewStatus).toBe("PR initiated");
  });
});

describe("getConfig — promptModes validation", () => {
  it("keeps a valid custom array", () => {
    const custom = [{ id: "debug", label: "Debug", prompt: "reproduce {key}" }];
    setConfig({ promptModes: custom });
    expect(getConfig().promptModes).toEqual(custom);
  });

  it("filters out entries missing id/label/prompt", () => {
    setConfig({
      promptModes: [
        { id: "ok", label: "OK", prompt: "go" },
        { id: "bad", label: "missing prompt" },
        { label: "no id", prompt: "x" },
      ],
    });
    expect(getConfig().promptModes).toEqual([{ id: "ok", label: "OK", prompt: "go" }]);
  });

  it("falls back to defaults for an empty array", () => {
    setConfig({ promptModes: [] });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("falls back to defaults for a non-array value", () => {
    setConfig({ promptModes: "nonsense" });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });
});

describe("getConfig — trackOpenWindows", () => {
  it("defaults trackOpenWindows to true and reads an override", () => {
    expect(getConfig().trackOpenWindows).toBe(true);
    setConfig({ trackOpenWindows: false });
    expect(getConfig().trackOpenWindows).toBe(false);
  });
});

describe("getConfig — explore actions", () => {
  it("defaults to four actions with built-in labels and default prompts, all Slack-off", () => {
    expect(getConfig().exploreActions).toEqual([
      { id: "jiraTicket", label: "Open a Jira ticket", prompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT, slackDm: false },
      { id: "knowledge", label: "Enhance knowledge / flow", prompt: DEFAULT_EXPLORE_PROMPT, slackDm: false },
      { id: "debug", label: "Debug", prompt: DEFAULT_EXPLORE_DEBUG_PROMPT, slackDm: false },
      { id: "general", label: "General", prompt: DEFAULT_EXPLORE_GENERAL_PROMPT, slackDm: false },
    ]);
  });

  it("defaults exploreMode to 'ask' and honors a configured value", () => {
    expect(getConfig().exploreMode).toBe("ask");
    setConfig({ exploreMode: "debug" });
    expect(getConfig().exploreMode).toBe("debug");
  });

  it("uses a per-action prompt override from settings", () => {
    setConfig({ "explorePrompts.debug": "repro {summary}{files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "debug")?.prompt).toBe("repro {summary}{files}");
  });

  it("flips slackDm per action id and ignores non-boolean values", () => {
    setConfig({ exploreSlackDm: { jiraTicket: true, knowledge: "yes", debug: 1 } });
    const byId = Object.fromEntries(getConfig().exploreActions.map((x) => [x.id, x.slackDm]));
    expect(byId).toEqual({ jiraTicket: true, knowledge: false, debug: false, general: false });
  });

  it("migrates a customized legacy explorePrompt into the knowledge action", () => {
    setConfig({ explorePrompt: "legacy explore {summary}{files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "knowledge")?.prompt).toBe("legacy explore {summary}{files}");
  });

  it("prefers an explicit explorePrompts.knowledge over the legacy explorePrompt", () => {
    setConfig({ explorePrompt: "legacy {files}", "explorePrompts.knowledge": "new {files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "knowledge")?.prompt).toBe("new {files}");
  });
});

describe("package.json ⇄ config constants", () => {
  const props = (pkg.contributes.configuration.properties as Record<string, { default?: unknown }>);

  it("keeps each explore prompt schema default byte-identical to its config constant", () => {
    expect(props["agentFlow.explorePrompts.jiraTicket"].default).toBe(DEFAULT_EXPLORE_JIRA_TICKET_PROMPT);
    expect(props["agentFlow.explorePrompts.knowledge"].default).toBe(DEFAULT_EXPLORE_PROMPT);
    expect(props["agentFlow.explorePrompts.debug"].default).toBe(DEFAULT_EXPLORE_DEBUG_PROMPT);
    expect(props["agentFlow.explorePrompts.general"].default).toBe(DEFAULT_EXPLORE_GENERAL_PROMPT);
  });

  it("keeps the deprecated explorePrompt default equal to the knowledge default (migration target)", () => {
    expect(props["agentFlow.explorePrompt"].default).toBe(DEFAULT_EXPLORE_PROMPT);
  });
});
