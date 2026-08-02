import { describe, expect, it } from "vitest";
import { AgentFlowConfig, getConfig } from "../../../src/config";
import {
  DEFAULT_FILTER_VALUES, EXPLORE_MODES, OPEN_IN_MODES, REMOTE_CONTROL_MODES,
  settingsSnapshot, WORKSPACE_MODES, WORKTREE_MODES,
} from "../../../src/telemetry/settingsSnapshot";
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
    expect(s.prompt_modes_customized).toBe(false);
    expect(s.explore_prompts_customized).toBe(false);
    expect(s.pr_review_prompt_customized).toBe(false);
    expect(s.review_writes).toBe(false);
    expect(s.repo_blocklist_count).toBe(0);
    expect(s.review_mode).toBe("ask");
    expect(s.review_modes_count).toBe(1);
    expect(s.review_modes_customized).toBe(false);
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

  it("flags customized review modes without revealing them", () => {
    const cfg = {
      ...getConfig(),
      reviewRequestModes: [
        { id: "acme-backend", label: "Backend services", detail: "D", prompt: "P" },
        { id: "acme-frontend", label: "Frontend", detail: "D", prompt: "P" },
      ],
    };
    const s = settingsSnapshot(cfg);
    expect(s.review_modes_customized).toBe(true);
    expect(s.review_modes_count).toBe(2);
    expect(JSON.stringify(s)).not.toContain("acme-");
  });

  it("flags customized prompt modes without revealing them", () => {
    const cfg = { ...getConfig(), promptModes: [{ id: "mine", label: "L", detail: "D", prompt: "P" }] };
    const s = settingsSnapshot(cfg);
    expect(s.prompt_modes_customized).toBe(true);
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
    };
    const serialized = JSON.stringify(settingsSnapshot(cfg));
    for (const leak of ["acme", "BILL", "someone", "secret-repo", "atlassian"]) {
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
});

describe("package.json ⇄ settingsSnapshot enum whitelists", () => {
  // settingsSnapshot.ts hand-duplicates each setting's manifest `enum` so it can
  // validate a config value without importing package.json into the extension's
  // runtime bundle. Nothing else catches these two lists drifting apart — a new
  // manifest option added and forgotten here would silently collapse to
  // "invalid" forever. Same pattern as config.test.ts's DEFAULT_PROMPT_MODES /
  // DEFAULT_PR_REVIEW_PROMPT parity tests.
  const props = pkg.contributes.configuration.properties as Record<string, { enum?: string[] }>;

  it("keeps WORKSPACE_MODES equal to agentFlow.workspaceMode's manifest enum", () => {
    expect([...WORKSPACE_MODES]).toEqual(props["agentFlow.workspaceMode"].enum);
  });

  it("keeps OPEN_IN_MODES equal to agentFlow.openIn's manifest enum", () => {
    expect([...OPEN_IN_MODES]).toEqual(props["agentFlow.openIn"].enum);
  });

  it("keeps EXPLORE_MODES equal to agentFlow.exploreMode's manifest enum", () => {
    expect([...EXPLORE_MODES]).toEqual(props["agentFlow.exploreMode"].enum);
  });

  it("keeps WORKTREE_MODES equal to agentFlow.worktree's manifest enum", () => {
    expect([...WORKTREE_MODES]).toEqual(props["agentFlow.worktree"].enum);
  });

  it("keeps REMOTE_CONTROL_MODES equal to agentFlow.remoteControl's manifest enum", () => {
    expect([...REMOTE_CONTROL_MODES]).toEqual(props["agentFlow.remoteControl"].enum);
  });

  it("keeps DEFAULT_FILTER_VALUES equal to agentFlow.defaultFilter's manifest enum", () => {
    expect([...DEFAULT_FILTER_VALUES]).toEqual(props["agentFlow.defaultFilter"].enum);
  });
});
