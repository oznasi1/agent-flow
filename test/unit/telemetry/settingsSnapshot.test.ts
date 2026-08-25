import { describe, expect, it } from "vitest";
import {
  AgentFlowConfig, BITBUCKET_PR_REVIEW_PROMPT, DEFAULT_PROMPT_MODES, DEFAULT_REVIEW_REQUEST_MODES, MERGE_METHODS, getConfig,
} from "../../../src/config";
import {
  AGENT_PROVIDERS, AGENT_SURFACES, DEFAULT_FILTER_VALUES, EXPLORE_MODES, OPEN_IN_MODES, REMOTE_CONTROL_MODES,
  settingsSnapshot, WORKSPACE_MODES, WORKTREE_MODES,
} from "../../../src/telemetry/settingsSnapshot";
import { STOCK_REVIEW_MODES } from "../../../src/telemetry/events";
import { CONNECTOR_IDS } from "../../../src/tasks/registry";
import { FORGE_IDS } from "../../../src/engine/forge/registry";
import { setConfig } from "../../_mocks/vscode";
import pkg from "../../../package.json";

describe("settingsSnapshot", () => {
  it("reports the shipped defaults", () => {
    const s = settingsSnapshot(getConfig());
    expect(s.workspace_mode).toBe("auto");
    expect(s.open_in).toBe("ask");
    expect(s.explore_mode).toBe("ask");
    expect(s.worktree).toBe("ask");
    expect(s.remote_control).toBe("off");
    expect(s.default_filter).toBe("mysprint");
    expect(s.task_mode).toBe("ask");
    expect(s.prompt_modes_count).toBe(6);
    expect(s.prompt_modes_overridden).toBe(0);
    expect(s.prompt_modes_custom).toBe(0);
    expect(s.prompt_modes_hidden).toBe(0);
    expect(s.explore_prompts_customized).toBe(false);
    expect(s.pr_review_prompt_customized).toBe(false);
    expect(s.open_agents).toBe(true);
    expect(s.review_writes).toBe(false);
    expect(s.orchestrator).toBe(false);
    expect(s.child_worktrees).toBe(true);
    expect(s.repo_blocklist_count).toBe(0);
    // One, not zero: DEFAULT_COMMANDS now ships a single inert example, and an
    // untouched setting resolves to it.
    expect(s.commands_count).toBe(1);
    expect(s.review_mode).toBe("ask");
    expect(s.review_modes_count).toBe(1);
    expect(s.review_modes_overridden).toBe(0);
    expect(s.review_modes_custom).toBe(0);
    expect(s.review_modes_hidden).toBe(0);
    expect(s.forge).toBe("github");
  });

  it("collapses a user-authored taskMode id to 'custom'", () => {
    const cfg = { ...getConfig(), taskMode: "acme-billing-hotfix" };
    expect(settingsSnapshot(cfg).task_mode).toBe("custom");
  });

  it("reports a shipped taskMode id as 'stock'", () => {
    const cfg = { ...getConfig(), taskMode: "tdd" };
    expect(settingsSnapshot(cfg).task_mode).toBe("stock");
  });

  it("collapses a user-authored reviewRequestMode id to 'custom'", () => {
    const cfg = { ...getConfig(), reviewRequestMode: "acme-backend" };
    const s = settingsSnapshot(cfg);
    expect(s.review_mode).toBe("custom");
    expect(JSON.stringify(s)).not.toContain("acme-backend");
  });

  it("reports the shipped reviewRequestMode id as 'stock'", () => {
    expect(settingsSnapshot({ ...getConfig(), reviewRequestMode: "full" }).review_mode).toBe("stock");
  });

  it("counts customized review modes without revealing them", () => {
    const cfg = {
      ...getConfig(),
      reviewRequestModes: [
        { id: "acme-backend", label: "Backend services", detail: "D", prompt: "P" },
        { id: "acme-frontend", label: "Frontend", detail: "D", prompt: "P" },
      ],
    };
    const s = settingsSnapshot(cfg);
    expect(s.review_modes_custom).toBe(2);
    expect(s.review_modes_overridden).toBe(0);
    // This cfg is hand-built, bypassing resolveModes — the real resolver would
    // append the missing "full" built-in rather than list only these two
    // customs, so "hidden: 1" alongside a resolved length of 2 is a state it
    // could never actually produce. This pins modeCounts in isolation, not a
    // reachable resolved list.
    expect(s.review_modes_hidden).toBe(1);
    expect(s.review_modes_count).toBe(2);
    expect(JSON.stringify(s)).not.toContain("acme-");
  });

  it("counts customized prompt modes without revealing them", () => {
    const cfg = { ...getConfig(), promptModes: [{ id: "mine", label: "L", detail: "D", prompt: "P" }] };
    const s = settingsSnapshot(cfg);
    expect(s.prompt_modes_custom).toBe(1);
    expect(s.prompt_modes_overridden).toBe(0);
    // Same as the review-modes case above: this hand-built cfg bypasses
    // resolveModes, so "hidden: 6" (every built-in) alongside a resolved
    // length of 1 is a state the real resolver could never produce — an
    // all-hidden list falls back to the built-ins there. This pins modeCounts
    // in isolation, not a reachable resolved list.
    expect(s.prompt_modes_hidden).toBe(DEFAULT_PROMPT_MODES.length);
    expect(s.prompt_modes_count).toBe(1);
    expect(JSON.stringify(s)).not.toContain("mine");
  });

  it("flags a customized explore prompt without revealing it", () => {
    const cfg = getConfig();
    const exploreActions = cfg.exploreActions.map((a) =>
      a.id === "debug" ? { ...a, prompt: "acme-internal debug prompt" } : a,
    );
    const s = settingsSnapshot({ ...cfg, exploreActions });
    expect(s.explore_prompts_customized).toBe(true);
    expect(JSON.stringify(s)).not.toContain("acme-internal");
  });

  it("does not flag explore prompts as customized when only slackDm toggles", () => {
    const cfg = getConfig();
    const exploreActions = cfg.exploreActions.map((a) => ({ ...a, slackDm: true }));
    const s = settingsSnapshot({ ...cfg, exploreActions });
    expect(s.explore_prompts_customized).toBe(false);
  });

  it("flags a customized PR review prompt without revealing it", () => {
    const cfg = { ...getConfig(), prReviewPrompt: "acme-internal PR review prompt" };
    const s = settingsSnapshot(cfg);
    expect(s.pr_review_prompt_customized).toBe(true);
    expect(JSON.stringify(s)).not.toContain("acme-internal");
  });

  it("emits no value derived from a user string", () => {
    const cfg = {
      ...getConfig(),
      baseUrl: "https://acme.atlassian.net", project: "BILL", githubOrg: "acme-inc",
      reposRoot: "/Users/someone/dev", workspaceDir: "/Users/someone/ws",
      provenanceLabel: "acme-label", repoBlocklist: ["secret-repo"],
      // A sentinel in every field, not only `run`: id and label are just as
      // user-authored as the command text itself, and only its length may
      // ever cross into telemetry (see commands_count).
      commands: [{ id: "cmd-id-leak", label: "cmd-label-leak", run: "cmd-run-leak" }],
    };
    const serialized = JSON.stringify(settingsSnapshot(cfg));
    for (const leak of ["acme", "BILL", "someone", "secret-repo", "atlassian", "cmd-id-leak", "cmd-label-leak", "cmd-run-leak"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("collapses a hand-edited defaultFilter/exploreMode holding a plausible secret to the 'invalid' sentinel, distinct from the shipped default", () => {
    const secret = "acme-internal-BILL-1234";
    const cfg = { ...getConfig(), defaultFilter: secret, exploreMode: secret };
    const s = settingsSnapshot(cfg);
    // Not the shipped default ("mysprint" / "ask") — that would be indistinguishable
    // from a user who genuinely left the setting untouched.
    expect(s.default_filter).toBe("invalid");
    expect(s.explore_mode).toBe("invalid");
    expect(s.default_filter).not.toBe("mysprint");
    expect(s.explore_mode).not.toBe("ask");
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("acme");
    expect(serialized).not.toContain("BILL");
  });

  it("collapses a hand-edited value for every other enum-ish field to the 'invalid' sentinel, distinct from the shipped default", () => {
    const secret = "acme-internal-BILL-5678" as AgentFlowConfig["workspaceMode"];
    const cfg: AgentFlowConfig = {
      ...getConfig(),
      workspaceMode: secret,
      openIn: secret as unknown as AgentFlowConfig["openIn"],
      worktree: secret as unknown as AgentFlowConfig["worktree"],
      remoteControl: secret as unknown as AgentFlowConfig["remoteControl"],
    };
    const s = settingsSnapshot(cfg);
    expect(s.workspace_mode).toBe("invalid");
    expect(s.open_in).toBe("invalid");
    expect(s.worktree).toBe("invalid");
    expect(s.remote_control).toBe("invalid");
    // Distinct from every shipped default — a garbage value must never be
    // reported as if the user genuinely left the setting untouched.
    expect(s.workspace_mode).not.toBe("auto");
    expect(s.open_in).not.toBe("ask");
    expect(s.worktree).not.toBe("ask");
    expect(s.remote_control).not.toBe("off");
    expect(JSON.stringify(s)).not.toContain("acme-internal-BILL-5678");
  });

  it("reports a verify exploreMode as itself, not as invalid", () => {
    expect(settingsSnapshot({ ...getConfig(), exploreMode: "verify" }).explore_mode).toBe("verify");
  });

  it("reports a supervise exploreMode as itself, not as invalid", () => {
    expect(settingsSnapshot({ ...getConfig(), exploreMode: "supervise" }).explore_mode).toBe("supervise");
  });

  it("does not flag the shipped environment list as customized", () => {
    expect(settingsSnapshot(getConfig()).environments_customized).toBe(false);
  });

  it("flags a customized environment list without revealing the names", () => {
    const s = settingsSnapshot({ ...getConfig(), environments: ["acme-prod-eu", "acme-canary"] });
    expect(s.environments_customized).toBe(true);
    expect(JSON.stringify(s)).not.toContain("acme");
  });

  it("treats a reordered environment list as customized", () => {
    const s = settingsSnapshot({ ...getConfig(), environments: ["production", "staging", "dev"] });
    expect(s.environments_customized).toBe(true);
  });

  it("reports the task source, and collapses an unregistered one", () => {
    expect(settingsSnapshot({ ...getConfig(), taskSource: "jira" }).task_source).toBe("jira");
    expect(settingsSnapshot({ ...getConfig(), taskSource: "acme" }).task_source).toBe("invalid");
  });

  it("reports a registered forge as itself", () => {
    expect(settingsSnapshot({ ...getConfig(), forge: "gitlab" }).forge).toBe("gitlab");
  });

  it("reports an unregistered forge as invalid rather than transmitting it", () => {
    expect(settingsSnapshot({ ...getConfig(), forge: "our-internal-thing" }).forge).toBe("invalid");
  });

  // A stock GitLab install has touched NOTHING, and must read as untouched. Two of
  // the shipped values are forge-flavoured — `prReviewPrompt` and the first stock
  // review mode's prompt — so comparing them against the GitHub baselines fired
  // `pr_review_prompt_customized: true` and `review_modes_overridden: 1` for the
  // entire GitLab population, which is the direction that destroys both metrics:
  // docs/TELEMETRY.md says they mean "the user-authored text was changed from the
  // shipped default", and picking a forge is not authoring text. Built through the
  // real `getConfig()`, not a hand-assembled cfg, because the bug lived precisely
  // in the disagreement between what getConfig seeds and what this file compares
  // against.
  it("reports a stock gitlab install as having customized nothing", () => {
    setConfig({ forge: "gitlab" });
    const s = settingsSnapshot(getConfig());
    expect(s.forge).toBe("gitlab");
    expect(s.pr_review_prompt_customized).toBe(false);
    expect(s.review_modes_overridden).toBe(0);
    expect(s.review_modes_custom).toBe(0);
    expect(s.review_modes_hidden).toBe(0);
  });

  // The other direction, so the two tests together prove the fields still
  // DISCRIMINATE on gitlab rather than having been flattened to false.
  it("still reports a customized prompt and mode on gitlab", () => {
    setConfig({
      forge: "gitlab",
      prReviewPrompt: "my own words",
      reviewRequestModes: [{ id: "full", prompt: "my own review words" }],
    });
    const s = settingsSnapshot(getConfig());
    expect(s.pr_review_prompt_customized).toBe(true);
    expect(s.review_modes_overridden).toBe(1);
  });

  it("reports a stock Bitbucket install as uncustomized", () => {
    // Comparing a Bitbucket install against the GitHub default would report a
    // customized prompt for every stock install — the direction that destroys the
    // metric, since it makes "the user wrote their own words" indistinguishable
    // from "the user picked a forge".
    setConfig({ forge: "bitbucket" });
    const cfg = getConfig();
    // Pinned against the raw exported constant, not just against whatever
    // `shippedPrReviewPrompt` currently returns: comparing a value only against
    // the same function that produced it can stay green even if that function's
    // bitbucket case quietly regresses to the GitHub default, since both the seed
    // and the comparison would be wrong together.
    expect(cfg.prReviewPrompt).toBe(BITBUCKET_PR_REVIEW_PROMPT);
    const s = settingsSnapshot(cfg);
    expect(s.forge).toBe("bitbucket");
    expect(s.pr_review_prompt_customized).toBe(false);
    expect(s.review_modes_overridden).toBe(0);
  });

  it("still reports a customized prompt and mode on bitbucket", () => {
    setConfig({
      forge: "bitbucket",
      prReviewPrompt: "my own words",
      reviewRequestModes: [{ id: "full", prompt: "my own review words" }],
    });
    const s = settingsSnapshot(getConfig());
    expect(s.pr_review_prompt_customized).toBe(true);
    expect(s.review_modes_overridden).toBe(1);
  });

  it("reports the agent surface, collapsing an unknown value to invalid", () => {
    expect(settingsSnapshot({ ...getConfig(), agentSurface: "terminal" }).agent_surface).toBe("terminal");
    expect(
      settingsSnapshot({ ...getConfig(), agentSurface: "tmux" as never }).agent_surface,
    ).toBe("invalid");
  });

  it("reports agent_provider", () => {
    expect(settingsSnapshot({ ...getConfig(), agentProvider: "copilot" }).agent_provider).toBe("copilot");
  });

  it("collapses an unrecognized agentProvider to invalid", () => {
    expect(
      settingsSnapshot({ ...getConfig(), agentProvider: "codex" as never }).agent_provider,
    ).toBe("invalid");
  });
});

describe("package.json ⇄ settingsSnapshot enum whitelists", () => {
  // settingsSnapshot.ts hand-duplicates each setting's manifest `enum` so it can
  // validate a config value without importing package.json into the extension's
  // runtime bundle. Nothing else catches these two lists drifting apart — a new
  // manifest option added and forgotten here would silently collapse to
  // "invalid" forever. Same pattern as config.test.ts's DEFAULT_PROMPT_MODES /
  // DEFAULT_PR_REVIEW_PROMPT parity tests.
  const props = pkg.contributes.configuration.properties as Record<
    string,
    { enum?: string[]; enumDescriptions?: string[] }
  >;

  it("keeps WORKSPACE_MODES equal to agentFlow.workspaceMode's manifest enum", () => {
    expect([...WORKSPACE_MODES]).toEqual(props["agentFlow.workspaceMode"].enum);
  });

  it("keeps OPEN_IN_MODES equal to agentFlow.openIn's manifest enum", () => {
    expect([...OPEN_IN_MODES]).toEqual(props["agentFlow.openIn"].enum);
  });

  it("keeps EXPLORE_MODES equal to agentFlow.exploreMode's manifest enum", () => {
    expect([...EXPLORE_MODES]).toEqual(props["agentFlow.exploreMode"].enum);
  });

  it("keeps agentFlow.exploreMode's enum and enumDescriptions the same length", () => {
    // enumDescriptions is positional — VS Code pairs entry i of enumDescriptions
    // with entry i of enum. Equal length alone doesn't guarantee they're correctly
    // paired, but a length mismatch guarantees they're NOT: an enum entry with no
    // description, or a description pointing at the wrong option.
    expect(props["agentFlow.exploreMode"].enumDescriptions?.length).toBe(
      props["agentFlow.exploreMode"].enum?.length,
    );
  });

  it("keeps WORKTREE_MODES equal to agentFlow.worktree's manifest enum", () => {
    expect([...WORKTREE_MODES]).toEqual(props["agentFlow.worktree"].enum);
  });

  it("keeps MERGE_METHODS in step with the manifest enum", () => {
    expect([...MERGE_METHODS]).toEqual(props["agentFlow.mergeMethod"].enum);
  });

  it("keeps REMOTE_CONTROL_MODES equal to agentFlow.remoteControl's manifest enum", () => {
    expect([...REMOTE_CONTROL_MODES]).toEqual(props["agentFlow.remoteControl"].enum);
  });

  it("keeps AGENT_SURFACES equal to agentFlow.agentSurface's manifest enum", () => {
    expect([...AGENT_SURFACES]).toEqual(props["agentFlow.agentSurface"].enum);
  });

  it("keeps agentFlow.agentSurface's enum and enumDescriptions the same length", () => {
    expect(props["agentFlow.agentSurface"].enumDescriptions?.length).toBe(
      props["agentFlow.agentSurface"].enum?.length,
    );
  });

  it("keeps AGENT_PROVIDERS equal to agentFlow.agentProvider's manifest enum", () => {
    expect([...AGENT_PROVIDERS]).toEqual(props["agentFlow.agentProvider"].enum);
  });

  it("keeps agentFlow.agentProvider's enum and enumDescriptions the same length", () => {
    expect(props["agentFlow.agentProvider"].enumDescriptions?.length).toBe(
      props["agentFlow.agentProvider"].enum?.length,
    );
  });

  it("keeps DEFAULT_FILTER_VALUES equal to agentFlow.defaultFilter's manifest enum", () => {
    expect([...DEFAULT_FILTER_VALUES]).toEqual(props["agentFlow.defaultFilter"].enum);
  });

  it("keeps CONNECTOR_IDS equal to agentFlow.taskSource's manifest enum", () => {
    expect([...CONNECTOR_IDS]).toEqual(props["agentFlow.taskSource"].enum);
  });

  it("keeps agentFlow.taskSource's enum and enumDescriptions the same length", () => {
    expect(props["agentFlow.taskSource"].enumDescriptions?.length).toBe(
      props["agentFlow.taskSource"].enum?.length,
    );
  });

  it("keeps FORGE_IDS equal to agentFlow.forge's manifest enum", () => {
    expect([...FORGE_IDS]).toEqual(props["agentFlow.forge"].enum);
  });

  it("keeps agentFlow.forge's enum and enumDescriptions the same length", () => {
    expect(props["agentFlow.forge"].enumDescriptions?.length).toBe(
      props["agentFlow.forge"].enum?.length,
    );
  });
});

describe("events.ts ⇄ config.ts stock review mode ids", () => {
  // events.ts deliberately does not import config.ts (it must stay importable in
  // isolation — see its module doc comment), so STOCK_REVIEW_MODES is hand-
  // duplicated there instead of derived from DEFAULT_REVIEW_REQUEST_MODES.
  // Nothing else catches the two drifting apart: if a second stock mode ships,
  // an unpinned STOCK_REVIEW_MODES would still report "custom" for it. This
  // test is that pin.
  it("keeps STOCK_REVIEW_MODES equal to DEFAULT_REVIEW_REQUEST_MODES' ids", () => {
    expect([...STOCK_REVIEW_MODES]).toEqual(DEFAULT_REVIEW_REQUEST_MODES.map((m) => m.id));
  });
});

describe("settingsSnapshot — mode counts", () => {
  it("reports zeros for an untouched install", () => {
    const s = settingsSnapshot(getConfig());
    expect(s.prompt_modes_count).toBe(DEFAULT_PROMPT_MODES.length);
    expect(s.prompt_modes_overridden).toBe(0);
    expect(s.prompt_modes_custom).toBe(0);
    expect(s.prompt_modes_hidden).toBe(0);
    expect(s.review_modes_overridden).toBe(0);
    expect(s.review_modes_custom).toBe(0);
    expect(s.review_modes_hidden).toBe(0);
  });

  it("counts an overridden built-in, a custom mode and a hidden built-in", () => {
    setConfig({
      promptModes: [
        { id: "plan", prompt: "mine {key}" },
        { id: "spike", label: "Spike", prompt: "spike {key}" },
        { id: "tdd", hidden: true },
      ],
    });
    const s = settingsSnapshot(getConfig());
    expect(s.prompt_modes_overridden).toBe(1);
    expect(s.prompt_modes_custom).toBe(1);
    expect(s.prompt_modes_hidden).toBe(1);
    expect(s.prompt_modes_count).toBe(DEFAULT_PROMPT_MODES.length);
  });

  it("does not count a built-in restated verbatim as overridden", () => {
    setConfig({ promptModes: [{ ...DEFAULT_PROMPT_MODES[0] }] });
    const s = settingsSnapshot(getConfig());
    expect(s.prompt_modes_overridden).toBe(0);
    expect(s.prompt_modes_custom).toBe(0);
  });

  it("counts a detail-only override", () => {
    setConfig({ promptModes: [{ id: "plan", detail: "my own hint" }] });
    expect(settingsSnapshot(getConfig()).prompt_modes_overridden).toBe(1);
  });

  it("counts the review side independently", () => {
    setConfig({
      reviewRequestModes: [
        { id: "backend", label: "Backend", prompt: "BE {number}" },
        { id: "full", hidden: true },
      ],
    });
    const s = settingsSnapshot(getConfig());
    expect(s.review_modes_custom).toBe(1);
    expect(s.review_modes_hidden).toBe(1);
    expect(s.review_modes_overridden).toBe(0);
  });

  it("carries no label, detail or prompt text", () => {
    setConfig({ promptModes: [{ id: "spike", label: "SECRET", detail: "SECRET", prompt: "SECRET" }] });
    expect(JSON.stringify(settingsSnapshot(getConfig()))).not.toContain("SECRET");
  });
});

describe("settingsSnapshot — orchestrator", () => {
  it("carries the orchestrator setting", () => {
    expect(settingsSnapshot(getConfig()).orchestrator).toBe(false);
    setConfig({ orchestrator: true });
    expect(settingsSnapshot(getConfig()).orchestrator).toBe(true);
  });
});

describe("settingsSnapshot — childWorktrees", () => {
  it("carries the childWorktrees setting", () => {
    expect(settingsSnapshot(getConfig()).child_worktrees).toBe(true);
    setConfig({ childWorktrees: false });
    expect(settingsSnapshot(getConfig()).child_worktrees).toBe(false);
  });
});

describe("settingsSnapshot — field-count guard", () => {
  // docs/TELEMETRY.md hand-states two counts about this exact interface: the
  // total field count ("a 38-field reduction") and how many of those fields
  // can report the "invalid" sentinel ("Nine of the fields above"). Both have
  // drifted from the code silently before — caught only by a human re-reading
  // carefully, four separate times across this phase and its predecessors,
  // because nothing ever asserted either number. If EITHER assertion below
  // fails after you add, remove, or reclassify a SettingsSnapshot field, the
  // fix is TWO files: this test's expected number, AND docs/TELEMETRY.md's
  // "N-field reduction" sentence and its field-inventory table (and, if the
  // field is enum-ish, the "invalid" sentinel paragraph and its own field
  // list) — update the doc, don't just bump the number here.

  it("emits exactly 43 fields — a count also stated in docs/TELEMETRY.md's " +
    "'Settings snapshot' section; a mismatch means that doc is now wrong too", () => {
    const s = settingsSnapshot(getConfig());
    expect(Object.keys(s)).toHaveLength(43);
  });

  it("reports the \"invalid\" sentinel on exactly 11 fields when every enum-ish " +
    "setting holds an unrecognized value — docs/TELEMETRY.md's sentinel " +
    "paragraph states this same count and must move with it", () => {
    // Every config property whose SettingsSnapshot field is built with
    // enumOrInvalid (settingsSnapshot.ts), driven to a value none of their
    // allowed lists contains. task_mode/review_mode are deliberately absent:
    // they're built with modeProp, not enumOrInvalid, and can never produce
    // the literal "invalid" (see their own field's test coverage above).
    const secret = "acme-internal-not-a-real-value";
    const cfg: AgentFlowConfig = {
      ...getConfig(),
      workspaceMode: secret as unknown as AgentFlowConfig["workspaceMode"],
      openIn: secret as unknown as AgentFlowConfig["openIn"],
      reviewOpenIn: secret as unknown as AgentFlowConfig["reviewOpenIn"],
      agentProvider: secret as unknown as AgentFlowConfig["agentProvider"],
      agentSurface: secret as unknown as AgentFlowConfig["agentSurface"],
      exploreMode: secret as unknown as AgentFlowConfig["exploreMode"],
      worktree: secret as unknown as AgentFlowConfig["worktree"],
      remoteControl: secret as unknown as AgentFlowConfig["remoteControl"],
      defaultFilter: secret as unknown as AgentFlowConfig["defaultFilter"],
      taskSource: secret as unknown as AgentFlowConfig["taskSource"],
      forge: secret as unknown as AgentFlowConfig["forge"],
    };
    const s = settingsSnapshot(cfg);
    // Booleans and numbers can never equal the string "invalid", and
    // task_mode/review_mode's own sentinel is "custom" — so every hit here is
    // a genuine enumOrInvalid field, not a coincidence.
    const invalidFields = Object.entries(s).filter(([, v]) => v === "invalid").map(([k]) => k);
    expect(invalidFields.sort()).toEqual([
      "agent_provider", "agent_surface", "default_filter", "explore_mode", "forge",
      "open_in", "remote_control", "review_open_in", "task_source", "workspace_mode", "worktree",
    ]);
  });
});

describe("settingsSnapshot — commands", () => {
  // The sentinel lives in the id and the label too, not only in `run`: a
  // mutation that added `command_ids: cfg.commands.map(c => c.id)` or the
  // labels to the snapshot would still pass a test that only ever put
  // "acme-internal" inside the run text.
  it("counts configured commands without revealing their id, label or run text", () => {
    setConfig({
      commands: [
        { id: "acme-internal-deploy", label: "acme-internal Deploy", run: "gh workflow run deploy.yml --repo acme-internal/billing" },
        { id: "smoke", label: "Smoke test", run: "curl https://acme-internal.example/health" },
      ],
    });
    const s = settingsSnapshot(getConfig());
    expect(s.commands_count).toBe(2);
    expect(JSON.stringify(s)).not.toContain("acme-internal");
  });
});
