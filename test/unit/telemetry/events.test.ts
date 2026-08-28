import { describe, expect, it } from "vitest";
import {
  AnalyticsEvent, EventName, OPEN_STRING_PROPS, STOCK_EXPLORE_MODES, STOCK_PROMPT_MODES, classifyFailure,
  toExploreModeProp, toPromptModeProp,
} from "../../../src/telemetry/events";
// The REAL class, not a local stand-in — classifyFailure relies on its constructor
// setting `this.name` explicitly (src/tasks/jira/client.ts), and a hand-rolled stand-in
// declared locally in this file would keep passing even if that constructor
// override were ever accidentally reverted. Safe to import here (unlike from
// telemetry/events.ts itself): this test file, unlike that production module, is
// allowed to depend on jira/client.ts's transitive `vscode` import, which
// vitest.config.ts already aliases to test/_mocks/vscode.ts for every test file.
import { JiraAuthError } from "../../../src/tasks/jira/client";

/** One representative literal per Phase 1 event. The `Unsampled`/`AssertNever`
 * check below (after this array) is what actually forces a new event to be added
 * here — it fails to compile the moment `AnalyticsEvent` grows a variant with no
 * matching sample. `toHaveLength(10)` a few lines down is a plain regression
 * check on the current count, nothing more; it does not by itself catch an
 * unsampled event, since a `SAMPLES: AnalyticsEvent[]` array with fewer entries
 * than the union still type-checks. */
const SAMPLES = [
  { name: "extension_installed" },
  {
    name: "extension_activated", is_first_ever: true, has_jira_auth: false, is_configured: true,
    workspace_mode: "auto", open_in: "ask", review_open_in: "new-window", agent_provider: "claude-code", agent_surface: "extension", explore_mode: "ask", task_source: "jira", forge: "github", worktree: "ask",
    remote_control: "off", default_filter: "mysprint", task_mode: "ask",
    seed_agent: true, filters_size: true, filters_status: true, filters_repo: true,
    filters_search: true, pr_review_auto_fix: true, pr_facts: true, review_requests: true,
    open_agents: true, review_writes: false, merge_writes: false, merge_method: "squash", orchestrator: false, child_worktrees: false, stamp_label_on_write: true, track_open_windows: true,
    batch_confirm_threshold: 6, repo_blocklist_count: 0, commands_count: 0,
    prompt_modes_count: 6, prompt_modes_overridden: 0, prompt_modes_custom: 0, prompt_modes_hidden: 0,
    explore_prompts_customized: false, environments_customized: false,
    pr_review_prompt_customized: false,
    review_mode: "ask", review_modes_count: 1,
    review_modes_overridden: 0, review_modes_custom: 0, review_modes_hidden: 0,
  },
  { name: "command_invoked", command: "openDeck" },
  { name: "take_started", flow_id: "f1", source: "card", task_fp: "0123456789abcdef" },
  { name: "take_prompt_mode_picked", flow_id: "f1", prompt_mode: "tdd", is_custom_mode: false },
  { name: "take_destination_picked", flow_id: "f1", destination: "new", workspace_mode: "multiroot" },
  { name: "take_repos_picked", flow_id: "f1", repo_count: 3, repo_source: "quickpick", accepted_inference: true, inferred_count: 2 },
  { name: "take_completed", flow_id: "f1", outcome: "launched", destination: "new", prompt_mode: "tdd", repo_count: 3, duration_ms: 4200, used_worktree: true, task_fp: "0123456789abcdef" },
  { name: "batch_started", flow_id: "f1", keys_count: 4, is_fanout: false, tree_mode: "fanout" },
  { name: "batch_completed", flow_id: "f1", outcome: "launched", attempted: 4, launched: 3, failed: 1, prompt_mode: "plan", destination: "new", layout: "separate", layout_asked: true, duration_ms: 900 },
  { name: "operation_failed", op: "git_worktree", failure_class: "conflict", retryable: false },
  { name: "unhandled_error", error_class: "TypeError", stack_digest: "at f (dist/extension.js:1:2)" },
  { name: "deck_opened", revealed: false, forge: "github", pr_facts: true, open_agents: true, review_queue: true, orchestrator: false, flow_count: 0, has_armed_flow: false },
  { name: "deck_action", action: "set_grouping", grouping: "workspaces" },
  { name: "review_launched", outcome: "launched", mode: "stock", mode_was_pinned: true, destination: "new", provider: "claude-code", seeded_in_place: false, batch: false, requested_count: 1, launched_count: 1, failed_count: 0, skipped_count: 0 },
  { name: "review_submitted", verb: "approve", from_draft: true, outcome: "ok" },
  { name: "pr_merged", outcome: "refused", refusal: "writes-off" },
  { name: "pr_work_seeded", reason: "review", source: "deck", outcome: "seeded", window_count: 1, failed_repo_count: 0, agent_seeded: true },
  { name: "explore_started", flow_id: "f1", mode: "debug", source: "command" },
  { name: "explore_completed", flow_id: "f1", outcome: "cancelled", mode: "debug", cancel_point: "topic", repo_count: 2, duration_ms: 30 },
  { name: "flow_action", action: "dry_run", edge_count: 3, fired_count: 1, blocked_count: 0 },
  { name: "flow_armed", armed: true, node_count: 4, edge_count: 3, unfirable_live: 0, unfirable_pr_facts: 1, unfirable_forge: 0, source: "toggle" },
  { name: "flow_edge_fired", edge_action: "launch", ok: true, deferred: false, dest: "worktree", prompt_mode: "implementation", repo_count: 1 },
  { name: "flow_settled", node_count: 4, edge_count: 3 },
  { name: "marketplace_opened", revealed: false, asset_count: 7, plugin_count: 2, marketplace_count: 1, skills: 3, commands: 2, agents: 1, hooks: 1, not_set_up: false },
  { name: "marketplace_action", action: "read", truncated: true },
  { name: "tasks_fetched", filter: "sprint", lens: "mysprint", size: "any", task_count: 12, repo_count: 3, live_window_count: 2, authed: true },
  { name: "lens_used", lens: "search" },
  { name: "card_action", action: "change_status" },
  { name: "notepad_action", action: "run" },
  { name: "setup_started", source: "offer", connector_steps: 2 },
  { name: "setup_completed", outcome: "signin-skipped", signed_in: false },
  { name: "doctor_run", fails: 1, warns: 2, outcome: "action", action_kind: "command" },
] satisfies AnalyticsEvent[];

