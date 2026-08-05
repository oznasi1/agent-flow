import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  TaskApiError, TaskAuthError, TaskWriteError,
  isTaskNetworkError, markTaskNetworkFailure, serializeCaps,
} from "../../../src/tasks/provider";
import type { TaskConnector } from "../../../src/tasks/provider";
import type { AuthProbe, ProjectProbe } from "../../../src/engine/doctor";

describe("task errors", () => {
  it("carries a minification-proof name on every class", () => {
    expect(new TaskAuthError("x").name).toBe("TaskAuthError");
    expect(new TaskApiError(404, "x", {}, []).name).toBe("TaskApiError");
    expect(new TaskWriteError("x").name).toBe("TaskWriteError");
  });

  // The assertion above only proves the *value* is right today; it can't tell
  // `this.name = "TaskAuthError"` (survives minification) apart from
  // `this.name = this.constructor.name` (does not — esbuild.js runs with
  // minify:true and no keepNames, so the class identifier is renamed in the
  // real build, and vitest doesn't minify so both forms pass the test above
  // identically). Read the source instead, the way test/unit/compat.test.ts
  // pins values with no observable runtime surface (its SPRINT_ORDER_KEY and
  // telemetry wire-value checks).
  it("assigns .name from a quoted string literal, not the class identifier", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../../src/tasks/provider.ts"), "utf8");
    expect(src).toContain('this.name = "TaskAuthError"');
    expect(src).toContain('this.name = "TaskApiError"');
    expect(src).toContain('this.name = "TaskWriteError"');
  });

  it("defaults TaskWriteError.retryWith to empty", () => {
    expect(new TaskWriteError("x").retryWith).toEqual([]);
    const w = new TaskWriteError("x", [{ kind: "text", id: "f", name: "F" }]);
    expect(w.retryWith).toHaveLength(1);
  });

  it("recognises only its own network markers", () => {
    expect(isTaskNetworkError(markTaskNetworkFailure(new Error("x"), "ETIMEDOUT"))).toBe(true);
    expect(isTaskNetworkError(new Error("x"))).toBe(false);
    expect(isTaskNetworkError(null)).toBe(false);
    expect(isTaskNetworkError("nope")).toBe(false);
  });

  it("preserves the code field classifyFailure reads", () => {
    const e = markTaskNetworkFailure(new Error("x"), "ENOTFOUND") as Error & { code?: string };
    expect(e.code).toBe("ENOTFOUND");
  });
});

describe("serializeCaps", () => {
  it("flattens capability objects to booleans for the webview", () => {
    expect(serializeCaps({ supportedFilters: ["mine"], sizes: false })).toEqual({
      supportedFilters: ["mine"], sizes: false, labels: false, sprints: false, components: false,
    });
  });

  it("reports a present capability as true", () => {
    const caps = {
      supportedFilters: ["all"] as const,
      sizes: true,
      labels: { add: async () => undefined },
    };
    expect(serializeCaps(caps).labels).toBe(true);
  });
});

describe("TaskConnector.probe() contract", () => {
  // A one-directional assertion here ("this concrete value satisfies the
  // signature") is vacuous: any concrete type is assignable to a widened
  // `{ auth?: unknown; scope?: unknown }` target, so it cannot fail even if
  // `probe()` regresses to that. `Exact` demands *mutual* assignability —
  // real type === expected type, not just real type ⊆ expected type — which
  // is asymmetric exactly where `unknown` would break it: `unknown` is not
  // assignable to `AuthProbe`, so a loosened signature fails the reverse leg
  // and `Exact<..., ...>` collapses to `false`, which then fails to satisfy
  // the `true`-typed binding below at compile time (verified by mutation —
  // see task-2-report.md for the transcript reverting provider.ts and
  // re-running `npm run typecheck`).
  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  type ProbeResult = Awaited<ReturnType<TaskConnector["probe"]>>;
  type ExpectedProbeResult = { auth?: AuthProbe; scope?: ProjectProbe };

  it("pins probe()'s return type to the real AuthProbe/ProjectProbe shapes", () => {
    // If ProbeResult ever widens (e.g. back to `{ auth?: unknown; scope?: unknown }`),
    // Exact<...> becomes `false` and this line fails `npm run typecheck` with
    // "Type 'true' is not assignable to type 'false'".
    const shapeIsExact: Exact<ProbeResult, ExpectedProbeResult> = true;
    expect(shapeIsExact).toBe(true);
  });

  it("accepts every ok/not-ok variant of AuthProbe and ProjectProbe", async () => {
    const authOk: AuthProbe = { ok: true, displayName: "Ada" };
    const authFail: AuthProbe = { ok: false, reason: "auth", message: "no credentials" };
    const scopeOk: ProjectProbe = { ok: true, name: "ABC" };
    const scopeFail: ProjectProbe = { ok: false, reason: "not-found", message: "no such project" };

    const bothOk: TaskConnector["probe"] = async () => ({ auth: authOk, scope: scopeOk });
    const bothFail: TaskConnector["probe"] = async () => ({ auth: authFail, scope: scopeFail });
    // `undefined` on either member is the "deliberately not run" case Doctor renders as `skip`.
    const neitherRun: TaskConnector["probe"] = async () => ({});

    expect(await bothOk()).toEqual({ auth: authOk, scope: scopeOk });
    expect(await bothFail()).toEqual({ auth: authFail, scope: scopeFail });
    expect(await neitherRun()).toEqual({});
  });
});
