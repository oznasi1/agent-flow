import { describe, it, expect } from "vitest";
import { acquire, release, renew, lockPath, LockIo, LOCK_TTL_MS } from "../../../../src/engine/orchestrator/lock";

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

  it("never reaps and acquires in the same pass — the property that makes reaping safe", () => {
    // The double-acquire that stealing allows needs one window to have read the
    // stale stamp before another reaps and recreates, which no sequential fake can
    // express. What IS observable sequentially is the invariant that rules it out:
    // a pass that deletes a dead lock does not go on to claim it. Under stealing
    // this call returns true; under reaping it must return false.
    const { io, files } = fakeIo();
    let removed = false;
    const watched: LockIo = {
      ...io,
      remove: (p) => {
        removed = true;
        io.remove(p);
      },
    };

    acquire(watched, DIR, NOW, LOCK_TTL_MS, "win-a");
    const stolen = acquire(watched, DIR, NOW + LOCK_TTL_MS + 1, LOCK_TTL_MS, "win-b");

    expect(removed).toBe(true); // it really did meet a dead lock and reap it
    expect(stolen).toBe(false); // and it did NOT claim it in the same pass
    expect(files[lockPath(DIR)]).toBeUndefined();
  });
});

describe("acquire — a lock stamped in the future", () => {
  it("reaps a lock whose heldAt is further than the TTL in the future", () => {
    // Clock skew plus a crash can leave `heldAt` ahead of every window's clock.
    // A plain age check (`nowMs - heldAt > ttlMs`) then reads negative forever,
    // so the lock is immortal and the orchestrator silently stops in every
    // window until someone deletes the file by hand. Nobody can legitimately be
    // holding a lock stamped that far ahead, so it is as dead as a stale one.
    const { io, files } = fakeIo({ [lockPath(DIR)]: `${NOW + 2 * LOCK_TTL_MS}:win-ghost` });
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a")).toBe(false);
    expect(files[lockPath(DIR)]).toBeUndefined();
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a")).toBe(true);
  });

  it("does not reap a lock within one TTL of the future — ordinary skew between two live windows", () => {
    // Two machines a few seconds apart must not reap each other's live locks:
    // only a stamp beyond the same strict boundary the past-facing check uses.
    const { io, files } = fakeIo({ [lockPath(DIR)]: `${NOW + LOCK_TTL_MS}:win-b` });
    expect(acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a")).toBe(false);
    expect(files[lockPath(DIR)]).toBeTruthy();
  });
});

describe("renew", () => {
  it("pushes our own lock's deadline out, so the same holder survives its own TTL", () => {
    const { io, files } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a");
    // Most of the TTL has gone by inside one slow step.
    expect(renew(io, DIR, "win-a", NOW + LOCK_TTL_MS - 1)).toBe(true);
    // The stamp really moved: another window at a time that WOULD have reaped the
    // original lock now finds a live one and leaves it alone.
    expect(acquire(io, DIR, NOW + LOCK_TTL_MS + 1, LOCK_TTL_MS, "win-b")).toBe(false);
    expect(files[lockPath(DIR)]).toBe(`${NOW + LOCK_TTL_MS - 1}:win-a`);
  });

  it("reports false when our lock was reaped, and does not re-take it", () => {
    // The whole point: a pass that lost its lock must learn that and STOP, and it
    // must not create a lock from a path that never arbitrated for one.
    const { io, files } = fakeIo();
    acquire(io, DIR, NOW, LOCK_TTL_MS, "win-a");
    io.remove(lockPath(DIR)); // window B reaped it past the TTL
    expect(renew(io, DIR, "win-a", NOW + LOCK_TTL_MS + 2)).toBe(false);
    expect(files[lockPath(DIR)]).toBeUndefined();
  });

  it("reports false when another window now holds the lock, and leaves that lock alone", () => {
    const { io, files } = fakeIo({ [lockPath(DIR)]: `${NOW + 1}:win-b` });
    expect(renew(io, DIR, "win-a", NOW + 2)).toBe(false);
    // Untouched: removing it here would be the steal `acquire` refuses.
    expect(files[lockPath(DIR)]).toBe(`${NOW + 1}:win-b`);
  });

  it("reports false, rather than holding on, when the create loses the gap to another window", () => {
    // Our token is in the lock, so we remove it — and another window's plain
    // create wins the gap before ours. Two windows must not both believe they
    // hold it, so the answer is false and the caller stops.
    const files: Record<string, string> = { [lockPath(DIR)]: `${NOW}:win-a` };
    const io: LockIo = {
      tryCreate: () => false, // win-b got there first
      read: (p) => files[p] ?? null,
      remove: (p) => { delete files[p]; },
    };
    expect(renew(io, DIR, "win-a", NOW + 1)).toBe(false);
  });

  it("does not renew a corrupted lock into a live one under our name", () => {
    // Unparseable contents mean no token of ours: `acquire`'s reaping path owns
    // that case, and renewing would resurrect it as a lock we claim to hold.
    const { io } = fakeIo({ [lockPath(DIR)]: "not:a:timestamp" });
    expect(renew(io, DIR, "win-a", NOW)).toBe(false);
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
