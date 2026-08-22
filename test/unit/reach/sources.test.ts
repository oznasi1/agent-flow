import { describe, it, expect } from "vitest";
import {
  parseTraffic, parseOpenVsx, parseVsMarketplace, parseStars,
} from "../../../scripts/reach/sources.mjs";

const VIEWS = {
  count: 97, uniques: 9,
  views: [
    { timestamp: "2026-08-08T00:00:00Z", count: 1, uniques: 1 },
    { timestamp: "2026-08-21T00:00:00Z", count: 18, uniques: 3 },
  ],
};
const CLONES = {
  count: 290, uniques: 105,
  clones: [{ timestamp: "2026-08-21T00:00:00Z", count: 20, uniques: 7 }],
};
const OPEN_VSX = { version: "0.36.0", downloadCount: 18596, reviewCount: 4 };
const VS_MARKETPLACE = {
  results: [{ extensions: [{
    versions: [{ version: "0.36.0" }],
    statistics: [
      { statisticName: "install", value: 11 },
      { statisticName: "downloadCount", value: 1066 },
      { statisticName: "updateCount", value: 77 },
      { statisticName: "weightedRating", value: 4.451494509719119 },
    ],
  }] }],
};

describe("parseTraffic", () => {
  it("reads the views array", () => {
    expect(parseTraffic(VIEWS)["2026-08-21"]).toEqual({ count: 18, uniques: 3 });
  });

  it("reads the clones array from the same function", () => {
    expect(parseTraffic(CLONES)["2026-08-21"]).toEqual({ count: 20, uniques: 7 });
  });

  it("throws on a payload with neither array — never returns an empty map", () => {
    expect(() => parseTraffic({ message: "Not Found" })).toThrow(/malformed/i);
    expect(() => parseTraffic(null)).toThrow(/malformed/i);
  });
});

describe("parseOpenVsx", () => {
  it("extracts the download count", () => {
    expect(parseOpenVsx(OPEN_VSX)).toEqual({ downloads: 18596, reviews: 4, version: "0.36.0" });
  });

  it("throws when downloadCount is absent rather than reporting zero", () => {
    expect(() => parseOpenVsx({ version: "0.36.0" })).toThrow(/malformed/i);
    expect(() => parseOpenVsx({ error: "not found" })).toThrow(/malformed/i);
  });
});

describe("parseVsMarketplace", () => {
  it("pulls each named statistic out of the flat array", () => {
    expect(parseVsMarketplace(VS_MARKETPLACE)).toEqual({
      downloads: 1066, installs: 11, updates: 77,
      rating: 4.451494509719119, version: "0.36.0",
    });
  });

  it("throws when the extension is missing rather than reporting zero", () => {
    expect(() => parseVsMarketplace({ results: [{ extensions: [] }] })).toThrow(/malformed/i);
  });

  it("throws when downloadCount is absent from the statistics", () => {
    const noDownloads = { results: [{ extensions: [{ statistics: [{ statisticName: "install", value: 11 }] }] }] };
    expect(() => parseVsMarketplace(noDownloads)).toThrow(/downloadCount/i);
  });
});

describe("parseStars", () => {
  it("returns sorted ISO timestamps", () => {
    const payload = [{ starred_at: "2026-07-27T07:38:56Z" }, { starred_at: "2026-07-23T08:46:16Z" }];
    expect(parseStars(payload)).toEqual(["2026-07-23T08:46:16Z", "2026-07-27T07:38:56Z"]);
  });

  it("returns an empty array for a repo with no stars", () => {
    expect(parseStars([])).toEqual([]);
  });

  it("throws when the payload is not an array", () => {
    expect(() => parseStars({ message: "Bad credentials" })).toThrow(/malformed/i);
  });
});
