// Dashboard generator. Emits ONE self-contained HTML file: inline CSS, inline
// SVG charts, no CDN, no scripts with a src. It must open correctly from a
// file:// URL with no network.

import * as fs from "fs";
import * as path from "path";
import { readJson, readLatestSnapshot } from "./store.mjs";

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

    let out = `<g class="mark"><title>${esc(date)}: ${fmt(v)}</title>`
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

/** The days a preset covers, counted back from the newest day on record
 * rather than from the clock. Anchoring to the clock would empty every range
 * the moment the collector stalls — "the last 7 recorded days" is a question
 * the store can always answer, and the staleness banner is what says the
 * recording itself has stopped. */
export function sliceDays(buckets, days) {
  const dates = Object.keys(buckets).sort();
  if (days === null || dates.length === 0) return buckets;
  const newest = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`);
  const cut = newest - (days - 1) * 86400000;
  const out = {};
  for (const d of dates) {
    if (Date.parse(`${d}T00:00:00Z`) >= cut) out[d] = buckets[d];
  }
  return out;
}

/** Presets the store can actually answer. A 30-day button on 15 days of
 * history is a lie by omission — it would silently equal all-time. Rendered
 * disabled rather than dropped, so a short history reads as short. */
export function availablePresets(buckets, presets = [7, 30, 90]) {
  const span = Object.keys(buckets).length;
  return presets.map((days) => ({ days, enabled: days < span }));
}

/**
 * How much a cumulative counter moved across the samples inside a range.
 *
 * Download counts are lifetime totals: a date range cannot slice them, and
 * showing the unsliced total under a "7 days" filter would read as a claim
 * that all 19,504 downloads happened this week. The change between the first
 * and last sample in the window is the honest answer to the question the
 * filter is really asking.
 *
 * Needs two samples to state anything. One sample is a level, not a change,
 * and inventing a zero from it would look identical to a genuinely flat week.
 */
export function deltaWithin(marketplace, days, anchorDay) {
  if (marketplace.length < 2) return null;
  let within = marketplace;
  if (days !== null && anchorDay) {
    const cut = Date.parse(`${anchorDay}T00:00:00Z`) - (days - 1) * 86400000;
    within = marketplace.filter((m) => Date.parse(m.ts) >= cut);
  }
  if (within.length < 2) return null;
  const a = within[0];
  const b = within[within.length - 1];
  return {
    vsx: (b.openvsx?.downloads ?? 0) - (a.openvsx?.downloads ?? 0),
    vsm: (b.vsmarketplace?.downloads ?? 0) - (a.vsmarketplace?.downloads ?? 0),
  };
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

/** Every satisfiable range for one metric, pre-rendered. Each block carries
 * its own heading and subtitle; all but the active one are `hidden`, which
 * also takes them out of the accessibility tree.
 *
 * The alternative — shipping the data and redrawing in the browser — means a
 * second chart implementation in a second language, and the tests would only
 * ever cover one of them. Pre-rendering keeps `barChart` the single source of
 * truth; the client script does nothing but toggle which block is visible, so
 * a filtered view and the initial view cannot disagree.
 *
 * Only satisfiable presets get a block: with 15 days on record, a 30-day block
 * would be byte-identical to all-time.
 */
function chartBlocks(metric, title, buckets, presets) {
  const sum = (b) => Object.values(b).reduce((a, x) => a + (x.count ?? 0), 0);
  const block = (key, slice) =>
    `<div data-view="${esc(key)}" data-metric="${esc(metric)}"`
    + ` data-total="${sum(slice)}"${key === "all" ? "" : " hidden"}>`
    + `${chartSection(title, slice)}</div>`;
  const parts = [block("all", buckets)];
  for (const { days, enabled } of presets) {
    if (!enabled) continue;
    parts.push(block(String(days), sliceDays(buckets, days)));
  }
  return parts.join("\n");
}

/**
 * One ranking table — referrers or paths.
 *
 * These are the only figures here that must never be presented as a series.
 * GitHub returns a top-ten ordered by a rolling window it does not disclose,
 * so yesterday's table and today's share no denominator: they cannot be summed,
 * averaged, or charted over time. The subtitle therefore states the snapshot
 * date and says outright that it is a ranking, because a bare table of numbers
 * next to two time-series charts will otherwise be read as one.
 */
function rankSection(title, column, snapshot, label, blurb) {
  if (!snapshot || snapshot.rows.length === 0) {
    return `<h2>${esc(title)}</h2>\n<p class="empty">No snapshot recorded yet.</p>`;
  }
  const rows = snapshot.rows
    .slice(0, 10)
    .map((r) => `<tr><td>${esc(label(r))}</td>`
      + `<td class="n">${fmt(r.count)}</td>`
      + `<td class="n">${fmt(r.uniques)}</td></tr>`)
    .join("");
  return `<h2>${esc(title)}</h2>\n`
    + `<p class="sub">Ranking on ${esc(snapshot.date)} — ${esc(blurb)}. `
    + `A ranking is a single day: it is not a total, two snapshots do not add up, `
    + `and it does not follow the range above.</p>\n`
    + `<table class="rank"><thead><tr><th>${esc(column)}</th>`
    + `<th class="n">Views</th><th class="n">Uniques</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`;
}

/**
 * The page's favicon, inlined.
 *
 * It has to be a data URI, not a file: the dashboard must open from a file://
 * URL with no network, and a `/favicon.ico` reference would simply fail there
 * (and 404 on the way past Pages besides).
 *
 * It is a *simplification* of the project mark, not a copy of it. The real
 * store icon is a field of ~40 dots; at 16px that resolves to a dark blob with
 * the teal washed out entirely. Six dots on the same dark tile keep the family
 * resemblance and still read as dots in a tab strip, which is the only size
 * that matters here.
 *
 * Coordinates are literal rather than computed: six points on a radius-9.5
 * ring about (16,16), starting at twelve o'clock and stepping 60 degrees.
 */
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
  + '<rect width="32" height="32" rx="7" fill="#0E1113"/>'
  + '<circle cx="16" cy="6.5" r="3.4" fill="#2AA79B"/>'
  + '<circle cx="24.23" cy="11.25" r="3.4" fill="#2AA79B"/>'
  + '<circle cx="24.23" cy="20.75" r="3.4" fill="#2AA79B"/>'
  + '<circle cx="16" cy="25.5" r="3.4" fill="#2AA79B"/>'
  + '<circle cx="7.77" cy="20.75" r="3.4" fill="#2AA79B"/>'
  + '<circle cx="7.77" cy="11.25" r="3.4" fill="#2AA79B"/>'
  + '</svg>';

/**
 * Percent-encoding is not optional here. The fills are hex colours, and a raw
 * `#` inside a data URI starts the fragment — the browser would fetch a
 * truncated document ending at the first colour and render nothing.
 */
export function faviconDataUri(svg = FAVICON) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function renderDashboard(data) {
  const { meta = {}, views = {}, clones = {}, stars = [], marketplace = [],
    referrers = null, paths = null } = data;
  const latest = marketplace[marketplace.length - 1];
  const thin = marketplace.length < 3;
  const total = (buckets) =>
    Object.values(buckets).reduce((a, b) => a + (b.count ?? 0), 0);
  // Whichever metric has the longer record decides which presets are
  // offerable; they are collected together, so they normally agree.
  const spine = Object.keys(clones).length > Object.keys(views).length ? clones : views;
  const presets = availablePresets(spine);
  const recorded = Object.keys(spine).sort();
  const anchor = recorded[recorded.length - 1] ?? null;
  const deltaText = (days) => {
    const d = deltaWithin(marketplace, days, anchor);
    const where = days === null ? "since recording began" : `in the last ${days} days`;
    if (!d) return `no change recorded ${where}`;
    const sign = (n) => (n >= 0 ? `+${fmt(n)}` : fmt(n));
    return { vsx: `${sign(d.vsx)} ${where}`, vsm: `${sign(d.vsm)} ${where}` };
  };
  const allDelta = deltaText(null);
  const deltaAttrs = (days) => {
    const t = deltaText(days);
    return typeof t === "string"
      ? ` data-vsx="${esc(t)}" data-vsm="${esc(t)}"`
      : ` data-vsx="${esc(t.vsx)}" data-vsm="${esc(t.vsm)}"`;
  };


  const since = meta.firstCollected
    ? `Recording since ${esc(String(meta.firstCollected).slice(0, 10))}`
    : "Recording has not started yet";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Flow — reach</title>
<link rel="icon" type="image/svg+xml" href="${faviconDataUri()}">
<style>
  /* --bar is validated against its surface by the dataviz palette checker:
     light #3b6ea5 and dark #5594cf both pass lightness band, chroma floor and
     3:1 contrast. The previous dark value (#6ea8dc) failed both band and
     chroma — it read as grey on the dark surface. */
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --bar:#3b6ea5; --barHi:#2d5a8a;
          --line:#e3e3e3; --card:#fbfbfc; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16181c; --fg:#e6e6e6; --muted:#9aa0a6; --bar:#5594cf; --barHi:#77aede;
            --line:#2c2f36; --card:#1b1e24; }
  }
  * { box-sizing:border-box; }
  body { background:var(--bg); color:var(--fg); font:14px/1.55 system-ui,sans-serif;
         margin:0 auto; padding:36px 32px 72px; max-width:880px; }
  h1 { font-size:21px; margin:0 0 4px; letter-spacing:-.01em; }
  .since { color:var(--muted); margin:0 0 22px; font-size:13px; }
  /* One row, above everything it scopes. */
  .filters { display:flex; align-items:center; gap:6px; flex-wrap:wrap;
             margin:0 0 24px; padding-bottom:20px; border-bottom:1px solid var(--line); }
  .flabel { font-size:11px; text-transform:uppercase; letter-spacing:.07em;
            color:var(--muted); margin-right:6px; font-weight:600; }
  .filters button { font:inherit; font-size:13px; padding:5px 13px; border-radius:99px;
                    cursor:pointer; border:1px solid var(--line); background:transparent;
                    color:var(--muted); }
  .filters button:hover:not([disabled]) { color:var(--fg); border-color:var(--muted); }
  .filters button[aria-pressed="true"] { background:var(--fg); border-color:var(--fg);
                                         color:var(--bg); font-weight:600; }
  /* A preset the store cannot satisfy is shown disabled rather than hidden:
     the reader learns the history is short, instead of wondering where the
     control went — and it stops a 90-day button silently meaning all-time. */
  .filters button[disabled] { opacity:.38; cursor:not-allowed; }
  /* Grid, not flex: equal-width cards stay aligned when one label wraps,
     and a track wide enough for three across leaves six tiles as an even
     3x2 rather than a row of five and one orphan. */
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr));
           gap:10px; margin-bottom:8px; }
  .tile { background:var(--card); border:1px solid var(--line); border-radius:9px;
          padding:13px 15px; }
  .tile b { display:block; font-size:24px; font-weight:600; letter-spacing:-.02em;
            font-variant-numeric:tabular-nums; }
  .tile span { color:var(--muted); font-size:11.5px; display:block; margin-top:3px; }
  .tile em { font-style:normal; color:var(--muted); font-size:11px; display:block;
             margin-top:5px; }
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
  /* A ranking reads as a time series if it looks like one, so the tables are
     deliberately plain — no bars, no colour, nothing that implies a trend. */
  .rank { border-collapse:collapse; width:100%; font-size:13px; margin-bottom:4px; }
  .rank th { text-align:left; font-weight:600; color:var(--muted); font-size:11px;
             text-transform:uppercase; letter-spacing:.05em; padding:0 8px 6px 0;
             border-bottom:1px solid var(--line); }
  .rank td { padding:6px 8px 6px 0; border-bottom:1px solid var(--line); }
  .rank tr:last-child td { border-bottom:0; }
  .rank .n { text-align:right; font-variant-numeric:tabular-nums; padding-right:0; width:72px; }
  /* Referrers and paths side by side: two short tables stacked leave a
     column of dead space, and neither is long enough to need the width. */
  .cols { display:grid; grid-template-columns:1fr 1fr; gap:26px; }
  @media (max-width:720px) { .cols { grid-template-columns:1fr; } }
  .chart .hit { fill:transparent; }
  .chart .mark { outline:none; }
  .chart .mark:hover .bar, .chart .mark:focus .bar { fill:var(--barHi); }
  .chart .mark:focus-visible .bar { stroke:var(--fg); stroke-width:1.5; }
  /* Values lead, labels follow — the reader has the date and wants the number. */
  .tip { position:absolute; transform:translate(-50%,-100%); pointer-events:none;
         z-index:9; background:var(--fg); color:var(--bg); padding:5px 9px;
         border-radius:6px; font-size:12px; white-space:nowrap;
         box-shadow:0 4px 14px rgba(0,0,0,.22); }
  .tip b { font-size:14px; font-variant-numeric:tabular-nums; }
  .tip span { opacity:.72; margin-left:7px; }
  /* Hidden until the inline script decides the data is old. The hidden
     attribute does the work, so a browser with JS off shows nothing rather
     than a false alarm. */
  .stale { background:#fdf3d8; color:#5c4813; border:1px solid #e8d08a;
           border-radius:6px; padding:10px 14px; margin:0 0 20px; font-size:13px; }
  @media (prefers-color-scheme: dark) {
    .stale { background:#332b14; color:#f0dca8; border-color:#5c4b1d; }
  }
</style></head><body>
<h1>Agent Flow — reach</h1>
<div id="stale" class="stale" hidden></div>
<p class="since" id="freshness"${meta.lastRun ? ` data-last-run="${esc(meta.lastRun)}"` : ""}>${since}. Last run ${esc(String(meta.lastRun ?? "—").slice(0, 10))}.
Latest published version ${esc(latest?.openvsx?.version ?? "—")}.</p>

<div class="filters" role="group" aria-label="Date range">
  <span class="flabel">Range</span>
  <button type="button" data-range="all" aria-pressed="true" data-label="all time"${deltaAttrs(null)}>All time</button>
${presets.map(({ days, enabled }) => `  <button type="button" data-range="${days}" aria-pressed="false"`
  + ` data-label="the last ${days} days"${deltaAttrs(days)}`
  + `${enabled ? "" : ` disabled title="Only ${Object.keys(spine).length} days recorded so far"`}`
  + `>${days} days</button>`).join("\n")}
</div>

<div class="tiles">
  <div class="tile"><b>${fmt(latest?.openvsx?.downloads)}</b><span>Open VSX downloads</span><em data-delta="vsx">${esc(typeof allDelta === "string" ? allDelta : allDelta.vsx)}</em></div>
  <div class="tile"><b>${fmt(latest?.vsmarketplace?.downloads)}</b><span>VS Marketplace downloads</span><em data-delta="vsm">${esc(typeof allDelta === "string" ? allDelta : allDelta.vsm)}</em></div>
  <div class="tile"><b>${fmt(latest?.vsmarketplace?.installs)}</b><span>VS Marketplace installs</span></div>
  <div class="tile"><b data-tile="views">${fmt(total(views))}</b><span data-scope="Views">Views, all time</span></div>
  <div class="tile"><b data-tile="clones">${fmt(total(clones))}</b><span data-scope="Clones">Clones, all time</span></div>
  <div class="tile"><b>${fmt(stars.length)}</b><span>Stars</span></div>
</div>

<p class="note">Download counts include CI pulls, updates and repeat installs. They are
<strong>downloads</strong>, not people — and they are lifetime totals, so a date range
reports the change inside it rather than slicing the number.</p>

${thin ? '<p class="note">Not enough history to show a trend yet — this needs at least three daily samples.</p>' : ""}

${chartBlocks("views", "Daily views", views, presets)}

${chartBlocks("clones", "Daily clones", clones, presets)}

<div class="cols">
<div>${rankSection("Top referrers", "Referrer", referrers, (r) => r.referrer, "where GitHub says the views came from")}</div>
<div>${rankSection("Top paths", "Path", paths, (r) => r.title || r.path, "the pages those views landed on")}</div>
</div>

<script>
/* The page is regenerated only when the collector runs, so it cannot detect
   its own staleness at render time — a skipped cron leaves a page that is
   perfectly consistent and simply old. Reading the age in the *viewer's*
   browser is the only check that survives the collector not running at all,
   which is precisely the failure this is here to catch.

   The timestamp is read from a data attribute rather than interpolated into
   this script, so nothing from the store is ever parsed as code. */
(function () {
  var el = document.getElementById("freshness");
  var box = document.getElementById("stale");
  if (!el || !box) return;
  var last = Date.parse(el.getAttribute("data-last-run"));
  if (isNaN(last)) return;
  var days = Math.floor((Date.now() - last) / 86400000);
  if (days < 2) return;
  box.textContent = "\u26a0 This data is " + days + " days old. The collector runs daily, "
    + "so it has probably stopped \u2014 check the reach workflow.";
  box.hidden = false;
})();

/* The range filter. Every value it can show was computed at render time and
   parked on the element that reveals it — the block's own total, the button's
   own delta — so this does nothing but choose what is visible. There is no
   second copy of the data in the page and no arithmetic here that could
   disagree with the server's.

   With JS off the page is the all-time view, which is exactly what it was
   before the filter existed. */
(function () {
  var buttons = Array.prototype.slice.call(document.querySelectorAll("[data-range]"));
  if (!buttons.length) return;
  var fmt = function (n) { return Number(n).toLocaleString("en-US"); };

  function apply(button) {
    var key = button.getAttribute("data-range");
    var blocks = document.querySelectorAll("[data-view]");
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].hidden = blocks[i].getAttribute("data-view") !== key;
    }
    ["views", "clones"].forEach(function (metric) {
      var block = document.querySelector(
        '[data-view="' + key + '"][data-metric="' + metric + '"]');
      var tile = document.querySelector('[data-tile="' + metric + '"]');
      if (block && tile) tile.textContent = fmt(block.getAttribute("data-total"));
    });
    var label = button.getAttribute("data-label");
    var scopes = document.querySelectorAll("[data-scope]");
    for (var j = 0; j < scopes.length; j++) {
      scopes[j].textContent = scopes[j].getAttribute("data-scope") + ", " + label;
    }
    var deltas = document.querySelectorAll("[data-delta]");
    for (var k = 0; k < deltas.length; k++) {
      deltas[k].textContent =
        button.getAttribute("data-" + deltas[k].getAttribute("data-delta")) || "";
    }
  }

  // No guard for the disabled presets: a disabled button does not fire click,
  // so the disabled attribute is the protection and a JS check would be dead
  // code that no test could reach. The tests assert the attribute instead.
  buttons.forEach(function (b) {
    b.addEventListener("click", function () {
      buttons.forEach(function (o) { o.setAttribute("aria-pressed", String(o === b)); });
      apply(b);
    });
  });
})();
</script>
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
  // A corrupt snapshot must not cost the whole dashboard — the charts and
  // tiles are worth more than one day's ranking. Same tolerance the torn-line
  // case above gets, and the damaged file is left in place for repair.
  const snapshot = (kind) => {
    try {
      return readLatestSnapshot(dir, kind);
    } catch (e) {
      console.warn(`reach: skipped the ${kind} snapshot — ${e.message}`);
      return null;
    }
  };
  const html = renderDashboard({
    meta: readJson(dir, "meta.json", {}),
    referrers: snapshot("referrers"),
    paths: snapshot("paths"),
    views: readJson(dir, "traffic/views.json", {}),
    clones: readJson(dir, "traffic/clones.json", {}),
    stars: readJson(dir, "stars.json", []),
    marketplace,
  });
  fs.writeFileSync(out, html, "utf8");
  console.log(`reach: wrote ${out}`);
}
