import { beforeEach, describe, expect, it, vi } from "vitest";
import { BATCH_SIZE, createPostHogSender, QUEUE_CAP, stackDigest } from "../../../src/telemetry/posthog";

function makeDeps(over: Partial<Parameters<typeof createPostHogSender>[0]> = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok", { status: 200 }));
  return {
    deps: { apiKey: "phc_test", host: "https://ph.test", distinctId: "m1", log: vi.fn(), fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1_700_000_000_000, ...over },
    fetchImpl,
  };
}

async function fill(sender: ReturnType<typeof createPostHogSender>, n: number) {
  for (let i = 0; i < n; i++) sender.sendEventData("e", { i });
  await Promise.resolve();
}

describe("createPostHogSender", () => {
  beforeEach(() => vi.useRealTimers());

  it("does not send before the batch fills", async () => {
    const { deps, fetchImpl } = makeDeps();
    await fill(createPostHogSender(deps), BATCH_SIZE - 1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("POSTs the PostHog /batch/ contract once the batch fills", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    await fill(sender, BATCH_SIZE);
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ph.test/batch/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body.api_key).toBe("phc_test");
    expect(body.batch).toHaveLength(BATCH_SIZE);
    expect(body.batch[0].event).toBe("e");
    expect(body.batch[0].properties.distinct_id).toBe("m1");
    expect(body.batch[0].timestamp).toBe("2023-11-14T22:13:20.000Z");
  });

  it("no-ops when the api key is still the placeholder", async () => {
    const { deps, fetchImpl } = makeDeps({ apiKey: "phc_REPLACE_ME" });
    const sender = createPostHogSender(deps);
    await fill(sender, BATCH_SIZE);
    await sender.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries once on a 500, then gives up", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("boom", { status: 500 }));
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const sender = createPostHogSender({ ...deps, retryDelayMs: 0 });
    sender.sendEventData("e");
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 401 — a bad key must not hammer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 401 }));
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const sender = createPostHogSender({ ...deps, retryDelayMs: 0 });
    sender.sendEventData("e");
    await sender.flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps the queue and drops the oldest", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    for (let i = 0; i < QUEUE_CAP + 10; i++) sender.sendEventData("e", { i });
    await sender.flush();
    const sent = fetchImpl.mock.calls.flatMap(([, init]) => JSON.parse(String((init as RequestInit).body)).batch);
    expect(sent.length).toBeLessThanOrEqual(QUEUE_CAP);
    expect(sent.some((e: any) => e.properties.i === 0)).toBe(false);
    expect(sent.some((e: any) => e.properties.i === QUEUE_CAP + 9)).toBe(true);
  });

  it("drop() discards without sending", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    sender.sendEventData("e");
    sender.drop();
    await sender.flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("swallows a rejected fetch and logs it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("offline"); });
    const log = vi.fn();
    const { deps } = makeDeps({ fetchImpl: fetchImpl as unknown as typeof fetch, log });
    const sender = createPostHogSender({ ...deps, retryDelayMs: 0 });
    sender.sendEventData("e");
    await expect(sender.flush()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("passes an abort signal so a hung request cannot leak", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    sender.sendEventData("e");
    await sender.flush();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeDefined();
  });

  it("sends errors through sendErrorData as unhandled_error", async () => {
    const { deps, fetchImpl } = makeDeps();
    const sender = createPostHogSender(deps);
    const err = new TypeError("nope");
    err.stack = "TypeError: nope\n    at f (/Users/someone/dev/agent-flow/dist/extension.js:9:1)";
    sender.sendErrorData(err, {});
    await sender.flush();
    const body = JSON.parse(String((fetchImpl.mock.calls[0][1] as RequestInit).body));
    expect(body.batch[0].event).toBe("unhandled_error");
    expect(body.batch[0].properties.error_class).toBe("TypeError");
    expect(body.batch[0].properties.stack_digest).toContain("dist/extension.js:9:1");
    expect(body.batch[0].properties.stack_digest).not.toContain("/Users/someone");
    expect(JSON.stringify(body)).not.toContain("nope");
  });
});

describe("stackDigest", () => {
  it("keeps our bundled frames and strips absolute paths", () => {
    const digest = stackDigest("Error: x\n    at a (/Users/oz/dev/agent-flow/dist/extension.js:1:2)\n    at b (node:internal/foo:3:4)");
    expect(digest).toContain("dist/extension.js:1:2");
    expect(digest).not.toContain("/Users/oz");
  });

  it("returns an empty string for a missing stack", () => {
    expect(stackDigest(undefined)).toBe("");
  });

  it("truncates to 20 frames", () => {
    const stack = "Error: x\n" + Array.from({ length: 40 }, (_, i) => `    at f${i} (dist/extension.js:${i}:1)`).join("\n");
    expect(stackDigest(stack).split("\n")).toHaveLength(20);
  });
});
