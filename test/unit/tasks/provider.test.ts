import { describe, expect, it } from "vitest";
import {
  TaskApiError, TaskAuthError, TaskWriteError,
  isTaskNetworkError, markTaskNetworkFailure, serializeCaps,
} from "../../../src/tasks/provider";

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
