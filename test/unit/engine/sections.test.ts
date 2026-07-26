import { describe, it, expect } from "vitest";
import { categoryLabel, orderSections } from "../../../src/engine/sections";

const rows = (...cats: string[]) => cats.map((category) => ({ category }));

describe("categoryLabel", () => {
  it("title-cases a plain category", () => {
    expect(categoryLabel("development")).toBe("Development");
  });

  it("title-cases every word of a hyphenated or underscored category", () => {
    expect(categoryLabel("code-review")).toBe("Code Review");
    expect(categoryLabel("api_security")).toBe("Api Security");
  });

  it("names the two synthetic buckets", () => {
    expect(categoryLabel("yours")).toBe("Yours");
    expect(categoryLabel("uncategorized")).toBe("Uncategorized");
  });

  it("survives an empty category", () => {
    expect(categoryLabel("")).toBe("Uncategorized");
  });
});

describe("orderSections", () => {
  it("puts Yours first and Uncategorized last, with the rest by descending count", () => {
    const s = orderSections(rows(
      "uncategorized", "development", "development", "development",
      "yours", "productivity", "productivity", "uncategorized",
    ));
    expect(s.map((x) => x.category)).toEqual(["yours", "development", "productivity", "uncategorized"]);
    expect(s.map((x) => x.count)).toEqual([1, 3, 2, 2]);
  });

  it("breaks count ties alphabetically so the order never flickers between scans", () => {
    const s = orderSections(rows("security", "design", "monitoring"));
    expect(s.map((x) => x.category)).toEqual(["design", "monitoring", "security"]);
  });

  it("carries the display label on each section", () => {
    expect(orderSections(rows("code-review"))[0].label).toBe("Code Review");
  });

  it("returns nothing for no rows", () => {
    expect(orderSections([])).toEqual([]);
  });

  it("omits Yours and Uncategorized when nothing falls in them", () => {
    expect(orderSections(rows("development")).map((x) => x.category)).toEqual(["development"]);
  });

  it("buckets a row with an empty category under uncategorized, pinned last", () => {
    const s = orderSections(rows("development", ""));
    expect(s.map((x) => x.category)).toEqual(["development", "uncategorized"]);
    expect(s.find((x) => x.category === "uncategorized")?.count).toBe(1);
  });
});
