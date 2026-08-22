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

/** A bar chart as inline SVG. `series` is [[label, value], …]. */
function barChart(series, { width = 720, height = 160 } = {}) {
  if (series.length === 0) return '<p class="empty">No data yet.</p>';
  const max = Math.max(1, ...series.map(([, v]) => v));
  const bw = width / series.length;
  const bars = series
    .map(([label, v], i) => {
      const h = Math.round((v / max) * (height - 24));
      return `<g><title>${esc(label)}: ${fmt(v)}</title>` +
        `<rect x="${(i * bw).toFixed(1)}" y="${height - h}" width="${Math.max(1, bw - 2).toFixed(1)}"` +
        ` height="${h}" rx="2" fill="var(--bar)"/></g>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" class="chart">${bars}</svg>`;
}

export function renderDashboard(data) {
  const { meta = {}, views = {}, clones = {}, stars = [], marketplace = [] } = data;
  const latest = marketplace[marketplace.length - 1];
  const thin = marketplace.length < 3;

  const viewSeries = Object.entries(views).sort().map(([d, b]) => [d, b.count]);
  const cloneSeries = Object.entries(clones).sort().map(([d, b]) => [d, b.count]);

  const since = meta.firstCollected
    ? `Recording since ${esc(String(meta.firstCollected).slice(0, 10))}`
    : "Recording has not started yet";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Flow — reach</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --bar:#3b6ea5; --line:#e3e3e3; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e6e6e6; --muted:#9aa0a6; --bar:#6ea8dc; --line:#2c2f36; }
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
  h2 { font-size:14px; margin:28px 0 8px; }
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

<h2>Daily views</h2>
${barChart(viewSeries)}

<h2>Daily clones</h2>
${barChart(cloneSeries)}
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
  const marketplace = fs.existsSync(path.join(dir, "marketplace.jsonl"))
    ? fs.readFileSync(path.join(dir, "marketplace.jsonl"), "utf8")
        .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
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
