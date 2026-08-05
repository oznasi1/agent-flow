import { describe, expect, it } from "vitest";
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
  // Compile-time assertion as much as a runtime one: if `probe()`'s return type
  // ever drifts back to `unknown`, or engine/doctor.ts's AuthProbe/ProjectProbe
  // shapes change underneath it, these literals stop satisfying `TaskConnector["probe"]`
  // and this file fails to typecheck.
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
