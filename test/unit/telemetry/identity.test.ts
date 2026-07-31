import { describe, expect, it } from "vitest";
import * as vscode from "../../_mocks/vscode";
import { createIdentity, SALT_KEY } from "../../../src/telemetry/identity";

describe("createIdentity", () => {
  it("borrows distinct_id and session_id from vscode.env", () => {
    const id = createIdentity(vscode.makeMemento() as never);
    expect(id.distinctId).toBe("test-machine-id");
    expect(id.sessionId).toBe("test-session-id");
  });

  it("generates a salt once and reuses it across calls", () => {
    const mem = vscode.makeMemento();
    createIdentity(mem as never);
    const salt = mem._store[SALT_KEY];
    expect(typeof salt).toBe("string");
    createIdentity(mem as never);
    expect(mem._store[SALT_KEY]).toBe(salt);
  });

  it("fingerprints to 16 lowercase hex chars, stably", () => {
    const id = createIdentity(vscode.makeMemento() as never);
    const a = id.fingerprint("ABC-123");
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(id.fingerprint("ABC-123")).toBe(a);
  });

  it("gives different fingerprints for the same value under different salts", () => {
    const a = createIdentity(vscode.makeMemento() as never).fingerprint("ABC-123");
    const b = createIdentity(vscode.makeMemento() as never).fingerprint("ABC-123");
    expect(a).not.toBe(b);
  });

  it("never exposes the salt in the returned object's shape", () => {
    const mem = vscode.makeMemento();
    const id = createIdentity(mem as never);
    const salt = String(mem._store[SALT_KEY]);

    // Check that enumerable keys only contain expected properties
    const keys = Object.keys(id);
    expect(keys.sort()).toEqual(["distinctId", "fingerprint", "sessionId"].sort());

    // Verify salt doesn't appear in JSON serialization
    const serialized = JSON.stringify(id);
    expect(serialized).not.toContain(salt.slice(0, 8));

    // Verify the salt value itself doesn't appear in the object
    expect(id.distinctId).not.toContain(salt.slice(0, 8));
    expect(id.sessionId).not.toContain(salt.slice(0, 8));
    expect(id.fingerprint("test")).not.toContain(salt.slice(0, 8));
  });

  it("falls back to in-memory salt if state.update throws synchronously", () => {
    const mem = vscode.makeMemento();
    // Mock state.update to throw synchronously
    (mem.update as any) = () => {
      throw new Error("Store write failed");
    };

    // Should not throw, should return a valid Identity
    const id = createIdentity(mem as never);
    expect(id.distinctId).toBe("test-machine-id");
    expect(id.sessionId).toBe("test-session-id");

    // Fingerprint should still be valid 16-char hex
    const fp = id.fingerprint("ABC-123");
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(id.fingerprint("ABC-123")).toBe(fp);
  });
});
