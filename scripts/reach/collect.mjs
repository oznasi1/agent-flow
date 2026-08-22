// The collector: fetch every source, merge, write. Runnable as
//   node scripts/reach/collect.mjs --out <dir>
//
// Each source is isolated in its own try/catch. A source that throws writes
// NOTHING and is reported in `failed`; its siblings still land. That isolation
// is the whole enforcement of the never-write-a-zero rule — see the spec.

import { mergeDaily } from "./merge.mjs";
import { parseTraffic, parseOpenVsx, parseVsMarketplace, parseStars } from "./sources.mjs";
import { readJson, writeJson, appendJsonl } from "./store.mjs";

const OWNER = "oznasi1";
const REPO = "agent-flow";
const VSX_NAMESPACE = "oznasi1";
const VSX_NAME = "oznasi1-agent-flow";
const VS_EXT_ID = "oznasi1.oznasi1-agent-flow";

const GH = `https://api.github.com/repos/${OWNER}/${REPO}`;

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Extract the `rel="next"` URL from a GitHub `Link` response header, or null
 * when there isn't one (last page). */
function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

/** Follow `Link: rel="next"` until exhausted, concatenating every page's
 * array. GitHub's stargazers endpoint returns ascending by `starred_at` and
 * caps each page at 100 — past 100 stars a single page is a silent freeze,
 * so full history requires walking every page. */
async function getAllPages(fetchImpl, url, init) {
  const items = [];
  let next = url;
  while (next) {
    const res = await fetchImpl(next, init);
    if (!res.ok) throw new Error(`${next} → HTTP ${res.status}`);
    const page = await res.json();
    if (!Array.isArray(page)) throw new Error(`${next} → paginated response was not an array`);
    items.push(...page);
    const linkHeader = typeof res.headers?.get === "function" ? res.headers.get("link") : null;
    next = nextPageUrl(linkHeader);
  }
  return items;
}

const ghInit = (token, accept = "application/vnd.github+json") => ({
  headers: { Accept: accept, Authorization: `Bearer ${token}`, "User-Agent": "agent-flow-reach" },
});

export async function collect({ dir, token, fetchImpl, now }) {
  const ok = [];
  const failed = [];

  /** Run one source in isolation. A throw writes nothing at all. */
  const source = async (name, fn) => {
    try {
      await fn();
      ok.push(name);
    } catch (e) {
      failed.push({ source: name, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const day = now.slice(0, 10);

  await source("views", async () => {
    const incoming = parseTraffic(await getJson(fetchImpl, `${GH}/traffic/views`, ghInit(token)));
    writeJson(dir, "traffic/views.json", mergeDaily(readJson(dir, "traffic/views.json", {}), incoming));
  });

  await source("clones", async () => {
    const incoming = parseTraffic(await getJson(fetchImpl, `${GH}/traffic/clones`, ghInit(token)));
    writeJson(dir, "traffic/clones.json", mergeDaily(readJson(dir, "traffic/clones.json", {}), incoming));
  });

  // Referrers and paths are top-10 rankings, not totals — two snapshots do not
  // compose, so each run writes its own dated file and the dashboard reads the
  // series rather than a merged aggregate.
  await source("referrers", async () => {
    const payload = await getJson(fetchImpl, `${GH}/traffic/popular/referrers`, ghInit(token));
    if (!Array.isArray(payload)) throw new Error("reach: malformed referrers payload");
    writeJson(dir, `snapshots/referrers/${day}.json`, payload);
  });

  await source("paths", async () => {
    const payload = await getJson(fetchImpl, `${GH}/traffic/popular/paths`, ghInit(token));
    if (!Array.isArray(payload)) throw new Error("reach: malformed paths payload");
    writeJson(dir, `snapshots/paths/${day}.json`, payload);
  });

  await source("stars", async () => {
    const payload = await getAllPages(
      fetchImpl, `${GH}/stargazers?per_page=100`,
      ghInit(token, "application/vnd.github.star+json"),
    );
    writeJson(dir, "stars.json", parseStars(payload));
  });

  // Both marketplaces feed ONE jsonl line, so a run where either fails appends
  // nothing — a half-filled line would be worse than a missing one.
  await source("marketplace", async () => {
    const vsx = parseOpenVsx(
      await getJson(fetchImpl, `https://open-vsx.org/api/${VSX_NAMESPACE}/${VSX_NAME}`, {}),
    );
    const vsm = parseVsMarketplace(await getJson(
      fetchImpl,
      "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
      {
        method: "POST",
        headers: {
          Accept: "application/json;api-version=3.0-preview.1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filters: [{ criteria: [{ filterType: 7, value: VS_EXT_ID }] }],
          flags: 914,
        }),
      },
    ));
    appendJsonl(dir, "marketplace.jsonl", { ts: now, openvsx: vsx, vsmarketplace: vsm });
  });

  const meta = readJson(dir, "meta.json", {});
  writeJson(dir, "meta.json", {
    firstCollected: meta.firstCollected ?? now,
    lastRun: now,
    schemaVersion: 1,
  });

  return { ok, failed };
}

// CLI entry. Only runs when invoked directly, so the test can import `collect`.
if (process.argv[1] && process.argv[1].endsWith("collect.mjs")) {
  const outIdx = process.argv.indexOf("--out");
  const dir = outIdx >= 0 ? process.argv[outIdx + 1] : ".";
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("reach: GH_TOKEN or GITHUB_TOKEN is required");
    process.exit(1);
  }
  const { ok, failed } = await collect({
    dir, token, fetchImpl: fetch, now: new Date().toISOString(),
  });
  console.log(`reach: ok=[${ok.join(", ")}]`);
  for (const f of failed) console.error(`reach: FAILED ${f.source} — ${f.error}`);
  // Non-zero on any failure so the workflow surfaces it, but the successful
  // sources have already been written and committed.
  process.exit(failed.length > 0 ? 1 : 0);
}
