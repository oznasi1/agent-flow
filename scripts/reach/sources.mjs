// Payload parsers, one per service. Pure: each takes an already-decoded JSON
// value and returns a normalised record, or THROWS.
//
// Throwing is the mechanism behind the collector's one hard rule. A parser that
// returned zeros on a malformed payload would let an expired token write a
// permanent false cliff into the store, so every failure path here is an
// exception and none of them is a default value.

import { toDailyMap } from "./merge.mjs";

/** GitHub's views and clones endpoints differ only in the array's key. */
export function parseTraffic(payload) {
  const buckets = payload?.views ?? payload?.clones;
  if (!Array.isArray(buckets)) {
    throw new Error("reach: malformed traffic payload — no views/clones array");
  }
  return toDailyMap(buckets);
}

export function parseOpenVsx(payload) {
  if (!payload || typeof payload.downloadCount !== "number") {
    throw new Error("reach: malformed Open VSX payload — no numeric downloadCount");
  }
  return {
    downloads: payload.downloadCount,
    reviews: typeof payload.reviewCount === "number" ? payload.reviewCount : 0,
    version: typeof payload.version === "string" ? payload.version : null,
  };
}

export function parseVsMarketplace(payload) {
  const ext = payload?.results?.[0]?.extensions?.[0];
  if (!ext || !Array.isArray(ext.statistics)) {
    throw new Error("reach: malformed VS Marketplace payload — no extension record");
  }
  const stat = (name) => {
    const hit = ext.statistics.find((s) => s?.statisticName === name);
    return typeof hit?.value === "number" ? hit.value : null;
  };
  const downloads = stat("downloadCount");
  if (downloads === null) {
    throw new Error("reach: VS Marketplace payload has no downloadCount statistic");
  }
  return {
    downloads,
    installs: stat("install"),
    updates: stat("updateCount"),
    rating: stat("weightedRating"),
    version: typeof ext.versions?.[0]?.version === "string" ? ext.versions[0].version : null,
  };
}

export function parseStars(payload) {
  if (!Array.isArray(payload)) {
    throw new Error("reach: malformed stargazers payload — not an array");
  }
  const stars = payload
    .map((s) => s?.starred_at)
    .filter((t) => typeof t === "string")
    .sort();
  // A genuinely starless repo returns []. But a non-empty array where NOT ONE
  // element has a usable starred_at means the Accept header was wrong or
  // dropped and the payload isn't what we think it is — returning [] here
  // would overwrite real history with nothing. Only trust an empty result
  // when the input itself was empty.
  if (payload.length > 0 && stars.length === 0) {
    throw new Error("reach: malformed stargazers payload — no element has a starred_at");
  }
  return stars;
}