/** `Unsampled` is every EventName with no entry in SAMPLES above. `AssertNever`
 * only accepts `never`, so `_AllEventsSampled` fails to compile — "Type '...' does
 * not satisfy the constraint 'never'" — the moment AnalyticsEvent grows a variant
 * that isn't sampled. (A tempting-looking alternative, `const x: Unsampled[] = []`,
 * does NOT work: an empty array literal is vacuously assignable to any array type,
 * sampled or not, so it silently passes even when Unsampled is non-empty — verified
 * empirically before choosing this form.) `SAMPLES` is declared with `satisfies`,
 * not a `: AnalyticsEvent[]` annotation, specifically so `(typeof SAMPLES)[number]`
 * keeps each entry's literal `name`, rather than collapsing to the union. */
type Unsampled = Exclude<EventName, (typeof SAMPLES)[number]["name"]>;
type AssertNever<T extends never> = T;
type _AllEventsSampled = AssertNever<Unsampled>;

describe("the event catalog", () => {
  it("covers every Phase 1 event exactly once", () => {
    const names = SAMPLES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(33);
  });

  it("carries no free-form strings outside the allow-list", () => {
    // Enum members are alphanumeric plus `.` `_` `-` (CommandId mirrors VS Code's
    // camelCase command ids, e.g. "openDeck", so uppercase is allowed) — no spaces,
    // no slashes, none of the punctuation free text tends to carry.
    const ENUMISH = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
    for (const ev of SAMPLES) {
      for (const [key, value] of Object.entries(ev)) {
        if (typeof value !== "string") continue;
        if (key === "name") continue;
        if ((OPEN_STRING_PROPS as readonly string[]).includes(key)) continue;
        if (/_fp$/.test(key)) {
          expect(value, `${ev.name}.${key}`).toMatch(/^[0-9a-f]{16}$/);
          continue;
        }
        expect(value, `${ev.name}.${key} must be an enum member, not free text`).toMatch(ENUMISH);
        expect(value, `${ev.name}.${key} looks like a path`).not.toMatch(/[/\\]/);
      }
    }
  });

  it("allow-lists only the three opaque string properties", () => {
    expect([...OPEN_STRING_PROPS].sort()).toEqual(["error_class", "flow_id", "stack_digest"].sort());
  });
});

describe("toPromptModeProp", () => {
  it("passes the six shipped ids through", () => {
    for (const id of STOCK_PROMPT_MODES) expect(toPromptModeProp(id)).toBe(id);
  });

  it("collapses a user-authored id to 'custom'", () => {
    expect(toPromptModeProp("acme-billing-hotfix")).toBe("custom");
  });
});

