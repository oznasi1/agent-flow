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

  it("never returns the salt itself", () => {
    const mem = vscode.makeMemento();
    const id = createIdentity(mem as never);
    const salt = String(mem._store[SALT_KEY]);
    expect(id.fingerprint("ABC-123")).not.toContain(salt.slice(0, 8));
  });
});
