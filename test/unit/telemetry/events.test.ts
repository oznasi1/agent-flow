import { describe, expect, it } from "vitest";
import {
  AnalyticsEvent, OPEN_STRING_PROPS, STOCK_PROMPT_MODES, toPromptModeProp,
} from "../../../src/telemetry/events";

/** One representative literal per Phase 1 event. Every event name must appear here;
 * the count assertion below is what forces a new event to be added to this list. */
const SAMPLES: AnalyticsEvent[] = [
  { name: "extension_installed" },
  {
    name: "extension_activated", is_first_ever: true, has_jira_auth: false, is_configured: true,
    workspace_mode: "auto", open_in: "ask", explore_mode: "ask", worktree: "ask",
    remote_control: "off", default_filter: "mysprint", task_mode: "ask",
    seed_agent: true, filters_size: true, filters_status: true, filters_repo: true,
    filters_search: true, pr_review_auto_fix: true, pr_facts: true, review_requests: true,
    review_writes: false, stamp_label_on_write: true, track_open_windows: true,
    batch_confirm_threshold: 6, repo_blocklist_count: 0,
    prompt_modes_count: 6, prompt_modes_customized: false,
    explore_prompts_customized: false, pr_review_prompt_customized: false,
  },
  { name: "command_invoked", command: "openDeck" },
  { name: "take_started", flow_id: "f1", source: "card", task_fp: "0123456789abcdef", inferred_count: 2 },
  { name: "take_prompt_mode_picked", flow_id: "f1", prompt_mode: "tdd", is_custom_mode: false },
  { name: "take_destination_picked", flow_id: "f1", destination: "new", workspace_mode: "multiroot", used_worktree: false },
  { name: "take_repos_picked", flow_id: "f1", repo_count: 3, repo_source: "quickpick", accepted_inference: true, inferred_count: 2 },
  { name: "take_completed", flow_id: "f1", outcome: "launched", destination: "new", prompt_mode: "tdd", repo_count: 3, duration_ms: 4200, task_fp: "0123456789abcdef" },
  { name: "operation_failed", op: "git_worktree", failure_class: "conflict", retryable: false },
  { name: "unhandled_error", error_class: "TypeError", stack_digest: "at f (dist/extension.js:1:2)" },
];

describe("the event catalog", () => {
  it("covers every Phase 1 event exactly once", () => {
    const names = SAMPLES.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(10);
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
        if (OPEN_STRING_PROPS.includes(key)) continue;
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