describe("toExploreModeProp", () => {
  it("passes the six shipped ids through", () => {
    for (const id of STOCK_EXPLORE_MODES) expect(toExploreModeProp(id)).toBe(id);
  });

  it("collapses 'ask' and any other unrecognised id to 'custom'", () => {
    expect(toExploreModeProp("ask")).toBe("custom");
    expect(toExploreModeProp("acme-billing-hotfix")).toBe("custom");
  });
});

describe("classifyFailure", () => {
  it("classifies the real JiraAuthError as auth", () => {
    const e = new JiraAuthError("token expired");
    // Sanity: this is what classifyFailure actually depends on. JiraAuthError's
    // constructor sets `this.name` explicitly for exactly this reason — a bare
    // `class X extends Error {}` would leave `.name` as the inherited "Error",
    // and relying on the class identifier instead would not survive esbuild's
    // production minify (no keepNames), which renames it. Both were verified
    // empirically; see the fix report in task-10-report.md for the minified-
    // bundle check, which a stand-in class declared in this test file could
    // never catch.
    expect(e.name).toBe("JiraAuthError");
    expect(classifyFailure(e)).toBe("auth");
  });

  it("classifies both the task and jira auth error names as auth", () => {
    // Real Error objects, like the AbortError case above — classifyFailure only
    // reads `.name` off an `instanceof Error` (see its own doc comment), so a
    // plain `{ name: "TaskAuthError" }` object literal would never reach that
    // branch regardless of the string comparison being tested here.
    const taskAuth = new Error("token expired");
    taskAuth.name = "TaskAuthError";
    const jiraAuth = new Error("token expired");
    jiraAuth.name = "JiraAuthError";
    expect(classifyFailure(taskAuth)).toBe("auth");
    expect(classifyFailure(jiraAuth)).toBe("auth");
  });

  it("classifies auth by numeric 401/403 status (JiraApiError shape)", () => {
    expect(classifyFailure({ status: 401 })).toBe("auth");
    expect(classifyFailure({ status: 403 })).toBe("auth");
  });

  it("classifies not_found by numeric 404 status", () => {
    expect(classifyFailure({ status: 404 })).toBe("not_found");
  });

  it("ignores other statuses", () => {
    expect(classifyFailure({ status: 500 })).toBe("unknown");
  });

  it("classifies timeout by AbortError name or ETIMEDOUT code", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyFailure(abort)).toBe("timeout");
    expect(classifyFailure({ code: "ETIMEDOUT" })).toBe("timeout");
  });

  it("classifies network by ENOTFOUND / ECONNREFUSED / ENETUNREACH codes", () => {
    expect(classifyFailure({ code: "ENOTFOUND" })).toBe("network");
    expect(classifyFailure({ code: "ECONNREFUSED" })).toBe("network");
    expect(classifyFailure({ code: "ENETUNREACH" })).toBe("network");
  });

  it("classifies not_found by ENOENT code", () => {
    expect(classifyFailure({ code: "ENOENT" })).toBe("not_found");
  });

  it("classifies permission by EACCES / EPERM codes", () => {
    expect(classifyFailure({ code: "EACCES" })).toBe("permission");
    expect(classifyFailure({ code: "EPERM" })).toBe("permission");
  });

  it("classifies parse by SyntaxError name", () => {
    expect(classifyFailure(new SyntaxError("unexpected token"))).toBe("parse");
  });

  it("falls back to unknown for an unrecognised error", () => {
    expect(classifyFailure(new Error("plain failure"))).toBe("unknown");
  });

  it("falls back to unknown for a non-Error thrown value, without throwing", () => {
    expect(classifyFailure("a string")).toBe("unknown");
    expect(classifyFailure(null)).toBe("unknown");
    expect(classifyFailure(undefined)).toBe("unknown");
  });

  it("never reads the message — a message that looks like a 401 doesn't trigger 'auth'", () => {
    expect(classifyFailure(new Error("401 Unauthorized"))).toBe("unknown");
  });
});

describe("compile-time guard", () => {
  it("rejects a user string added to an event", () => {
    // This test's real assertion is the `@ts-expect-error` directive below, which
    // only bites under `tsc --noEmit` — vitest transpiles with esbuild and does not
    // type-check, so the runtime `expect` below is incidental. If a property is ever
    // widened so this literal type-checks, `tsc` reports "Unused '@ts-expect-error'
    // directive" and the build fails. Do not "simplify" this away.
    // @ts-expect-error `repo` is not a property of take_completed, and no event accepts a repo name.
    const bad: AnalyticsEvent = { name: "take_completed", flow_id: "f1", outcome: "launched", prompt_mode: "tdd", repo_count: 1, duration_ms: 1, task_fp: "0123456789abcdef", repo: "acme-billing" };
    expect(bad).toBeTruthy();
  });
});
