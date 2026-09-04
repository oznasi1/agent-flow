import { describe, it, expect, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import {
  expandHome,
  getConfig,
  hostProviders,
  isCursorHost,
  providerLabel,
  resolvedProvider,
  DEFAULT_PROMPT_MODES,
  DEFAULT_EXPLORE_PROMPT,
  DEFAULT_EXPLORE_JIRA_TICKET_PROMPT,
  DEFAULT_EXPLORE_DEBUG_PROMPT,
  DEFAULT_EXPLORE_GENERAL_PROMPT,
  DEFAULT_EXPLORE_SUPERVISE_PROMPT,
  DEFAULT_EXPLORE_VERIFY_PROMPT,
  DEFAULT_PR_REVIEW_PROMPT,
  GITLAB_PR_REVIEW_PROMPT,
  BITBUCKET_PR_REVIEW_PROMPT,
  DEFAULT_REVIEW_REQUEST_PROMPT,
  GITLAB_REVIEW_REQUEST_PROMPT,
  BITBUCKET_REVIEW_REQUEST_PROMPT,
  DEFAULT_REVIEW_REQUEST_MODES,
  DEFAULT_ENVIRONMENTS,
  DEFAULT_COMMANDS,
  shippedPrReviewPrompt,
  shippedReviewRequestModes,
} from "../../src/config";
import { env, setConfig, setDefaultConfig } from "../_mocks/vscode";
import { manifestSettings } from "../_helpers/manifest";
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

  // Review with agent has always opened a new window on the review worktree. The
  // destination question ships inert so nobody's one-click launch grows a picker on
  // upgrade — and it is its own setting, because a review is a five-minute errand and a
  // take is a day's work.
  it("defaults reviewOpenIn to new-window rather than following openIn", () => {
    setConfig({ openIn: "ask" });
    expect(getConfig().reviewOpenIn).toBe("new-window");
  });

  it("passes through reviewOpenIn: ask", () => {
    setConfig({ reviewOpenIn: "ask" });
    expect(getConfig().reviewOpenIn).toBe("ask");
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

describe("getConfig — promptModes layering", () => {
  const stockIds = DEFAULT_PROMPT_MODES.map((m) => m.id);

  it("appends built-ins the user never listed, keeping the user's entries first", () => {
    setConfig({
      promptModes: [
        { id: "plan", label: "Plan first", prompt: "my plan {key}" },
        { id: "implementation", label: "Implementation", prompt: "my impl {key}" },
      ],
    });
    const modes = getConfig().promptModes;
    expect(modes.map((m) => m.id)).toEqual(stockIds);
    expect(modes[0].prompt).toBe("my plan {key}");
    expect(modes[1].prompt).toBe("my impl {key}");
    // The regression this exists to prevent: modes added after the user
    // customized the setting must still reach them.
    expect(modes.map((m) => m.id)).toContain("orchestrator");
  });

  it("fills a field the override omits from the built-in it overrides", () => {
    setConfig({ promptModes: [{ id: "plan", prompt: "mine {key}" }] });
    const plan = getConfig().promptModes[0];
    expect(plan).toEqual({
      id: "plan",
      label: DEFAULT_PROMPT_MODES[0].label,
      detail: DEFAULT_PROMPT_MODES[0].detail,
      prompt: "mine {key}",
    });
  });

  it("keeps a user's reordering of the built-ins", () => {
    setConfig({ promptModes: [{ id: "tdd" }, { id: "plan" }] });
    const ids = getConfig().promptModes.map((m) => m.id);
    expect(ids.slice(0, 2)).toEqual(["tdd", "plan"]);
    expect(new Set(ids)).toEqual(new Set(stockIds));
  });

  it("appends a mode of the user's own after the built-ins", () => {
    const spike = { id: "spike", label: "Spike", detail: "Timebox it", prompt: "spike {key}" };
    setConfig({ promptModes: [spike] });
    const modes = getConfig().promptModes;
    expect(modes).toHaveLength(stockIds.length + 1);
    expect(modes[0]).toEqual(spike);
    expect(modes.slice(1)).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("drops a built-in marked hidden", () => {
    setConfig({ promptModes: [{ id: "tdd", hidden: true }] });
    const ids = getConfig().promptModes.map((m) => m.id);
    expect(ids).not.toContain("tdd");
    expect(ids).toEqual(stockIds.filter((id) => id !== "tdd"));
  });

  it("lets hidden win over a competing override of the same id", () => {
    setConfig({
      promptModes: [
        { id: "tdd", label: "Test-driven", prompt: "mine {key}" },
        { id: "tdd", hidden: true },
      ],
    });
    expect(getConfig().promptModes.map((m) => m.id)).not.toContain("tdd");
  });

  it("lets hidden win over a competing override of the same id, hidden entry first", () => {
    // The mirror of the case above: the resolver's `hidden` filter runs after
    // the merge, so which of the two entries comes first must not matter.
    setConfig({
      promptModes: [
        { id: "tdd", hidden: true },
        { id: "tdd", label: "Test-driven", prompt: "mine {key}" },
      ],
    });
    expect(getConfig().promptModes.map((m) => m.id)).not.toContain("tdd");
  });

  it("drops a custom mode marked hidden", () => {
    setConfig({
      promptModes: [
        { id: "spike", label: "Spike", prompt: "spike {key}" },
        { id: "spike", hidden: true },
      ],
    });
    expect(getConfig().promptModes.map((m) => m.id)).toEqual(stockIds);
  });

  it("ignores an unknown id that carries no label or no prompt", () => {
    setConfig({
      promptModes: [
        { id: "no-prompt", label: "No prompt" },
        { id: "no-label", prompt: "x {key}" },
        { id: "usable", label: "Usable", prompt: "y {key}" },
      ],
    });
    const modes = getConfig().promptModes;
    expect(modes.map((m) => m.id)).toEqual(["usable", ...stockIds]);
  });

  it("ignores entries that are not objects or have no usable id", () => {
    setConfig({ promptModes: [null, 42, "nope", {}, { id: "   " }, { id: 7 }] });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("trims a padded id so it still matches its built-in", () => {
    setConfig({ promptModes: [{ id: "  plan  ", prompt: "mine {key}" }] });
    const modes = getConfig().promptModes;
    expect(modes.map((m) => m.id)).toEqual(stockIds);
    expect(modes[0].prompt).toBe("mine {key}");
  });

  it("trims a padded label but leaves an inherited prompt untouched", () => {
    setConfig({ promptModes: [{ id: " plan ", label: "  My Plan  " }] });
    const plan = getConfig().promptModes[0];
    expect(plan.id).toBe("plan");
    expect(plan.label).toBe("My Plan");
    expect(plan.prompt).toBe(DEFAULT_PROMPT_MODES[0].prompt);
  });

  it("keeps the first of two overrides of the same id", () => {
    setConfig({
      promptModes: [
        { id: "plan", prompt: "first {key}" },
        { id: "plan", prompt: "second {key}" },
      ],
    });
    const modes = getConfig().promptModes;
    expect(modes.filter((m) => m.id === "plan")).toHaveLength(1);
    expect(modes[0].prompt).toBe("first {key}");
  });

  it("drops a blank label or prompt on an override rather than blanking the built-in", () => {
    setConfig({ promptModes: [{ id: "plan", label: "   ", prompt: "" }] });
    expect(getConfig().promptModes[0]).toEqual(DEFAULT_PROMPT_MODES[0]);
  });

  it("falls back to the built-ins when every one of them is hidden", () => {
    setConfig({ promptModes: DEFAULT_PROMPT_MODES.map((m) => ({ id: m.id, hidden: true })) });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("falls back to defaults for an empty array", () => {
    setConfig({ promptModes: [] });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("falls back to defaults for a non-array value", () => {
    setConfig({ promptModes: "nonsense" });
    expect(getConfig().promptModes).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("returns the built-ins untouched when the value only comes from the manifest default", () => {
    // `get` serves the manifest default; `inspect` reports nothing set. Layering
    // that default over itself would leave `hidden` nothing to hide.
    setDefaultConfig({ promptModes: DEFAULT_PROMPT_MODES });
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
  it("defaults to six actions with built-in labels and default prompts, all Slack-off", () => {
    expect(getConfig().exploreActions).toEqual([
      { id: "jiraTicket", label: "Open a Jira ticket", prompt: DEFAULT_EXPLORE_JIRA_TICKET_PROMPT, slackDm: false, needsEnv: false },
      { id: "knowledge", label: "Enhance knowledge / flow", prompt: DEFAULT_EXPLORE_PROMPT, slackDm: false, needsEnv: false },
      { id: "debug", label: "Debug", prompt: DEFAULT_EXPLORE_DEBUG_PROMPT, slackDm: false, needsEnv: false },
      { id: "general", label: "General", prompt: DEFAULT_EXPLORE_GENERAL_PROMPT, slackDm: false, needsEnv: false },
      { id: "supervise", label: "Supervise running tasks", prompt: DEFAULT_EXPLORE_SUPERVISE_PROMPT, slackDm: false, needsEnv: false },
      { id: "verify", label: "Verify on an environment", prompt: DEFAULT_EXPLORE_VERIFY_PROMPT, slackDm: false, needsEnv: true },
    ]);
  });

  it("marks only the verify action as needing an environment", () => {
    const needsEnv = getConfig().exploreActions.filter((a) => a.needsEnv).map((a) => a.id);
    expect(needsEnv).toEqual(["verify"]);
  });

  it("uses a verify prompt override from settings", () => {
    setConfig({ "explorePrompts.verify": "check {summary} on {env}{files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "verify")?.prompt).toBe("check {summary} on {env}{files}");
  });

  it("uses a supervise prompt override from settings", () => {
    setConfig({ "explorePrompts.supervise": "watch {summary}{files}" });
    expect(getConfig().exploreActions.find((x) => x.id === "supervise")?.prompt).toBe("watch {summary}{files}");
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
    expect(byId).toEqual({ jiraTicket: true, knowledge: false, debug: false, general: false, supervise: false, verify: false });
  });

  it("flips slackDm for the verify action too", () => {
    setConfig({ exploreSlackDm: { verify: true } });
    expect(getConfig().exploreActions.find((a) => a.id === "verify")?.slackDm).toBe(true);
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

describe("getConfig — environments", () => {
  it("defaults to the shipped environment list", () => {
    expect(getConfig().environments).toEqual(["dev", "staging", "production"]);
  });

  it("trims, drops blanks and non-strings, and de-duplicates preserving order", () => {
    setConfig({ environments: ["  prod ", "dev", "", "prod", 7, null, "dev"] });
    expect(getConfig().environments).toEqual(["prod", "dev"]);
  });

  it("falls back to the defaults when the list holds nothing usable", () => {
    setConfig({ environments: ["", "   "] });
    expect(getConfig().environments).toEqual(DEFAULT_ENVIRONMENTS);
  });

  it("falls back to the defaults when the setting is not an array", () => {
    setConfig({ environments: "staging" });
    expect(getConfig().environments).toEqual(DEFAULT_ENVIRONMENTS);
  });

  it("hands back a copy, so a caller cannot mutate the shipped defaults", () => {
    getConfig().environments.push("mutated");
    expect(DEFAULT_ENVIRONMENTS).toEqual(["dev", "staging", "production"]);
  });
});

describe("getConfig — neverAutoRun", () => {
  // The ONE guarantee that lets this ship to thousands of existing installs: a
  // user who has never heard of the setting gets an empty list, and an empty list
  // blocks nothing. No defaults, ever — a shipped pattern would silently stop a
  // flow someone already relies on.
  it("defaults to an empty list, so the feature ships inert", () => {
    expect(getConfig().neverAutoRun).toEqual([]);
  });

  it("reads the patterns as written, trimming each", () => {
    setConfig({ neverAutoRun: ["  *rm -rf* ", "*| sh*"] });
    expect(getConfig().neverAutoRun).toEqual(["*rm -rf*", "*| sh*"]);
  });

  it("drops blanks and non-strings from a hand-edited settings file", () => {
    setConfig({ neverAutoRun: ["*rm -rf*", "", "   ", 7, null] });
    expect(getConfig().neverAutoRun).toEqual(["*rm -rf*"]);
  });

  // Deliberately NOT the environments treatment, which falls back to its shipped
  // defaults when the setting is unusable. This list has no defaults to fall back
  // to, and inventing one here would be this module blocking commands nobody
  // configured it to block.
  it("reads an empty list when the setting is not an array", () => {
    setConfig({ neverAutoRun: "*rm -rf*" });
    expect(getConfig().neverAutoRun).toEqual([]);
  });
});

describe("getConfig — commands", () => {
  it("reads commands, dropping entries with no id or no run", () => {
    setConfig({ commands: [
      { id: "deploy", label: "Deploy to staging", run: "gh workflow run deploy.yml" },
      { id: "", label: "nameless", run: "true" },
      { id: "noRun", label: "No command" },
    ] });
    expect(getConfig().commands).toEqual([
      { id: "deploy", label: "Deploy to staging", run: "gh workflow run deploy.yml" },
    ]);
  });

  // Unlike promptModes there is nothing to layer a customization over — this
  // pins the fallback itself, not any particular content of it. setConfig()
  // stubs the workspace configuration directly, bypassing VS Code's manifest
  // defaulting, so `c.get("commands")` here returns undefined exactly as it
  // would for a real user who never touched the setting. What this is really
  // pinning is that readCommands' `!Array.isArray(raw)` guard spreads from
  // the DEFAULT_COMMANDS export — not a bare `[]` literal — so a mutation to
  // that export is what a fresh install actually gets, with nothing here
  // free to drift from it.
  it("falls back to DEFAULT_COMMANDS when the setting is absent", () => {
    expect(getConfig().commands).toEqual(DEFAULT_COMMANDS);
  });

  it("falls back to a label when one is missing, never to a blank picker row", () => {
    setConfig({ commands: [{ id: "deploy", run: "true" }] });
    expect(getConfig().commands[0].label).toBe("deploy");
  });

  it("falls back to the id when the label is whitespace-only, not just when it's absent", () => {
    setConfig({ commands: [{ id: "deploy", label: "   ", run: "true" }] });
    expect(getConfig().commands[0].label).toBe("deploy");
  });

  // A plain object, not a string: readCommands' inner filter drops anything
  // that isn't itself an object (`typeof v !== "object"`), so a STRING here
  // would silently pass — each character skipped by that filter, landing on
  // `[]` by accident regardless of whether the array guard ran at all. An
  // object is not iterable, so weakening `!Array.isArray(raw)` to `raw ==
  // null` reaches a `for...of` that throws, which is what actually pins the
  // guard.
  // Same guard, same fallback as the "absent" case above — a non-array value
  // is caught by the same `!Array.isArray(raw)` check and gets the same
  // DEFAULT_COMMANDS spread, not a bare empty list.
  it("falls back to DEFAULT_COMMANDS when the setting is not an array", () => {
    setConfig({ commands: { id: "deploy", run: "true" } });
    expect(getConfig().commands).toEqual(DEFAULT_COMMANDS);
  });

  it("drops a duplicate id, keeping the first entry", () => {
    setConfig({ commands: [
      { id: "deploy", label: "First", run: "one" },
      { id: "deploy", label: "Second", run: "two" },
    ] });
    expect(getConfig().commands).toEqual([{ id: "deploy", label: "First", run: "one" }]);
  });

  it("drops a non-object entry, keeping the usable ones around it", () => {
    setConfig({ commands: [null, 42, "nope", { id: "deploy", run: "true" }] });
    expect(getConfig().commands).toEqual([{ id: "deploy", label: "deploy", run: "true" }]);
  });

  // A plain null/number/string entry is ALSO caught by the id/run check below
  // it (none of those has an `.id`), so the test above alone does not pin
  // `typeof v !== "object"` — removing just that clause still passes it. A
  // function is the one non-object JS value that can carry real properties,
  // so it is what actually exercises this guard on its own: id/run cannot
  // reach this code from real JSON (`agentFlow.commands` is parsed from
  // settings.json), but the reader's own parameter type is `unknown[]`, and
  // this is the shape that makes the type check load-bearing rather than
  // dead code shadowed by the id/run guard.
  it("drops a non-object entry even when it carries id/run-shaped properties of its own", () => {
    const sneaky = Object.assign(() => {}, { id: "sneaky", run: "true" });
    setConfig({ commands: [sneaky, { id: "deploy", run: "true" }] });
    expect(getConfig().commands).toEqual([{ id: "deploy", label: "deploy", run: "true" }]);
  });

  it("drops an entry whose run is whitespace-only", () => {
    setConfig({ commands: [{ id: "deploy", run: "   " }] });
    expect(getConfig().commands).toEqual([]);
  });

  it("drops an entry whose id is whitespace-only", () => {
    setConfig({ commands: [{ id: "   ", run: "true" }] });
    expect(getConfig().commands).toEqual([]);
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

describe("getConfig — agentSurface", () => {
  it("defaults to the extension panel when unset", () => {
    setConfig({ agentSurface: undefined });
    expect(getConfig().agentSurface).toBe("extension");
  });

  it("reads terminal when set", () => {
    setConfig({ agentSurface: "terminal" });
    expect(getConfig().agentSurface).toBe("terminal");
  });

  it("falls back to extension for an unrecognized value", () => {
    // A typo in settings.json must not silently disable seeding — it degrades
    // to the default surface, the same way remoteControl degrades to "off".
    setConfig({ agentSurface: "tmux" });
    expect(getConfig().agentSurface).toBe("extension");
  });
});

describe("getConfig — agentProvider", () => {
  // The mock host is Cursor by default (see test/_mocks/vscode.ts). Every case
  // here states the host it means, and the afterEach puts the default back so a
  // stray "vscode" cannot leak into the ~hundreds of tests that follow.
  afterEach(() => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: undefined });
  });

  it("defaults to claude-code when unset", () => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: undefined });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  it("reads copilot in VS Code", () => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "copilot" });
    expect(getConfig().agentProvider).toBe("copilot");
  });

  it("reads copilot in VS Code Insiders", () => {
    env.uriScheme = "vscode-insiders";
    setConfig({ agentProvider: "copilot" });
    expect(getConfig().agentProvider).toBe("copilot");
  });

  it("degrades copilot to claude-code in Cursor", () => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: "copilot" });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  it("degrades copilot to claude-code in Windsurf", () => {
    env.uriScheme = "windsurf";
    setConfig({ agentProvider: "copilot" });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  it("falls back to claude-code for an unrecognized value", () => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "zed" });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  // Unlike copilot and cursor, the Codex CLI is not tied to an editor — it runs in
  // any host's integrated terminal — so the value survives every host unchanged.
  it("keeps codex in every host", () => {
    for (const scheme of ["cursor", "vscode", "windsurf"]) {
      env.uriScheme = scheme;
      setConfig({ agentProvider: "codex" });
      expect(getConfig().agentProvider).toBe("codex");
    }
  });

  it("keeps cursor in a Cursor host", () => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: "cursor" });
    expect(getConfig().agentProvider).toBe("cursor");
  });

  it("degrades cursor to claude-code in VS Code", () => {
    env.uriScheme = "vscode";
    setConfig({ agentProvider: "cursor" });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  it("degrades cursor to claude-code in an unrelated host", () => {
    env.uriScheme = "windsurf";
    setConfig({ agentProvider: "cursor" });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  it("still degrades copilot to claude-code in Cursor", () => {
    env.uriScheme = "cursor";
    setConfig({ agentProvider: "copilot" });
    expect(getConfig().agentProvider).toBe("claude-code");
  });

  // `ask` is the one value that is not an agent, so unlike copilot and cursor it has
  // no host to be wrong in — it must survive every host untouched, or the picker
  // Task 5 adds would silently never appear for some users.
  it("passes ask through in every host", () => {
    for (const scheme of ["cursor", "vscode", "windsurf"]) {
      env.uriScheme = scheme;
      setConfig({ agentProvider: "ask" });
      expect(getConfig().agentProvider).toBe("ask");
    }
  });
});

describe("hostProviders", () => {
  afterEach(() => {
    env.uriScheme = "cursor";
  });

  it("offers Claude Code, Copilot, and Codex in VS Code", () => {
    env.uriScheme = "vscode";
    expect(hostProviders()).toEqual(["claude-code", "copilot", "codex"]);
  });

  it("offers Claude Code, Cursor, and Codex in Cursor", () => {
    env.uriScheme = "cursor";
    expect(hostProviders()).toEqual(["claude-code", "cursor", "codex"]);
  });

  it("offers Claude Code and Codex in an unrelated host", () => {
    env.uriScheme = "windsurf";
    expect(hostProviders()).toEqual(["claude-code", "codex"]);
  });
});

describe("isCursorHost / providerLabel", () => {
  afterEach(() => {
    env.uriScheme = "cursor";
  });

  it("is true only for the cursor scheme", () => {
    env.uriScheme = "cursor";
    expect(isCursorHost()).toBe(true);
    env.uriScheme = "vscode";
    expect(isCursorHost()).toBe(false);
    env.uriScheme = "windsurf";
    expect(isCursorHost()).toBe(false);
  });

  it("labels every provider", () => {
    expect(providerLabel("claude-code")).toBe("Claude Code");
    expect(providerLabel("copilot")).toBe("Copilot");
    expect(providerLabel("cursor")).toBe("Cursor");
    expect(providerLabel("codex")).toBe("Codex");
  });
});

describe("resolvedProvider", () => {
  it("resolves ask to claude-code and leaves every real agent alone", () => {
    expect(resolvedProvider("ask")).toBe("claude-code");
    expect(resolvedProvider("claude-code")).toBe("claude-code");
    expect(resolvedProvider("copilot")).toBe("copilot");
    expect(resolvedProvider("cursor")).toBe("cursor");
    expect(resolvedProvider("codex")).toBe("codex");
  });

  // Every copy site that names an agent composes providerLabel over resolvedProvider,
  // so this pair is what keeps that copy grammatical: the surrounding templates use
  // the label as a product name ("a X agent", "3 X sessions", "The X prompt"), and a
  // label that is not one breaks all of them. Pinned so nobody reintroduces a phrase.
  it("always yields a bare product name, never a phrase, for every setting", () => {
    for (const setting of ["claude-code", "copilot", "cursor", "codex", "ask"] as const) {
      const label = providerLabel(resolvedProvider(setting));
      expect(["Claude Code", "Copilot", "Cursor", "Codex"]).toContain(label);
      expect(label).not.toMatch(/^(your|the|a|an) /i);
    }
  });

  it("names Claude Code under ask, which is the agent an inert ask actually seeds", () => {
    expect(providerLabel(resolvedProvider("ask"))).toBe("Claude Code");
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
    // Both safety properties of the stock mode's prompt, not just a loose
    // substring: where findings go, and that nothing gets posted automatically.
    expect(c.reviewRequestModes[0].prompt).toContain(".pick-task/REVIEW-{number}.md");
    expect(c.reviewRequestModes[0].prompt).toMatch(/do not post/i);
  });

  it("honors reviewRequests set to false", () => {
    setConfig({ reviewRequests: false });
    expect(getConfig().reviewRequests).toBe(false);
  });

  it("defaults reviewRequestsAlwaysVisible on and honors switching it off", () => {
    expect(getConfig().reviewRequestsAlwaysVisible).toBe(true);
    setConfig({ reviewRequestsAlwaysVisible: false });
    expect(getConfig().reviewRequestsAlwaysVisible).toBe(false);
  });

  it("honors an explicit reviewWrites override", () => {
    setConfig({ reviewWrites: true });
    expect(getConfig().reviewWrites).toBe(true);
  });

  it("defaults mergeWrites off and mergeMethod to squash", () => {
    const c = getConfig();
    expect(c.mergeWrites).toBe(false);
    expect(c.mergeMethod).toBe("squash");
  });

  it("honors explicit mergeWrites and mergeMethod overrides", () => {
    setConfig({ mergeWrites: true, mergeMethod: "rebase" });
    expect(getConfig().mergeWrites).toBe(true);
    expect(getConfig().mergeMethod).toBe("rebase");
  });

  it("falls back to squash on a hand-edited mergeMethod", () => {
    // settings.json is a text file. An unrecognised value must not reach argv as
    // itself — the provider refuses it too, but the config layer should not hand
    // one down in the first place.
    setConfig({ mergeMethod: "fast-forward" as never });
    expect(getConfig().mergeMethod).toBe("squash");
  });

  it("defaults orchestrator to off", () => {
    expect(getConfig().orchestrator).toBe(false);
  });

  it("reads orchestrator when turned on", () => {
    setConfig({ orchestrator: true });
    expect(getConfig().orchestrator).toBe(true);
  });

  it("defaults childWorktrees to on — a ticket with children offers to work them", () => {
    expect(getConfig().childWorktrees).toBe(true);
  });

  it("reads childWorktrees when turned off", () => {
    setConfig({ childWorktrees: false });
    expect(getConfig().childWorktrees).toBe(false);
  });

  it("floors the TTL at 60 seconds", () => {
    setConfig({ reviewRequestsTtlSeconds: 5 });
    expect(getConfig().reviewRequestsTtlSeconds).toBe(60);
  });

  it("honours an explicit TTL above the floor", () => {
    setConfig({ reviewRequestsTtlSeconds: 900 });
    expect(getConfig().reviewRequestsTtlSeconds).toBe(900);
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

  it("falls back to the stock modes when the legacy prompt is explicitly cleared to \"\"", () => {
    // Worth its own test: explicitConfigValue returns "" (not undefined) for a
    // user who cleared the setting, and "" is falsy — the migration must fall
    // through to the stock modes rather than seed a mode whose prompt is empty.
    // An implementation that checked `legacy !== undefined` instead of
    // truthiness would ship that empty-prompt mode and nothing else would catch it.
    setConfig({ reviewRequestPrompt: "" });
    const modes = getConfig().reviewRequestModes;
    expect(modes).toEqual(DEFAULT_REVIEW_REQUEST_MODES);
    expect(modes[0].prompt).toBe(DEFAULT_REVIEW_REQUEST_PROMPT);
  });

  it("layers an explicit modes list over the stock mode and ignores the legacy prompt", () => {
    setConfig({
      reviewRequestPrompt: "legacy",
      reviewRequestModes: [{ id: "backend", label: "Backend", prompt: "BE {number}" }],
    });
    const modes = getConfig().reviewRequestModes;
    expect(modes).toEqual([
      { id: "backend", label: "Backend", prompt: "BE {number}" },
      ...DEFAULT_REVIEW_REQUEST_MODES,
    ]);
    expect(modes.map((m) => m.prompt)).not.toContain("legacy");
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

  it("drops an unusable entry but keeps the usable one and the stock mode", () => {
    setConfig({ reviewRequestModes: [{ id: "ok", label: "OK", prompt: "P" }, { id: "bad", label: "Bad" }] });
    expect(getConfig().reviewRequestModes).toEqual([
      { id: "ok", label: "OK", prompt: "P" },
      ...DEFAULT_REVIEW_REQUEST_MODES,
    ]);
  });

  it("gives back the stock mode to a reviewer who replaced it with their own pair", () => {
    setConfig({
      reviewRequestModes: [
        { id: "backend", label: "Backend", prompt: "BE {number}" },
        { id: "frontend", label: "Frontend", prompt: "FE {number}" },
      ],
    });
    expect(getConfig().reviewRequestModes.map((m) => m.id)).toEqual(["backend", "frontend", "full"]);
  });

  it("honours an explicit reviewRequestMode pin", () => {
    setConfig({ reviewRequestMode: "backend" });
    expect(getConfig().reviewRequestMode).toBe("backend");
  });

  it("still migrates a customized legacy reviewRequestPrompt when reviewRequestModes is only served via the manifest default", () => {
    // The trap this guards against: package.json registers a non-empty manifest
    // default for reviewRequestModes (one entry, id "full"), so a real VS Code
    // install hands that array to `c.get("reviewRequestModes")` for every user
    // who never touched the setting — indistinguishable, to a plain `c.get`
    // read, from a deliberate customization. The plain `setConfig` store above
    // can't model that gap (an unset key there just returns undefined), so this
    // is the one test that actually exercises the manifest-default path and
    // would have caught the regression where the migration below was dead code.
    setDefaultConfig({ reviewRequestModes: DEFAULT_REVIEW_REQUEST_MODES });
    setConfig({ reviewRequestPrompt: "customized legacy prompt" });
    const modes = getConfig().reviewRequestModes;
    expect(modes).toHaveLength(1);
    expect(modes[0].id).toBe("full");
    expect(modes[0].prompt).toBe("customized legacy prompt");
  });
});

describe("deck grouping and retirement settings", () => {
  it("defaults to the Agents view, a 24h finished window and a 7-day abandoned window", () => {
    const c = getConfig();
    expect(c.deckGrouping).toBe("agents");
    expect(c.retireFinishedAfterHours).toBe(24);
    expect(c.retireAbandonedAfterDays).toBe(7);
    expect(c.retireClosedAfterHours).toBe(24);
    expect(c.inflightShowAll).toBe(false);
  });

  it("honours a custom closed window and the show-all escape hatch", () => {
    setConfig({ retireClosedAfterHours: 3, inflightShowAll: true });
    expect(getConfig().retireClosedAfterHours).toBe(3);
    expect(getConfig().inflightShowAll).toBe(true);
  });

  it("floors a negative closed window at zero", () => {
    setConfig({ retireClosedAfterHours: -2 });
    expect(getConfig().retireClosedAfterHours).toBe(0);
  });

  it("honours the workspaces grouping", () => {
    setConfig({ deckGrouping: "workspaces" });
    expect(getConfig().deckGrouping).toBe("workspaces");
  });

  it("falls back to agents for an unknown grouping value", () => {
    setConfig({ deckGrouping: "sideways" });
    expect(getConfig().deckGrouping).toBe("agents");
  });

  it("honours custom retirement windows", () => {
    setConfig({ retireFinishedAfterHours: 2, retireAbandonedAfterDays: 30 });
    expect(getConfig().retireFinishedAfterHours).toBe(2);
    expect(getConfig().retireAbandonedAfterDays).toBe(30);
  });

  it("keeps zero as zero — it is the documented way to disable each window", () => {
    setConfig({ retireFinishedAfterHours: 0, retireAbandonedAfterDays: 0 });
    expect(getConfig().retireFinishedAfterHours).toBe(0);
    expect(getConfig().retireAbandonedAfterDays).toBe(0);
  });

  it("floors a negative window at zero rather than retiring on a clock that runs backwards", () => {
    setConfig({ retireFinishedAfterHours: -5, retireAbandonedAfterDays: -1 });
    expect(getConfig().retireFinishedAfterHours).toBe(0);
    expect(getConfig().retireAbandonedAfterDays).toBe(0);
  });
});

describe("package.json ⇄ config constants", () => {
  const props = manifestSettings<{ default?: unknown }>(pkg);

  it("keeps each explore prompt schema default byte-identical to its config constant", () => {
    expect(props["agentFlow.explorePrompts.jiraTicket"].default).toBe(DEFAULT_EXPLORE_JIRA_TICKET_PROMPT);
    expect(props["agentFlow.explorePrompts.knowledge"].default).toBe(DEFAULT_EXPLORE_PROMPT);
    expect(props["agentFlow.explorePrompts.debug"].default).toBe(DEFAULT_EXPLORE_DEBUG_PROMPT);
    expect(props["agentFlow.explorePrompts.general"].default).toBe(DEFAULT_EXPLORE_GENERAL_PROMPT);
    expect(props["agentFlow.explorePrompts.supervise"].default).toBe(DEFAULT_EXPLORE_SUPERVISE_PROMPT);
    expect(props["agentFlow.explorePrompts.verify"].default).toBe(DEFAULT_EXPLORE_VERIFY_PROMPT);
  });

  it("keeps the promptModes schema default byte-identical to DEFAULT_PROMPT_MODES", () => {
    // This is the one users actually get: an untouched setting resolves to the
    // manifest default, so the code constant alone being right reaches nobody.
    expect(props["agentFlow.promptModes"].default).toEqual(DEFAULT_PROMPT_MODES);
  });

  it("leaves label, detail and prompt out of the promptModes required fields", () => {
    const p = props["agentFlow.promptModes"] as { items?: { required?: string[]; properties?: Record<string, unknown> } };
    expect(p.items?.required).toEqual(["id"]);
    expect(Object.keys(p.items?.properties ?? {})).toContain("detail");
  });

  it("keeps the environments schema default equal to DEFAULT_ENVIRONMENTS", () => {
    expect(props["agentFlow.environments"].default).toEqual(DEFAULT_ENVIRONMENTS);
  });

  // Same rationale as the promptModes/environments parity checks above: an
  // untouched setting resolves to the manifest default, so the code constant
  // alone being right (and inert) reaches nobody — a manifest edit that drifted
  // from DEFAULT_COMMANDS, or swapped in something that actually does
  // something, is exactly what this test exists to catch. Confirmed to fail if
  // only the manifest default's label is mutated, independent of the code
  // constant.
  it("keeps the commands schema default equal to DEFAULT_COMMANDS", () => {
    expect(props["agentFlow.commands"].default).toEqual(DEFAULT_COMMANDS);
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
  it("declares reviewWrites defaulting to false — one of the two settings that write to GitHub", () => {
    expect(props["agentFlow.reviewWrites"].default).toBe(false);
  });

  // Same reasoning as the reviewWrites default above: getConfig()'s own `?? false`
  // only exercises the vscode mock's unset-key behaviour, never the manifest
  // default a real VS Code install serves. A `"default": true` typo here would
  // ship the only path in this extension that merges to a default branch switched
  // on, and every getConfig() test would stay green.
  it("declares mergeWrites defaulting to false — the only setting that merges", () => {
    expect(props["agentFlow.mergeWrites"].default).toBe(false);
  });

  it("declares mergeMethod defaulting to squash, over exactly the three strategies", () => {
    const m = props["agentFlow.mergeMethod"] as { default?: unknown; enum?: unknown };
    expect(m.default).toBe("squash");
    expect(m.enum).toEqual(["squash", "merge", "rebase"]);
  });

  it("declares orchestrator defaulting to false — the feature that will run agents on a timer", () => {
    expect(props["agentFlow.orchestrator"].default).toBe(false);
  });

  it("declares childWorktrees defaulting to true — a ticket with children offers to work them", () => {
    expect(props["agentFlow.childWorktrees"].default).toBe(true);
  });

  it("declares deckGrouping defaulting to agents, and both retirement windows", () => {
    const g = props["agentFlow.deckGrouping"] as { default?: unknown; enum?: unknown };
    expect(g.default).toBe("agents");
    expect(g.enum).toEqual(["agents", "workspaces"]);
    const fin = props["agentFlow.retireFinishedAfterHours"] as { default?: unknown; minimum?: unknown };
    expect(fin.default).toBe(24);
    expect(fin.minimum).toBe(0);
    const ab = props["agentFlow.retireAbandonedAfterDays"] as { default?: unknown; minimum?: unknown };
    expect(ab.default).toBe(7);
    expect(ab.minimum).toBe(0);
  });

  it("declares inflightShowAll defaulting to false and retireClosedAfterHours to 24", () => {
    expect(props["agentFlow.inflightShowAll"].default).toBe(false);
    const closed = props["agentFlow.retireClosedAfterHours"] as { default?: unknown; minimum?: unknown };
    expect(closed.default).toBe(24);
    expect(closed.minimum).toBe(0);
  });

  it("ships a manifest default of false for notifyOnActionRequired, so the toast reaches nobody who did not opt in", () => {
    // The reader's `?? false` is not enough on its own: it only fires when the
    // setting is absent. A manifest default of true would opt every install in
    // without touching a line of TypeScript, and the mock-based test above
    // cannot see package.json at all.
    expect(props["agentFlow.notifyOnActionRequired"].default).toBe(false);
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

  it.each(["agentFlow.promptModes", "agentFlow.reviewRequestModes"])(
    "requires only an id per entry of %s, so an override or a hide entry validates",
    (key) => {
      const items = (props[key] as { items: { required: string[]; properties: Record<string, unknown> } }).items;
      expect(items.required).toEqual(["id"]);
      expect(items.properties.hidden).toEqual({
        type: "boolean",
        description: "Set to true to drop this built-in mode from the picker.",
      });
    },
  );

  it.each(["agentFlow.promptModes", "agentFlow.reviewRequestModes"])(
    "documents that %s layers over the built-in modes",
    (key) => {
      const md = (props[key] as { markdownDescription: string }).markdownDescription;
      expect(md).toMatch(/layer/i);
      expect(md).toContain('"hidden": true');
    },
  );
});

describe("forge", () => {
  it("defaults to github", () => {
    expect(getConfig().forge).toBe("github");
  });

  it("reads an explicit gitlab", () => {
    setConfig({ forge: "gitlab" });
    expect(getConfig().forge).toBe("gitlab");
  });

  // Validation belongs to resolveForge, which falls back and logs. getConfig's job
  // is only to report what the user actually wrote.
  it("passes an unknown value through untouched", () => {
    setConfig({ forge: "bitbucket" });
    expect(getConfig().forge).toBe("bitbucket");
  });

  it("treats an empty string as the default", () => {
    setConfig({ forge: "" });
    expect(getConfig().forge).toBe("github");
  });

  // This is the actual compatibility guarantee: nothing in getConfig() reads
  // package.json, so a manifest default of "gitlab" would ship silently unless
  // something pins it. An existing install with no explicit `agentFlow.forge`
  // gets whatever VS Code's settings UI serves from this manifest default.
  // Nothing in getConfig() reads package.json, so the manifest default is a
  // separate promise from the code default — and this is the one setting where a
  // non-empty manifest default would start refusing commands on installs that
  // never opted in.
  it("ships an empty manifest default for neverAutoRun", () => {
    const props = manifestSettings<{ default?: unknown }>(pkg);
    expect(props["agentFlow.neverAutoRun"].default).toEqual([]);
  });

  it("ships a manifest default of github, so an existing install is unaffected", () => {
    const props = manifestSettings<{ default?: unknown }>(pkg);
    expect(props["agentFlow.forge"].default).toBe("github");
  });
});

describe("getConfig — attention notifications", () => {
  it("defaults notifyOnActionRequired off — a toast interrupts, so it ships inert", () => {
    expect(getConfig().notifyOnActionRequired).toBe(false);
  });

  it("reads notifyOnActionRequired when the user turns it on", () => {
    setConfig({ notifyOnActionRequired: true });
    expect(getConfig().notifyOnActionRequired).toBe(true);
  });
});

describe("forge-flavoured prompts", () => {
  // The placeholders a template actually offers, read off the template itself
  // rather than hand-typed here — a hand-typed list can quietly assert a
  // placeholder the template doesn't really contain (DEFAULT_PR_REVIEW_PROMPT's
  // own doc comment claims {brief} among its placeholders, but the literal
  // string never uses it; only {key} {summary} {url} {files} actually appear).
  const placeholdersOf = (s: string): string[] => s.match(/\{[a-zA-Z]+\}/g) ?? [];

  it("keeps the GitHub prompt verbatim on github", () => {
    expect(getConfig().prReviewPrompt).toBe(DEFAULT_PR_REVIEW_PROMPT);
    expect(getConfig().prReviewPrompt).toContain("gh pr checkout");
  });

  it("seeds the GitLab wording on gitlab", () => {
    setConfig({ forge: "gitlab" });
    const p = getConfig().prReviewPrompt;
    expect(p).toBe(GITLAB_PR_REVIEW_PROMPT);
    expect(p).toContain("glab mr checkout");
    expect(p).not.toContain("gh pr checkout");
    expect(p).toContain("merge request");
  });

  it("seeds the Bitbucket wording on bitbucket", () => {
    setConfig({ forge: "bitbucket" });
    const p = getConfig().prReviewPrompt;
    expect(p).toBe(BITBUCKET_PR_REVIEW_PROMPT);
    expect(p).not.toContain("gh pr checkout");
    expect(p).not.toContain("pr checkout");
    expect(p).toContain("git checkout");
    expect(p).toContain("Bitbucket");
  });

  // A user who wrote their own prompt keeps it on either forge: we do not know
  // better than they do what their prompt should say.
  it("never clobbers a customized prompt", () => {
    setConfig({ forge: "gitlab", prReviewPrompt: "my own words" });
    expect(getConfig().prReviewPrompt).toBe("my own words");
  });

  // An EXPLICITLY BLANK setting is what clearing this multilineText field in the
  // VS Code settings UI writes, and it must fall back to the forge's shipped
  // wording — never seed an empty prompt. `explicitConfigValue` returns `""`
  // verbatim, so this only holds while the fallback is `||`; with `??` (which
  // short-circuits on nullish alone) the agent would be launched with no
  // instructions at all, and nothing downstream would catch it —
  // `prReviewTemplate` returns its argument unchanged. On github this is the
  // pre-seam behaviour (`c.get("prReviewPrompt") || DEFAULT_PR_REVIEW_PROMPT`),
  // which this branch promises not to change.
  it.each([
    ["github", DEFAULT_PR_REVIEW_PROMPT],
    ["gitlab", GITLAB_PR_REVIEW_PROMPT],
    ["bitbucket", BITBUCKET_PR_REVIEW_PROMPT],
  ])("falls back to the %s default when the setting is explicitly blank", (forge, expected) => {
    setConfig({ forge, prReviewPrompt: "" });
    expect(getConfig().prReviewPrompt).toBe(expected);
  });

  // Whitespace is not blank: someone who typed spaces wrote something, and the
  // `||` fallback deliberately does not trim (unlike `nonBlank`, which the mode
  // resolver uses for picker chrome). Pinned so a later "tidy-up" that adds a
  // `.trim()` has to argue with a test rather than change behaviour silently.
  it("keeps a whitespace-only prompt, since the user did write it", () => {
    setConfig({ prReviewPrompt: "   " });
    expect(getConfig().prReviewPrompt).toBe("   ");
  });

  it("preserves every placeholder the GitHub prompt actually offers", () => {
    setConfig({ forge: "gitlab" });
    const p = getConfig().prReviewPrompt;
    for (const ph of placeholdersOf(DEFAULT_PR_REVIEW_PROMPT)) {
      expect(p).toContain(ph);
    }
  });

  it("swaps the first review mode's prompt too, and keeps its placeholders", () => {
    setConfig({ forge: "gitlab" });
    const first = getConfig().reviewRequestModes[0].prompt;
    expect(first).toBe(GITLAB_REVIEW_REQUEST_PROMPT);
    expect(first).toContain("glab mr checkout");
    for (const ph of placeholdersOf(DEFAULT_REVIEW_REQUEST_PROMPT)) {
      expect(first).toContain(ph);
    }
  });

  it("swaps the first review mode's prompt to Bitbucket wording too", () => {
    setConfig({ forge: "bitbucket" });
    const first = getConfig().reviewRequestModes[0].prompt;
    expect(first).toBe(BITBUCKET_REVIEW_REQUEST_PROMPT);
    expect(first).not.toContain("pr checkout");
    expect(first).toContain("destination branch");
  });

  // The legacy reviewRequestPrompt migration path is untouched by forge: a user
  // who customized it keeps their exact words on gitlab too, same as the
  // never-clobbers-a-customized-prompt guarantee above for prReviewPrompt.
  it("keeps a legacy customized reviewRequestPrompt verbatim on gitlab too", () => {
    setConfig({ forge: "gitlab", reviewRequestPrompt: "my legacy words" });
    expect(getConfig().reviewRequestModes[0].prompt).toBe("my legacy words");
  });
});

describe("forge-flavoured shipped prompts", () => {
  it("ships Bitbucket wording for a Bitbucket install", () => {
    const prompt = shippedPrReviewPrompt("bitbucket");
    expect(prompt).toContain("Bitbucket");
    expect(prompt).not.toContain("GitHub");
    expect(prompt).not.toContain("GitLab");
    // `atlassian-cli` has NO checkout subcommand — `gh pr checkout` has no
    // equivalent here, and naming one would send the session to a command that
    // does not exist.
    expect(prompt).not.toContain("pr checkout");
    expect(prompt).toContain("git checkout");
  });

  it("gives the first stock review mode the Bitbucket wording", () => {
    const modes = shippedReviewRequestModes("bitbucket");
    expect(modes[0].prompt).toContain("Bitbucket");
    expect(modes.slice(1)).toEqual(DEFAULT_REVIEW_REQUEST_MODES.slice(1));
  });

  it("still falls back to the GitHub baseline for an unknown forge", () => {
    // `resolveForge` falls back to github for an unregistered id, so the shipped
    // prompt must agree — otherwise a typo'd setting yields a card whose prompt
    // and whose forge disagree about which tool the session should reach for.
    expect(shippedPrReviewPrompt("wat")).toBe(DEFAULT_PR_REVIEW_PROMPT);
    expect(shippedReviewRequestModes("wat")).toBe(DEFAULT_REVIEW_REQUEST_MODES);
  });
});

describe("getConfig — non-numeric setting values fall back to the documented default", () => {
  // A settings.json hand-edit can hold any JSON type; `c.get<number>` is a cast,
  // not a check, and `Math.max(1, "six")` is NaN. NaN then poisons every
  // comparison downstream — `authorising > cfg.batchLaunchConfirmThreshold` is
  // always false, so the batch-launch safety modal silently never appears.
  it("batchLaunchConfirmThreshold: a string value reads as the default 6", () => {
    setConfig({ batchLaunchConfirmThreshold: "six" });
    expect(getConfig().batchLaunchConfirmThreshold).toBe(6);
  });

  it("batchLaunchConfirmThreshold: NaN reads as the default 6", () => {
    setConfig({ batchLaunchConfirmThreshold: NaN });
    expect(getConfig().batchLaunchConfirmThreshold).toBe(6);
  });

  it("prFactsTtlSeconds: a string value reads as the default 120", () => {
    setConfig({ prFactsTtlSeconds: "two minutes" });
    expect(getConfig().prFactsTtlSeconds).toBe(120);
  });

  it("reviewRequestsTtlSeconds: a string value reads as the default 300", () => {
    setConfig({ reviewRequestsTtlSeconds: "later" });
    expect(getConfig().reviewRequestsTtlSeconds).toBe(300);
  });

  it("retire windows: string values read as their defaults", () => {
    setConfig({
      retireFinishedAfterHours: "a day",
      retireAbandonedAfterDays: "a week",
      retireClosedAfterHours: "24h",
      retireInPlaceAfterHours: "never",
    });
    const c = getConfig();
    expect(c.retireFinishedAfterHours).toBe(24);
    expect(c.retireAbandonedAfterDays).toBe(7);
    expect(c.retireClosedAfterHours).toBe(24);
    expect(c.retireInPlaceAfterHours).toBe(0);
  });

  it("Infinity is refused too — the fallback is Number.isFinite, not typeof", () => {
    setConfig({ prFactsTtlSeconds: Infinity });
    expect(getConfig().prFactsTtlSeconds).toBe(120);
  });

  // The clamps must survive the helper unchanged: a finite but out-of-range
  // number still clamps to the floor rather than falling back to the default.
  it("keeps every existing floor clamp for finite out-of-range numbers", () => {
    setConfig({
      batchLaunchConfirmThreshold: 0,
      prFactsTtlSeconds: 1,
      reviewRequestsTtlSeconds: 5,
      retireFinishedAfterHours: -5,
      retireAbandonedAfterDays: -1,
      retireClosedAfterHours: -3,
      retireInPlaceAfterHours: -2,
    });
    const c = getConfig();
    expect(c.batchLaunchConfirmThreshold).toBe(1);
    expect(c.prFactsTtlSeconds).toBe(30);
    expect(c.reviewRequestsTtlSeconds).toBe(60);
    expect(c.retireFinishedAfterHours).toBe(0);
    expect(c.retireAbandonedAfterDays).toBe(0);
    expect(c.retireClosedAfterHours).toBe(0);
    expect(c.retireInPlaceAfterHours).toBe(0);
  });

  it("still honors in-range explicit numbers through the finite check", () => {
    setConfig({ batchLaunchConfirmThreshold: 3, prFactsTtlSeconds: 300, retireInPlaceAfterHours: 0 });
    const c = getConfig();
    expect(c.batchLaunchConfirmThreshold).toBe(3);
    expect(c.prFactsTtlSeconds).toBe(300);
    expect(c.retireInPlaceAfterHours).toBe(0);
  });
});

/** README § Quick start: "The extension ships no organization-specific
 * defaults." That is a promise about the SHIPPED MANIFEST, not about
 * `getConfig()` — nothing in getConfig reads package.json, so its own `|| ""`
 * fallbacks only ever exercise the vscode mock's unset-key behaviour and would
 * stay green with `"default": "https://acme.atlassian.net"` sitting in the
 * manifest. Same reasoning as the reviewWrites / mergeWrites / neverAutoRun
 * manifest-default tests above, and the same failure mode: an org value baked
 * into a default reaches every install that never touched the setting. */
describe("package.json ships no organization-specific defaults", () => {
  const props = manifestSettings<{ default?: unknown }>(pkg);

  it("declares the two Jira identity settings with an empty default, for the wizard to collect", () => {
    expect(props["agentFlow.jira.baseUrl"].default).toBe("");
    expect(props["agentFlow.jira.project"].default).toBe("");
  });

  it("leaves every other org-shaped setting empty in the manifest too", () => {
    // The rest of the settings that could name one company: the Salesforce
    // connector's three, the reserved clone org, and the repo blocklist.
    expect(props["agentFlow.agileAccelerator.instanceUrl"].default).toBe("");
    expect(props["agentFlow.agileAccelerator.team"].default).toBe("");
    expect(props["agentFlow.agileAccelerator.targetOrg"].default).toBe("");
    expect(props["agentFlow.githubOrg"].default).toBe("");
    expect(props["agentFlow.repoBlocklist"].default).toEqual([]);
  });
});
