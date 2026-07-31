import { describe, expect, it } from "vitest";
import { AgentFlowConfig, getConfig } from "../../../src/config";
import { settingsSnapshot } from "../../../src/telemetry/settingsSnapshot";

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
  });

  it("collapses a user-authored taskMode id to 'custom'", () => {
    const cfg = { ...getConfig(), taskMode: "acme-billing-hotfix" };
    expect(settingsSnapshot(cfg).task_mode).toBe("custom");
  });

  it("reports a shipped taskMode id as 'stock'", () => {
    const cfg = { ...getConfig(), taskMode: "tdd" };
    expect(settingsSnapshot(cfg).task_mode).toBe("stock");
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

  it("collapses a hand-edited defaultFilter/exploreMode holding a plausible secret to a safe fallback", () => {
    const secret = "acme-internal-BILL-1234";
    const cfg = { ...getConfig(), defaultFilter: secret, exploreMode: secret };
    const s = settingsSnapshot(cfg);
    expect(s.default_filter).toBe("mysprint");
    expect(s.explore_mode).toBe("ask");
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("acme");
    expect(serialized).not.toContain("BILL");
  });

  it("collapses a hand-edited value for every other enum-ish field to a safe fallback", () => {
    const secret = "acme-internal-BILL-5678" as AgentFlowConfig["workspaceMode"];
    const cfg: AgentFlowConfig = {
      ...getConfig(),
      workspaceMode: secret,
      openIn: secret as unknown as AgentFlowConfig["openIn"],
      worktree: secret as unknown as AgentFlowConfig["worktree"],
      remoteControl: secret as unknown as AgentFlowConfig["remoteControl"],
    };
    const s = settingsSnapshot(cfg);
    expect(s.workspace_mode).toBe("auto");
    expect(s.open_in).toBe("ask");
    expect(s.worktree).toBe("ask");
    expect(s.remote_control).toBe("off");
    expect(JSON.stringify(s)).not.toContain("acme-internal-BILL-5678");
  });
});
