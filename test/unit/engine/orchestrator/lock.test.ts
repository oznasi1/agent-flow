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
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
    expect(files[lockPath(DIR)]).toBeTruthy();
  });

  it("fails when another holder has a fresh lock", () => {
    const { io } = fakeIo();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
    // A second window, one millisecond later.
    expect(acquire(io, DIR, NOW + 1, LOCK_TTL_MS)).toBe(false);
  });

  it("steals a lock older than the TTL — the holder died", () => {
    const { io } = fakeIo();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
    expect(acquire(io, DIR, NOW + LOCK_TTL_MS + 1, LOCK_TTL_MS)).toBe(true);
  });

  it("does not steal a lock exactly at the TTL", () => {
    // Strictly older, so a boundary tick cannot let two windows in at once.
    const { io } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS);
    expect(acquire(io, DIR, NOW + LOCK_TTL_MS, LOCK_TTL_MS)).toBe(false);
  });

  it("steals a lock whose contents are unreadable", () => {
    // A half-written or hand-mangled lock must not wedge every window forever.
    const { io } = fakeIo({ [lockPath(DIR)]: "not a timestamp" });
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
  });

  it("steals a lock that vanished between the failed create and the read", () => {
    // tryCreate says taken, read says gone: the holder released in between, so the
    // next attempt must be allowed rather than reporting a lock nobody holds.
    const files: Record<string, string> = { [lockPath(DIR)]: String(NOW) };
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
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS)).toBe(true);
  });

  it("is reacquirable after release", () => {
    const { io } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS);
    release(io, DIR);
    expect(acquire(io, DIR, NOW + 1, LOCK_TTL_MS)).toBe(true);
  });
});

describe("release", () => {
  it("removes the lock", () => {
    const { io, files } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS);
    release(io, DIR);
    expect(files[lockPath(DIR)]).toBeUndefined();
  });

  it("is safe when no lock is held", () => {
    const { io } = fakeIo();
    expect(() => release(io, DIR)).not.toThrow();
  });
});
