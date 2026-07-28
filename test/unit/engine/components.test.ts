import { describe, it, expect } from "vitest";
import { mapRepoComponents, resolveComponent } from "../../../src/engine/components";

describe("resolveComponent", () => {
  it("resolves an exact name", () => {
    expect(resolveComponent("billing-service", ["billing-service", "Infra"])).toBe("billing-service");
  });

  it("matches case-insensitively and returns the project's spelling, not the repo's", () => {
    expect(resolveComponent("billing-service", ["Billing-Service"])).toBe("Billing-Service");
  });

  it("tolerates surrounding whitespace on either side", () => {
    expect(resolveComponent("  billing-service ", ["billing-service"])).toBe("billing-service");
    expect(resolveComponent("billing-service", [" billing-service "])).toBe(" billing-service ");
  });

  it("returns null when the project has no such component", () => {
    expect(resolveComponent("scratch-tool", ["billing-service", "Infra"])).toBeNull();
  });

  it("returns null for an empty or whitespace-only repo name", () => {
    expect(resolveComponent("", ["billing-service"])).toBeNull();
    expect(resolveComponent("   ", ["billing-service"])).toBeNull();
  });

  it("returns null against an empty component list", () => {
    expect(resolveComponent("billing-service", [])).toBeNull();
  });

  it("takes the first of two components that fold to the same name", () => {
    // A project misconfiguration the user cannot see from the card. Picking one
    // beats refusing the write.
    expect(resolveComponent("billing", ["Billing", "billing"])).toBe("Billing");
  });
});

describe("mapRepoComponents", () => {
  it("keys by the repo's own spelling and values with the component's", () => {
    expect(mapRepoComponents(["billing-service", "centaur"], ["Billing-Service", "Centaur"])).toEqual({
      "billing-service": "Billing-Service",
      centaur: "Centaur",
    });
  });

  it("omits repos with no component, so a present key means 'syncable'", () => {
    expect(mapRepoComponents(["billing-service", "scratch-tool"], ["billing-service"])).toEqual({
      "billing-service": "billing-service",
    });
  });

  it("returns an empty map when the component list is empty", () => {
    expect(mapRepoComponents(["billing-service"], [])).toEqual({});
  });
});
