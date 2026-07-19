import { describe, it, expect } from "vitest";
import { inferServices, type InferSource } from "../../../src/engine/infer";
import { mkRepos } from "../../_helpers/factories";

const repos = mkRepos([
  "account-service",
  "domains-manager",
  "centaur",
  "new-stance-aggregator",
  "scan-service",
  "api", // 3 chars — below the text-match length guard
  "foo.bar", // contains a regex metachar
]);

const src = (o: Partial<InferSource>): InferSource => ({
  summary: "",
  labels: [],
  components: [],
  ...o,
});

/** repo:reason pairs, sorted for stable comparison. */
const names = (o: Partial<InferSource>) =>
  inferServices(src(o), repos)
    .map((r) => `${r.service.name}:${r.reason}`)
    .sort();

describe("inferServices — structured fields", () => {
  it("matches a component to a repo", () => {
    expect(names({ summary: "Separate deactivate from delete", components: ["account-service"] })).toEqual([
      "account-service:component",
    ]);
  });

  it("matches a label to a repo", () => {
    expect(names({ summary: "fix a thing", labels: ["centaur"] })).toEqual(["centaur:label"]);
  });

  it("matches components case-insensitively and trims whitespace", () => {
    expect(names({ summary: "x", components: ["  Account-Service "] })).toEqual(["account-service:component"]);
  });

  it("matches a short (<5 char) repo name via its component even though text is skipped", () => {
    expect(names({ summary: "x", components: ["api"] })).toEqual(["api:component"]);
  });
});

describe("inferServices — free-text matches", () => {
  it("matches a repo name as a whole word in the summary", () => {
    expect(names({ summary: "Refactor new-stance-aggregator retry logic" })).toEqual([
      "new-stance-aggregator:text",
    ]);
  });

  it("matches a repo name mentioned in the description text", () => {
    expect(names({ summary: "generic title", descriptionText: "touches the scan-service pipeline" })).toEqual([
      "scan-service:text",
    ]);
  });

  it("does not match a repo name that is only a substring (whole-word boundary)", () => {
    expect(names({ summary: "the centaurs are restless" })).toEqual([]);
  });

  it("does not text-match repo names shorter than 5 chars", () => {
    expect(names({ summary: "update the api layer" })).toEqual([]);
  });

  it("does not treat regex metacharacters in a repo name as wildcards", () => {
    expect(names({ summary: "touch foo.bar now" })).toEqual(["foo.bar:text"]);
    expect(names({ summary: "touch fooxbar now" })).toEqual([]);
  });

  it("does not produce false positives on generic prose", () => {
    expect(names({ summary: "Security services enhancements - phase 3" })).toEqual([]);
  });
});

describe("inferServices — precedence & dedupe", () => {
  it("keeps the component reason when a repo also appears in text", () => {
    expect(names({ summary: "touch account-service again", components: ["account-service"] })).toEqual([
      "account-service:component",
    ]);
  });

  it("prefers a label over a text match for the same repo", () => {
    expect(names({ summary: "centaur needs love", labels: ["centaur"] })).toEqual(["centaur:label"]);
  });

  it("returns multiple services across reasons", () => {
    expect(names({ summary: "sync centaur with the backend", components: ["account-service"] })).toEqual([
      "account-service:component",
      "centaur:text",
    ]);
  });

  it("returns nothing when no repo matches", () => {
    expect(inferServices(src({ summary: "totally unrelated work" }), repos)).toEqual([]);
  });
});
