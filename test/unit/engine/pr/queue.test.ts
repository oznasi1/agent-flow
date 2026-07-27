import { describe, it, expect, vi } from "vitest";
import { RefreshQueue } from "../../../../src/engine/pr/queue";

/** A promise you resolve by hand, so concurrency is observable without timers. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("RefreshQueue", () => {
  it("starts work immediately", async () => {
    const q = new RefreshQueue();
    const work = vi.fn(async () => {});
    q.push("a", work);
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("ignores a second push for a key already in flight", async () => {
    const q = new RefreshQueue();
    const d = deferred();
    const work = vi.fn(() => d.promise);
    q.push("a", work);
    await flush();
    q.push("a", work);
    q.push("a", work);
    await flush();
    expect(work).toHaveBeenCalledTimes(1);
    expect(q.inFlight).toBe(1);
    d.resolve();
    await q.idle();
  });

  it("accepts the same key again once the first call has settled", async () => {
    const q = new RefreshQueue();
    const work = vi.fn(async () => {});
    q.push("a", work);
    await q.idle();
    q.push("a", work);
    await q.idle();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("runs different keys concurrently up to the limit", async () => {
    const q = new RefreshQueue(2);
    const ds = [deferred(), deferred(), deferred()];
    const started: string[] = [];
    ["a", "b", "c"].forEach((k, i) => q.push(k, () => { started.push(k); return ds[i].promise; }));
    await flush();

    expect(started).toEqual(["a", "b"]);
    expect(q.inFlight).toBe(2);
    expect(q.pending).toBe(1);

    ds[0].resolve();
    await flush();
    expect(started).toEqual(["a", "b", "c"]);

    ds[1].resolve();
    ds[2].resolve();
    await q.idle();
  });

  it("frees a slot when work rejects, and never rethrows", async () => {
    const q = new RefreshQueue(1);
    const after = vi.fn(async () => {});
    q.push("a", async () => { throw new Error("boom"); });
    q.push("b", after);
    await q.idle();
    expect(after).toHaveBeenCalledTimes(1);
    expect(q.inFlight).toBe(0);
  });

  it("idle resolves immediately on an empty queue", async () => {
    await expect(new RefreshQueue().idle()).resolves.toBeUndefined();
  });

  it("clear drops pending work but lets in-flight work settle", async () => {
    const q = new RefreshQueue(1);
    const d = deferred();
    const never = vi.fn(async () => {});
    q.push("a", () => d.promise);
    await flush();
    q.push("b", never);
    expect(q.pending).toBe(1);

    q.clear();
    expect(q.pending).toBe(0);
    d.resolve();
    await q.idle();
    expect(never).not.toHaveBeenCalled();
  });
});
