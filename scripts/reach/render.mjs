// Dashboard generator. Emits ONE self-contained HTML file: inline CSS, inline
// SVG charts, no CDN, no scripts with a src. It must open correctly from a
// file:// URL with no network.

import * as fs from "fs";
import * as path from "path";
import { readJson } from "./store.mjs";

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "—");

/** Parses `marketplace.jsonl`, one JSON value per line. `appendJsonl` is the
 * store's one non-atomic writer — a process killed mid-append can leave a
 * torn final line. A single unparseable line must not make the whole
 * dashboard un-renderable forever, so it's skipped rather than thrown; the
 * skip count is returned so the caller can surface it. */
export function parseMarketplaceJsonl(text) {
  let skipped = 0;
  const records = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { records, skipped };
}

/**
 * A dated bar chart as inline SVG.
 *
 * Three things this must get right, none of them decorative:
 *
 * 1. **A zero day is data, not a gap.** GitHub genuinely reports `count: 0` on
 *    quiet days, and the whole point of this store is that a recorded zero and
 *    an unrecorded day are different facts. A zero therefore draws a visible
 *    baseline stub rather than nothing at all.
 * 2. **Labels thin out as history grows.** This series gets one bar longer
 *    every day and never resets, so anything that labels every bar is legible
 *    this week and unreadable by winter. Value labels appear only while the
 *    bars are wide enough to hold them; dates step to at most ~12 ticks.
 * 3. **Text wears ink tokens, never the bar colour** — the mark carries the
 *    identity, the numbers stay readable.
 *
 * `series` is [[isoDate, value], …], ascending.
 */
function barChart(series, { width = 720, plotH = 118 } = {}) {
  if (series.length === 0) return '<p class="empty">No data yet.</p>';

  const n = series.length;
  const max = Math.max(1, ...series.map(([, v]) => v));
  const padTop = 16;  // headroom for value labels
  const axisH = 16;   // date tick row
  const height = padTop + plotH + axisH;

  const slot = width / n;
  const barW = Math.max(1, slot - 2); // 2px surface gap between adjacent bars
  const baseline = padTop + plotH;

  // A number over every bar stops being readable once the bars are narrower
  // than the number. Past that, label only the peak and the most recent day —
  // the two a reader actually looks for.
  const roomForEveryLabel = slot >= 30;
  const peak = series.reduce((best, [, v], i) => (v > series[best][1] ? i : best), 0);
  const dateStep = Math.max(1, Math.ceil(n / 12));

  const parts = series.map(([date, v], i) => {
    const x = i * slot;
    const mid = x + barW / 2;
    const h = v === 0 ? 2 : Math.max(2, Math.round((v / max) * plotH));
    const y = baseline - h;
    const cls = v === 0 ? "bar zero" : "bar";

    let out = `<g><title>${esc(date)}: ${fmt(v)}</title>`
      + `<rect class="${cls}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"`
      + ` width="${barW.toFixed(1)}" height="${h}" rx="${Math.min(4, barW / 2).toFixed(1)}"/></g>`;

    if (roomForEveryLabel || i === peak || i === n - 1) {
      out += `<text class="val" x="${mid.toFixed(1)}" y="${(y - 4).toFixed(1)}">${fmt(v)}</text>`;
    }
    if (i % dateStep === 0 || i === n - 1) {
      // MM-DD: the year is already stated in the section subtitle.
      out += `<text class="tick" x="${mid.toFixed(1)}" y="${(baseline + 12).toFixed(1)}">`
        + `${esc(String(date).slice(5))}</text>`;
    }
    return out;
  });

  return `<svg viewBox="0 0 ${width} ${height}" role="img" class="chart"`
    + ` preserveAspectRatio="xMidYMid meet">`
    + `<line class="axis" x1="0" y1="${baseline}" x2="${width}" y2="${baseline}"/>`
    + parts.join("")
    + `</svg>`;
}

/** Section heading plus the totals that give the bars a scale. */
function chartSection(title, buckets) {
  const entries = Object.entries(buckets).sort();
  const total = entries.reduce((a, [, b]) => a + (b.count ?? 0), 0);
  const peak = entries.reduce((m, [, b]) => Math.max(m, b.count ?? 0), 0);
  // NO summed "unique" figure here, deliberately. Daily uniques do not add up:
  // someone who visits on three days counts once per day, so summing them
  // double-counts. GitHub reported 9 unique viewers for the window where the
  // daily figures sum to 21, and 105 unique cloners where they sum to 136.
  // Printing the sum would state a number that is simply false. The window
  // total GitHub does report is a rolling 14-day figure that cannot be
  // accumulated either, so it is not stored — and what is not known is not
  // shown.
  const sub = entries.length === 0
    ? "no days recorded yet"
    : `${fmt(total)} total · peak ${fmt(peak)}/day · `
      + `${fmt(entries.length)} days (${esc(entries[0][0])} → ${esc(entries[entries.length - 1][0])})`;
  return `<h2>${esc(title)}</h2>\n<p class="sub">${sub}</p>\n`
    + barChart(entries.map(([d, b]) => [d, b.count ?? 0]));
}

