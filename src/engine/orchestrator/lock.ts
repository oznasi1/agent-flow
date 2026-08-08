// A TTL lock over the flows directory, so two VS Code windows cannot advance the
// same flow at once. This is not belt-and-braces: the flows directory is global and
// each window has its own panel, so without it both windows read an unfired edge
// and both fire it — measured, in the previous phase, as two identical toasts with
// one window's stamp overwriting the other's. Once a rule can launch an agent, that
// is a second paid session.
//
// Pure over an injected IO for the same reason every other rule in this directory
// is: the whole contention story is testable from a plain object, with no temp
// directory and no real clock.
import * as path from "path";

/** The only IO surface. `tryCreate` MUST be an atomic exclusive create — return
 * false, do not throw, if the file already exists. */
export interface LockIo {
  tryCreate(p: string, text: string): boolean;
  read(p: string): string | null;
  remove(p: string): void;
}

/** Long enough that a healthy critical section (one read, one evaluate, a few small
 * writes) can never be mistaken for a dead holder; short enough that a crashed
 * window costs at most this much progress. */
export const LOCK_TTL_MS = 30_000;

export function lockPath(dir: string): string {
  return path.join(dir, ".advance.lock");
}

/** Take the lock, or report that someone else holds it. The stored value is the
 * acquiring timestamp, which is all the TTL check needs. */
export function acquire(io: LockIo, dir: string, nowMs: number, ttlMs: number): boolean {
  const p = lockPath(dir);
  if (io.tryCreate(p, String(nowMs))) return true;

  // Someone holds it — or held it. Decide whether they are alive.
  const raw = io.read(p);
  // Vanished between the create and the read: released in the gap, so try again
  // rather than reporting a lock nobody holds.
  if (raw === null) return io.tryCreate(p, String(nowMs));

  const heldAt = Number(raw);
  // An unparseable lock (half-written, hand-mangled) must not wedge every window
  // forever. Treat it as dead.
  const dead = !Number.isFinite(heldAt) || nowMs - heldAt > ttlMs;
  if (!dead) return false;

  io.remove(p);
  return io.tryCreate(p, String(nowMs));
}

export function release(io: LockIo, dir: string): void {
  io.remove(lockPath(dir));
}
