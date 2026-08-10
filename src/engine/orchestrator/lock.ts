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
 * that opens a window or a seed that opens a workspace. NOT a confirmation modal: a
 * pass that needs to ask performs nothing and records the ask instead, and the
 * modal itself runs after `release` — see `advanceArmedFlows` in `deckView.ts`. The
 * TTL is only crash recovery: if a holder dies, this is how long other windows wait
 * before reaping. Erring long is cheap (flows poll every six seconds and nothing
 * here is urgent) and erring short is not — a lock reaped out from under a live
 * launch lets a second window fire the same rule, which is a second paid session. */
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

/** Push our own lock's deadline out to `nowMs`, and report whether we still hold
 * it. `false` means we do not: the lock is gone, or another window's token is in
 * it — and the caller must STOP whatever it is doing under the lock, not carry on.
 *
 * This exists because the TTL alone cannot bound a pass, only a single step of one.
 * `advanceUnderLock` holds one lock across EVERY armed flow, and a `run` edge can
 * legitimately take `COMMAND_TIMEOUT_MS` (120 s) all by itself, so a pass over
 * three flows with met command rules can hold the lock for far longer than
 * `LOCK_TTL_MS`. Window B then reaps it and starts its own pass while A is still
 * executing; because A stamps its edges only at the END of its pass, B sees the
 * same edge unfired, evaluates it as met, and runs the same command a second
 * time — a double deploy. Renewing after each step, and ABORTING when the renewal
 * fails, reduces the exposure from "the whole pass" to "the longest single step",
 * which is the invariant `LOCK_TTL_MS`'s own comment claims and is what makes 120 s
 * "comfortably" under 300 s again. Renewal is not an alternative to that ceiling:
 * it is what makes one ceiling enough.
 *
 * Same "reap, not steal" discipline as `acquire`, and for the same reason. This
 * returns true from exactly one place — a successful exclusive create — and it
 * never removes a lock whose token is not ours. The remove/create pair is safe
 * here precisely because of that token check: the only window that can win the
 * gap between them is one whose plain `tryCreate` succeeded, and if that happens
 * OUR create fails, we report false, and the caller stops. There is no
 * interleaving in which two windows both come away believing they hold it.
 *
 * The gap is real and is stated rather than hidden: for the sub-millisecond
 * between `remove` and `tryCreate` the path is empty, so another window's ordinary
 * `acquire` can legitimately take it — and that window is then the rightful holder.
 * The outcome is fail-safe (we lose the race, answer false, and the caller aborts
 * mid-pass exactly as it would for a reaping) and it is strictly smaller than the
 * hazard it replaces: a 300 s window in which a pass keeps spending under a lock
 * another window already reaped.
 *
 * The obvious alternative — an in-place overwrite via a `write` on `LockIo`, no
 * remove — is WORSE, which is why it is not here. The token check would then be
 * TOCTOU: read says ours, we write, and in between another window reaped the stale
 * stamp and created its own, which our write silently overwrites with our token.
 * Both windows then believe they hold it, and the one that thinks it renewed keeps
 * spending — the exact double-acquire `acquire`'s reap-not-steal discipline exists
 * to prevent. An atomic create that FAILS is the only primitive that can tell us
 * we lost. */
export function renew(io: LockIo, dir: string, token: string, nowMs: number): boolean {
  const p = lockPath(dir);
  const raw = io.read(p);
  // Gone: reaped by another window (and possibly already replaced and released
  // again). Not ours to re-take here — `acquire` on the next poll is the only way
  // back in, so that a lock is never created by a path that has not arbitrated.
  if (raw === null) return false;
  // Someone else's. Do NOT remove it: that is the steal this module refuses.
  if (tokenOf(raw) !== token) return false;
  io.remove(p);
  return io.tryCreate(p, stamp(nowMs, token));
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