export function renderDashboard(data) {
  const { meta = {}, views = {}, clones = {}, stars = [], marketplace = [] } = data;
  const latest = marketplace[marketplace.length - 1];
  const thin = marketplace.length < 3;


  const since = meta.firstCollected
    ? `Recording since ${esc(String(meta.firstCollected).slice(0, 10))}`
    : "Recording has not started yet";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Flow — reach</title>
<style>
  /* --bar is validated against its surface by the dataviz palette checker:
     light #3b6ea5 and dark #5594cf both pass lightness band, chroma floor and
     3:1 contrast. The previous dark value (#6ea8dc) failed both band and
     chroma — it read as grey on the dark surface. */
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --bar:#3b6ea5; --line:#e3e3e3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e6e6e6; --muted:#9aa0a6; --bar:#5594cf; --line:#2c2f36; }
  }
  body { background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,sans-serif;
         margin:0 auto; padding:32px; max-width:820px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .since { color:var(--muted); margin:0 0 24px; }
  .tiles { display:flex; gap:24px; flex-wrap:wrap; margin-bottom:8px; }
  .tile b { display:block; font-size:26px; font-weight:600; }
  .tile span { color:var(--muted); font-size:12px; }
  .note { color:var(--muted); font-size:12px; border-left:2px solid var(--line);
          padding-left:10px; margin:16px 0; }
  .chart { width:100%; height:auto; }
  h2 { font-size:14px; margin:28px 0 2px; }
  .sub { color:var(--muted); font-size:12px; margin:0 0 10px; }
  .chart .bar { fill:var(--bar); }
  /* A recorded zero is a fact, not a gap — it keeps the bar colour so it reads
     as "we looked, and it was zero", not "we have no data for this day". */
  .chart .zero { fill:var(--bar); opacity:.35; }
  .chart .axis { stroke:var(--line); stroke-width:1; }
  /* Chart text wears ink tokens, never the series colour. */
  .chart .val { fill:var(--fg); font-size:9px; text-anchor:middle; font-variant-numeric:tabular-nums; }
  .chart .tick { fill:var(--muted); font-size:9px; text-anchor:middle; font-variant-numeric:tabular-nums; }
  .empty { color:var(--muted); }
</style></head><body>
<h1>Agent Flow — reach</h1>
<p class="since">${since}. Last run ${esc(String(meta.lastRun ?? "—").slice(0, 10))}.
Latest published version ${esc(latest?.openvsx?.version ?? "—")}.</p>

<div class="tiles">
  <div class="tile"><b>${fmt(latest?.openvsx?.downloads)}</b><span>Open VSX downloads</span></div>
  <div class="tile"><b>${fmt(latest?.vsmarketplace?.downloads)}</b><span>VS Marketplace downloads</span></div>
  <div class="tile"><b>${fmt(latest?.vsmarketplace?.installs)}</b><span>VS Marketplace installs</span></div>
  <div class="tile"><b>${fmt(stars.length)}</b><span>Stars</span></div>
</div>

<p class="note">Download counts include CI pulls, updates and repeat installs. They are
<strong>downloads</strong>, not people.</p>

${thin ? '<p class="note">Not enough history to show a trend yet — this needs at least three daily samples.</p>' : ""}

${chartSection("Daily views", views)}

${chartSection("Daily clones", clones)}
</body></html>
`;
}

// CLI entry: node scripts/reach/render.mjs --data <dir> --out <file>
if (process.argv[1] && process.argv[1].endsWith("render.mjs")) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
  };
  const dir = arg("--data", ".");
  const out = arg("--out", path.join(dir, "index.html"));
  let marketplace = [];
  if (fs.existsSync(path.join(dir, "marketplace.jsonl"))) {
    const { records, skipped } = parseMarketplaceJsonl(
      fs.readFileSync(path.join(dir, "marketplace.jsonl"), "utf8"),
    );
    marketplace = records;
    if (skipped > 0) {
      console.warn(`reach: skipped ${skipped} unparseable line(s) in marketplace.jsonl`);
    }
  }
  const html = renderDashboard({
    meta: readJson(dir, "meta.json", {}),
    views: readJson(dir, "traffic/views.json", {}),
    clones: readJson(dir, "traffic/clones.json", {}),
    stars: readJson(dir, "stars.json", []),
    marketplace,
  });
  fs.writeFileSync(out, html, "utf8");
  console.log(`reach: wrote ${out}`);
}
