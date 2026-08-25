import { describe, it, expect } from "vitest";
import { promoteExited } from "../../../src/engine/activity";
import { AgentActivity } from "../../../src/types";

const act = (over: Partial<AgentActivity> = {}): AgentActivity => ({
  state: "idle", lastActivityMs: 1, slug: null, ...over,
});

describe("promoteExited", () => {
  it("promotes a mid-work transcript with no live session to exited", () => {
    // The one thing a per-file reducer cannot know: nobody is running, and the
    // transcript stops owing work. That agent died holding it.
    expect(promoteExited(act({ midWork: true }), 0).state).toBe("exited");
  });

  it("leaves a working reading alone — a pending tool call moments ago is alive, not dead", () => {
    expect(promoteExited(act({ state: "working", midWork: true }), 0).state).toBe("working");
  });

  it("leaves a mid-work reading alone while a session is still open", () => {
    expect(promoteExited(act({ midWork: true }), 1).state).toBe("idle");
  });

  it("leaves a transcript that finished its turn alone", () => {
    expect(promoteExited(act(), 0).state).toBe("idle");
  });

  it("preserves every other field, so the caller's activity is not rebuilt", () => {
    const out = promoteExited(act({ midWork: true, slug: "fix-ci", lastActivityMs: 42 }), 0);
    expect(out).toEqual({ state: "exited", lastActivityMs: 42, slug: "fix-ci", midWork: true });
  });
});
