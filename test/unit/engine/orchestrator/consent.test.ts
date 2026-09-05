import { describe, it, expect } from "vitest";
import { CONSENT_BATCH, consentCovers, consumeConsent, grantConsent } from "../../../../src/engine/orchestrator/consent";
import { emptyFlow, Flow } from "../../../../src/engine/orchestrator/model";

const flow = (): Flow => emptyFlow("f1", "f", 0);

describe("per-command consent", () => {
  it("covers nothing until granted, and never reads the flow-level stamp", () => {
    expect(consentCovers({ ...flow(), commandConfirmedAt: 5 }, "deploy.sh")).toBeUndefined();
  });

  it("an unbounded grant covers every run of exactly that text, and nothing else", () => {
    const f = grantConsent(flow(), "deploy.sh staging", 1_000);
    expect(consentCovers(f, "deploy.sh staging")).toEqual({ at: 1_000 });
    expect(consentCovers(f, "deploy.sh prod")).toBeUndefined();
    expect(consentCovers(f, "deploy.sh  staging")).toBeUndefined();
    // Consuming an unbounded grant changes nothing.
    expect(consumeConsent(f, "deploy.sh staging")).toEqual(f);
  });

  it("a bounded grant covers that many runs, is consumed one at a time, and then asks again", () => {
    let f = grantConsent(flow(), "deploy.sh", 1_000, 2);
    expect(consentCovers(f, "deploy.sh")).toEqual({ at: 1_000, remaining: 2 });
    f = consumeConsent(f, "deploy.sh");
    expect(consentCovers(f, "deploy.sh")).toEqual({ at: 1_000, remaining: 1 });
    f = consumeConsent(f, "deploy.sh");
    expect(consentCovers(f, "deploy.sh")).toBeUndefined();
    // Never below zero.
    expect(consumeConsent(f, "deploy.sh").commandConsents!["deploy.sh"].remaining).toBe(0);
  });

  it("a fresh grant replaces the old record rather than adding to it", () => {
    const f = grantConsent(grantConsent(flow(), "x", 1, 1), "x", 2, CONSENT_BATCH);
    expect(f.commandConsents!.x).toEqual({ at: 2, remaining: CONSENT_BATCH });
    expect(grantConsent(f, "x", 3).commandConsents!.x).toEqual({ at: 3 });
  });

  it("consuming a text with no record invents nothing", () => {
    expect(consumeConsent(flow(), "deploy.sh")).toEqual(flow());
  });

  it("refuses a hand-edited record it cannot read", () => {
    const f = { ...flow(), commandConsents: { "deploy.sh": { at: "yesterday" } as unknown as { at: number } } };
    expect(consentCovers(f, "deploy.sh")).toBeUndefined();
  });

  it("does not mutate the flow it is given", () => {
    const f = grantConsent(flow(), "x", 1, 2);
    const before = JSON.stringify(f);
    consumeConsent(f, "x");
    grantConsent(f, "y", 2);
    expect(JSON.stringify(f)).toBe(before);
  });
});
