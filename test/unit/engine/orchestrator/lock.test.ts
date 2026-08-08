import { describe, it, expect } from "vitest";
import { acquire, release, lockPath, LockIo, LOCK_TTL_MS } from "../../../../src/engine/orchestrator/lock";

const NOW = 1_800_000_000_000;
const DIR = "/store/flows";

/** An in-memory LockIo with a genuinely exclusive create. */
const fakeIo = (files: Record<string, string> = {}) => {
  const io: LockIo = {
    tryCreate: (p, text) => {
      if (p in files) return false;
      files[p] = text;
      return true;
    },
    read: (p) => files[p] ?? null,
    remove: (p) => { delete files[p]; },
  };
  return { io, files };
};

describe("lockPath", () => {
  it("sits inside the flows directory", () => {
    expect(lockPath(DIR)).toContain(DIR);
  });
});

describe("acquire", () => {
  it("succeeds when no lock exists, and writes one", () => {
    const { io, files } = fakeIo();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a")).toBe(true);
    expect(files[lockPath(DIR)]).toBeTruthy();
  });

  it("fails when another holder has a fresh lock", () => {
    const { io } = fakeIo();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a")).toBe(true);
    // A second window, one millisecond later.
    expect(acquire(io, DIR, NOW + 1, LOCK_TTL_MS, "win-b")).toBe(false);
  });

  it("reaps a lock past the TTL, and the next attempt gets in", () => {
    // A stale lock is deleted and the attempt fails. The next poll's plain create
    // then succeeds. This prevents two windows from both acquiring the same stale lock.
    const { io, files } = fakeIo();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a")).toBe(true);
    expect(acquire(io, DIR, NOW + LOCK_TTL_MS + 1, LOCK_TTL_MS, "win-b")).toBe(false);
    // Stale lock has been reaped (deleted).
    expect(files[lockPath(DIR)]).toBeUndefined();
    // Next attempt succeeds because the path is now empty.
    expect(acquire(io, DIR, NOW + LOCK_TTL_MS + 1, LOCK_TTL_MS, "win-b")).toBe(true);
  });

  it("does not reap a lock exactly at the TTL boundary", () => {
    // Strictly older than the TTL, so a boundary tick must not even reap.
    const { io, files } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a");
    expect(acquire(io, DIR, NOW + LOCK_TTL_MS, LOCK_TTL_MS, "win-b")).toBe(false);
    // Lock at boundary is not reaped — it is still held.
    expect(files[lockPath(DIR)]).toBeTruthy();
  });

  it("reaps a lock whose contents are unreadable", () => {
    // A half-written or hand-mangled lock must not wedge every window forever.
    // First attempt reaps the corrupted lock, second succeeds.
    const { io, files } = fakeIo({ [lockPath(DIR)]: "not:a:timestamp" });
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a")).toBe(false);
    expect(files[lockPath(DIR)]).toBeUndefined();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a")).toBe(true);
  });

  it("handles a lock that vanished between the failed create and the read", () => {
    // tryCreate says taken, read says gone: the holder released in between, so the
    // next attempt must be allowed rather than reporting a lock nobody holds.
    const files: Record<string, string> = { [lockPath(DIR)]: `${NOW}:win-a` };
    const io: LockIo = {
      tryCreate: (p, text) => {
        if (p in files) {
          delete files[p]; // taken, then vanishes
          return false;
        } else {
          files[p] = text;
          return true;
        }
      },
      read: () => null,
      remove: (p) => { delete files[p]; },
    };
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS, "win-b")).toBe(true);
  });

  it("is reacquirable after release", () => {
    const { io } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a");
    release(io, DIR, "win-a");
    expect(acquire(io, DIR, NOW + 1, LOCK_TTL_MS, "win-a")).toBe(true);
  });

  it("prevents two windows from both acquiring one stale lock", () => {
    // Both windows meet a stale lock, judge it dead, and both call acquire.
    // Reaping (delete + fail) instead of stealing (remove + create + succeed)
    // prevents both from returning true on the same pass: at most one can succeed.
    const { io } = fakeIo();
    const STALE_NOW = NOW;
    // Create a stale lock from window A.
    expect(acquire(io, DIR, STALE_NOW, LOCK_TTL_MS, "win-a")).toBe(true);

    // Both windows now try to acquire at a time past the TTL.
    const CHECK_NOW = STALE_NOW + LOCK_TTL_MS + 1;
    const aResult = acquire(io, DIR, CHECK_NOW, LOCK_TTL_MS, "win-a");
    const bResult = acquire(io, DIR, CHECK_NOW, LOCK_TTL_MS, "win-b");

    // The key invariant: NOT both can return true. At least one must be false.
    expect(aResult && bResult).toBe(false);
  });
});

describe("release", () => {
  it("removes the lock", () => {
    const { io, files } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a");
    release(io, DIR, "win-a");
    expect(files[lockPath(DIR)]).toBeUndefined();
  });

  it("is safe when no lock is held", () => {
    const { io } = fakeIo();
    expect(() => release(io, DIR, "win-a")).not.toThrow();
  });

  it("does not release a lock held by another window", () => {
    const { io, files } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a");
    release(io, DIR, "win-b");
    // Lock is still held by win-a, so it should still exist.
    expect(files[lockPath(DIR)]).toBeTruthy();
  });

  it("is safe when releasing with a non-matching token against a corrupted lock", () => {
    const { io } = fakeIo({ [lockPath(DIR)]: "corrupted" });
    // Non-matching token on a lock we can't parse: should not throw.
    expect(() => release(io, DIR, "win-a")).not.toThrow();
  });
});
