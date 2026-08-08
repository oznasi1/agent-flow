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

/** Must comfortably exceed the slowest thing done while holding the lock — a launch
 * that opens a window, or a confirmation modal a human leaves sitting. The TTL is
 * only crash recovery: if a holder dies, this is how long other windows wait before
 * reaping. Erring long is cheap (flows poll every six seconds and nothing here is
 * urgent) and erring short is not — a lock reaped out from under a live launch lets
 * a second window fire the same rule, which is a second paid session. */
export const LOCK_TTL_MS = 300_000;

export function lockPath(dir: string): string {
  return path.join(dir, ".advance.lock");
}

/** The stored value is `<acquiredAt>:<token>`. */
function stamp(nowMs: number, token: string): string {
  return `${nowMs}:${token}`;
}

function tokenOf(raw: string): string {
  return raw.slice(raw.indexOf(":") + 1);
}

/** A lock nobody can be holding: past its TTL, or unparseable — half-written or
 * hand-mangled, which must not wedge every window forever. */
function isDead(raw: string, nowMs: number, ttlMs: number): boolean {
  const heldAt = Number(raw.slice(0, raw.indexOf(":")));
  return !Number.isFinite(heldAt) || nowMs - heldAt > ttlMs;
}

/** Take the lock, or report that someone else holds it.
 *
 * This returns true from exactly one place: a successful exclusive create on an
 * empty path. A lock past its TTL is REAPED, not stolen — we delete it and report
 * failure, letting the next poll's plain create arbitrate. Stealing (remove, then
 * create, then return true) looks equivalent and is not: two windows that both
 * judge one stale lock dead interleave their remove/create pairs and both come
 * away believing they hold it, which is precisely the double-launch this lock
 * exists to prevent. Reaping costs one poll of recovery latency after a crash and
 * cannot double-acquire. */
export function acquire(
  io: LockIo, dir: string, nowMs: number, ttlMs: number, token: string,
): boolean {
  const p = lockPath(dir);
  if (io.tryCreate(p, stamp(nowMs, token))) return true;

  const raw = io.read(p);
  // Vanished between the create and the read: the holder released in the gap, so
  // try once more rather than reporting a lock nobody holds.
  if (raw === null) return io.tryCreate(p, stamp(nowMs, token));

  if (isDead(raw, nowMs, ttlMs)) io.remove(p);
  return false;
}

/** Release our own lock, and only ours. A window suspended past the TTL has its
 * lock reaped and possibly replaced; without the token check its `release` would
 * delete a live holder's lock. */
export function release(io: LockIo, dir: string, token: string): void {
  const p = lockPath(dir);
  const raw = io.read(p);
  if (raw !== null && tokenOf(raw) !== token) return;
  io.remove(p);
}
