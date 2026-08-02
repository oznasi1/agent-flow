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
  DEFAULT_REVIEW_REQUEST_PROMPT,
  DEFAULT_REVIEW_REQUEST_MODES,
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

  it("keeps an optional detail on a custom mode", () => {
    const custom = [{ id: "debug", label: "Debug", detail: "Reproduce it first", prompt: "reproduce {key}" }];
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

describe("DEFAULT_PROMPT_MODES", () => {
  it("ships six modes in picker order, each with a written detail", () => {
    expect(DEFAULT_PROMPT_MODES.map((m) => m.id)).toEqual([
      "plan",
      "implementation",
      "tdd",
      "investigate",
      "orchestrator",
      "refine",
    ]);
    for (const m of DEFAULT_PROMPT_MODES) {
      expect(m.label.trim().length).toBeGreaterThan(0);
      expect(m.detail?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("gives every mode the full placeholder set, ending in {files}", () => {
    for (const m of DEFAULT_PROMPT_MODES) {
      for (const ph of ["{key}", "{summary}", "{brief}", "{url}"]) {
        expect(m.prompt).toContain(ph);
      }
      expect(m.prompt.endsWith("{files}")).toBe(true);
    }
  });
});

describe("getConfig — telemetryEnabled", () => {
  it("telemetryEnabled defaults to true", () => {
    expect(getConfig().telemetryEnabled).toBe(true);
  });

  it("telemetryEnabled reflects the setting when disabled", () => {
    setConfig({ "telemetry.enabled": false });
    expect(getConfig().telemetryEnabled).toBe(false);
  });
});

describe("getConfig — trackOpenWindows", () => {
  it("defaults trackOpenWindows to true and reads an override", () => {
    expect(getConfig().trackOpenWindows).toBe(true);
    setConfig({ trackOpenWindows: false });
    expect(getConfig().trackOpenWindows).toBe(false);
  });
});

describe("getConfig — batch launch", () => {
  it("defaults batchLaunchConfirmThreshold to 6", () => {
    expect(getConfig().batchLaunchConfirmThreshold).toBe(6);
  });

  it("honors an explicit threshold", () => {
    setConfig({ batchLaunchConfirmThreshold: 3 });
    expect(getConfig().batchLaunchConfirmThreshold).toBe(3);
  });

  it("clamps a below-minimum threshold up to 1", () => {
    setConfig({ batchLaunchConfirmThreshold: 0 });
    expect(getConfig().batchLaunchConfirmThreshold).toBe(1);
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

describe("getConfig — filter visibility", () => {
  it("defaults every filter control to visible when nothing is configured", () => {
    expect(getConfig().filters).toEqual({ size: true, status: true, repo: true, search: true });
  });

  it("honors an explicit false for each control", () => {
    setConfig({ "filters.size": false, "filters.status": false, "filters.repo": false, "filters.search": false });
    expect(getConfig().filters).toEqual({ size: false, status: false, repo: false, search: false });
  });

  it("hides one control independently of the others", () => {
    setConfig({ "filters.search": false });
    expect(getConfig().filters).toEqual({ size: true, status: true, repo: true, search: false });
  });
});

describe("getConfig — remoteControl", () => {
  it("defaults to off", () => {
    expect(getConfig().remoteControl).toBe("off");
  });

  it("honors on and ask", () => {
    setConfig({ remoteControl: "on" });
    expect(getConfig().remoteControl).toBe("on");
    setConfig({ remoteControl: "ask" });
    expect(getConfig().remoteControl).toBe("ask");
  });

  it("falls back to off for a value outside the enum", () => {
    setConfig({ remoteControl: "true" });
    expect(getConfig().remoteControl).toBe("off");
  });

  it("falls back to off for an empty string", () => {
    setConfig({ remoteControl: "" });
    expect(getConfig().remoteControl).toBe("off");
  });
});

describe("PR facts settings", () => {
  it("defaults prFacts on and the TTL to 120 seconds", () => {
    const c = getConfig();
    expect(c.prFacts).toBe(true);
    expect(c.prFactsTtlSeconds).toBe(120);
  });

  it("honours prFacts set to false", () => {
    setConfig({ prFacts: false });
    expect(getConfig().prFacts).toBe(false);
  });

  it("honours a custom TTL", () => {
    setConfig({ prFactsTtlSeconds: 300 });
    expect(getConfig().prFactsTtlSeconds).toBe(300);
  });

  it("floors an absurdly small TTL at 30s so a typo cannot hammer the GitHub API", () => {
    setConfig({ prFactsTtlSeconds: 1 });
    expect(getConfig().prFactsTtlSeconds).toBe(30);
  });
});

describe("review-request settings", () => {
  it("defaults to the strip on, a 5-minute TTL, and writes off", () => {
    const c = getConfig();
    expect(c.reviewRequests).toBe(true);
    expect(c.reviewRequestsTtlSeconds).toBe(300);
    expect(c.reviewWrites).toBe(false);
    // Both safety properties of the default prompt, not just a loose substring:
    // where findings go, and that nothing gets posted to GitHub automatically.
    expect(c.reviewRequestPrompt).toContain(".pick-task/REVIEW-{number}.md");
    expect(c.reviewRequestPrompt).toMatch(/do not post/i);
    expect(c.reviewRequestPrompt).toBe(DEFAULT_REVIEW_REQUEST_PROMPT);
  });

  it("honors reviewRequests set to false", () => {
    setConfig({ reviewRequests: false });
    expect(getConfig().reviewRequests).toBe(false);
  });

  it("honors an explicit reviewWrites override", () => {
    setConfig({ reviewWrites: true });
    expect(getConfig().reviewWrites).toBe(true);
  });

  it("floors the TTL at 60 seconds", () => {
    setConfig({ reviewRequestsTtlSeconds: 5 });
    expect(getConfig().reviewRequestsTtlSeconds).toBe(60);
  });

  it("honours an explicit TTL above the floor", () => {
    setConfig({ reviewRequestsTtlSeconds: 900 });
    expect(getConfig().reviewRequestsTtlSeconds).toBe(900);
  });

  it("honours an explicit prompt override", () => {
    setConfig({ reviewRequestPrompt: "just look at it" });
    expect(getConfig().reviewRequestPrompt).toBe("just look at it");
  });

  it("falls back to the default prompt for an empty override", () => {
    setConfig({ reviewRequestPrompt: "" });
    expect(getConfig().reviewRequestPrompt).toContain("REVIEW-{number}.md");
  });

  it("defaults to the single stock review mode, asked for each time", () => {
    const c = getConfig();
    expect(c.reviewRequestModes).toEqual(DEFAULT_REVIEW_REQUEST_MODES);
    // The one-mode default is load-bearing: it is what keeps a fresh install's
    // Review-with-agent a single click instead of a click plus a picker.
    expect(c.reviewRequestModes).toHaveLength(1);
    expect(c.reviewRequestModes[0].prompt).toBe(DEFAULT_REVIEW_REQUEST_PROMPT);
    expect(c.reviewRequestMode).toBe("ask");
  });

  it("migrates a customized legacy reviewRequestPrompt into the stock mode", () => {
    setConfig({ reviewRequestPrompt: "just look at it" });
    const modes = getConfig().reviewRequestModes;
    expect(modes).toHaveLength(1);
    expect(modes[0].prompt).toBe("just look at it");
    // Only the prompt is replaced. The mode keeps its identity so that a
    // reviewRequestMode: "full" pin still resolves after the migration.
    expect(modes[0].id).toBe("full");
    expect(modes[0].label).toBe(DEFAULT_REVIEW_REQUEST_MODES[0].label);
  });

  it("lets an explicit modes list beat the deprecated prompt", () => {
    setConfig({
      reviewRequestPrompt: "legacy",
      reviewRequestModes: [{ id: "backend", label: "Backend", prompt: "BE {number}" }],
    });
    expect(getConfig().reviewRequestModes).toEqual([{ id: "backend", label: "Backend", prompt: "BE {number}" }]);
  });

  it("falls back to the stock list for an empty modes array", () => {
    setConfig({ reviewRequestModes: [] });
    expect(getConfig().reviewRequestModes).toEqual(DEFAULT_REVIEW_REQUEST_MODES);
  });

  it("falls back to the stock list when every entry is missing a required field", () => {
    // A mode without `prompt` would seed an empty session — worse than ignoring
    // the setting entirely, so an all-invalid list is treated as no list.
    setConfig({ reviewRequestModes: [{ id: "x", label: "X" }, { label: "No id", prompt: "P" }] });
    expect(getConfig().reviewRequestModes).toEqual(DEFAULT_REVIEW_REQUEST_MODES);
  });

  it("drops only the invalid entries from a mixed modes array", () => {
    setConfig({ reviewRequestModes: [{ id: "ok", label: "OK", prompt: "P" }, { id: "bad", label: "Bad" }] });
    expect(getConfig().reviewRequestModes).toEqual([{ id: "ok", label: "OK", prompt: "P" }]);
  });

  it("honours an explicit reviewRequestMode pin", () => {
    setConfig({ reviewRequestMode: "backend" });
    expect(getConfig().reviewRequestMode).toBe("backend");
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

  it("keeps the promptModes schema default byte-identical to DEFAULT_PROMPT_MODES", () => {
    // This is the one users actually get: an untouched setting resolves to the
    // manifest default, so the code constant alone being right reaches nobody.
    expect(props["agentFlow.promptModes"].default).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("leaves detail out of the promptModes required fields", () => {
    const p = props["agentFlow.promptModes"] as { items?: { required?: string[]; properties?: Record<string, unknown> } };
    expect(p.items?.required).toEqual(["id", "label", "prompt"]);
    expect(Object.keys(p.items?.properties ?? {})).toContain("detail");
  });

  it("keeps the deprecated explorePrompt default equal to the knowledge default (migration target)", () => {
    expect(props["agentFlow.explorePrompt"].default).toBe(DEFAULT_EXPLORE_PROMPT);
  });

  it("declares the filter-visibility settings with a default of true", () => {
    expect(props["agentFlow.filters.size"].default).toBe(true);
    expect(props["agentFlow.filters.status"].default).toBe(true);
    expect(props["agentFlow.filters.repo"].default).toBe(true);
    expect(props["agentFlow.filters.search"].default).toBe(true);
  });

  it("declares batchLaunchConfirmThreshold with a default of 6", () => {
    expect(props["agentFlow.batchLaunchConfirmThreshold"].default).toBe(6);
  });

  it("declares remoteControl with a default of off and the three-value enum", () => {
    const p = props["agentFlow.remoteControl"] as { default?: unknown; enum?: unknown };
    expect(p.default).toBe("off");
    expect(p.enum).toEqual(["off", "on", "ask"]);
  });

  it("declares prFacts defaulting to true and prFactsTtlSeconds to 120 with a floor of 30", () => {
    expect(props["agentFlow.prFacts"].default).toBe(true);
    const ttl = props["agentFlow.prFactsTtlSeconds"] as { default?: unknown; minimum?: unknown };
    expect(ttl.default).toBe(120);
    expect(ttl.minimum).toBe(30);
  });

  // getConfig()'s own `?? false` / `?? true` fallbacks only exercise the vscode
  // mock's "unset key" behavior (undefined), never the manifest default a real
  // VS Code install actually serves an untouched setting from. Without this, a
  // "default": true typo on agentFlow.reviewWrites in package.json — shipping
  // the one GitHub write path in this extension on by default — would leave
  // every one of getConfig()'s own tests green.
  it("declares reviewWrites defaulting to false — the only setting that writes to GitHub", () => {
    expect(props["agentFlow.reviewWrites"].default).toBe(false);
  });

  it("declares reviewRequests defaulting to true — the review strip is on unless turned off", () => {
    expect(props["agentFlow.reviewRequests"].default).toBe(true);
  });

  it("declares reviewRequestsTtlSeconds defaulting to 300 with a floor of 60", () => {
    const ttl = props["agentFlow.reviewRequestsTtlSeconds"] as { default?: unknown; minimum?: unknown };
    expect(ttl.default).toBe(300);
    expect(ttl.minimum).toBe(60);
  });

  it("keeps the prReviewPrompt schema default byte-identical to DEFAULT_PR_REVIEW_PROMPT", () => {
    // Same rationale as the promptModes check above: an untouched setting resolves
    // to the manifest default, so telemetry's pr_review_prompt_customized comparison
    // (settingsSnapshot.ts) is only correct if the two stay in step.
    expect(props["agentFlow.prReviewPrompt"].default).toBe(DEFAULT_PR_REVIEW_PROMPT);
  });

  it("keeps the reviewRequestModes schema default byte-identical to DEFAULT_REVIEW_REQUEST_MODES", () => {
    // Same reasoning as the promptModes parity test above: an untouched setting
    // resolves to the manifest default, so a correct code constant alone reaches nobody.
    expect(props["agentFlow.reviewRequestModes"].default).toEqual(DEFAULT_REVIEW_REQUEST_MODES);
  });

  it("marks the legacy reviewRequestPrompt deprecated and points at its replacement", () => {
    const p = props["agentFlow.reviewRequestPrompt"] as { markdownDeprecationMessage?: string };
    expect(p.markdownDeprecationMessage).toMatch(/reviewRequestModes/);
  });
});
