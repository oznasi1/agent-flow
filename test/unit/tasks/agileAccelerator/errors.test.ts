import { describe, expect, it } from "vitest";
import { classifySfFailure, SfApiError, statusForCode } from "../../../../src/tasks/agileAccelerator/errors";
import { TaskAuthError } from "../../../../src/tasks/provider";

describe("classifySfFailure", () => {
  it("maps a session error to TaskAuthError so views show the sign-in gate", () => {
    const raw = JSON.stringify({ status: 1, name: "INVALID_SESSION_ID", message: "Session expired" });
    const e = classifySfFailure(raw, "sf failed");
    expect(e).toBeInstanceOf(TaskAuthError);
    expect(e.message).toContain("Session expired");
  });

  it("maps a missing default org to TaskAuthError, not an API error", () => {
    const raw = JSON.stringify({ status: 1, name: "NoDefaultEnvError", message: "No default environment" });
    expect(classifySfFailure(raw, "x")).toBeInstanceOf(TaskAuthError);
  });

  it("keeps the Salesforce error code reachable on an API error", () => {
    const raw = JSON.stringify({ status: 1, name: "INVALID_FIELD", message: "No such column 'Nope__c'" });
    const e = classifySfFailure(raw, "x");
    expect(e).toBeInstanceOf(SfApiError);
    expect((e as SfApiError).messages).toContain("No such column 'Nope__c'");
    expect((e as SfApiError).status).toBe(400);
  });

  it("survives output that is not JSON at all", () => {
    const e = classifySfFailure("command not found: sf", "sf exited 127");
    expect(e).toBeInstanceOf(SfApiError);
    expect(e.message).toBe("sf exited 127");
  });

  it("sets a stable name literal, because esbuild minifies class identifiers", () => {
    const e = classifySfFailure(JSON.stringify({ name: "INVALID_FIELD", message: "m" }), "x");
    expect(e.name).toBe("SfApiError");
  });
});

describe("statusForCode", () => {
  it("maps not-found, rate limits, and invalid-input families", () => {
    expect(statusForCode("NOT_FOUND")).toBe(404);
    expect(statusForCode("REQUEST_LIMIT_EXCEEDED")).toBe(429);
    expect(statusForCode("INVALID_FIELD")).toBe(400);
  });

  it("returns 0 for a code with no transport meaning, since sf has no HTTP status", () => {
    expect(statusForCode("SomethingNovel")).toBe(0);
  });
});
