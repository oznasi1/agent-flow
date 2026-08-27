import { describe, it, expect } from "vitest";
import { mostActive, promoteExited } from "../../../src/engine/activity";
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

  it("promotes a blocked reading whose process is gone — a dead session is not awaiting approval", () => {
    expect(promoteExited(act({ state: "blocked", midWork: true }), 0).state).toBe("exited");
  });
});

describe("STATE_RANK via mostActive", () => {
  // A run holds several sessions and the card shows ONE reading. `blocked` must
  // win: a session frozen at a permission prompt cannot make progress at all,
  // and letting a session that politely ended its turn bury it is the same bug
  // the needs-you-over-working rung was written to fix.
  it("prefers blocked over needs-you", () => {
    expect(mostActive([act({ state: "needs-you" }), act({ state: "blocked" })]).state).toBe("blocked");
  });

  it("prefers blocked over every other state", () => {
    for (const loser of ["stalled", "exited", "working", "idle", "unknown"] as const) {
      expect(mostActive([act({ state: loser }), act({ state: "blocked" })]).state).toBe("blocked");
    }
  });

  it("breaks a blocked-vs-blocked tie on the most recent activity", () => {
    const out = mostActive([
      act({ state: "blocked", lastActivityMs: 100 }),
      act({ state: "blocked", lastActivityMs: 900 }),
    ]);
    expect(out.lastActivityMs).toBe(900);
  });
});
