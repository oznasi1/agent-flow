// Layer C: the verify-feature report. Reads Playwright's JSON results
// (test-results/e2e-results.json) and turns each E2E journey into an ordered
// strip of labelled screenshots with a verdict — the human-readable record
// that a feature ran in a real editor. Outputs:
//   test-results/verify-report.html  (self-contained; screenshots inlined)
//   test-results/verify-report.md    (for $GITHUB_STEP_SUMMARY)
// Always exits 0: the report is evidence, never the gate — the Playwright run
// itself already carried the exit code.
import * as fs from "fs";
import * as path from "path";

const RESULTS = "test-results/e2e-results.json";
const OUT_HTML = "test-results/verify-report.html";
const OUT_MD = "test-results/verify-report.md";

if (!fs.existsSync(RESULTS)) {
  console.error(`verify-report: ${RESULTS} not found — run npm run test:e2e first`);
  process.exit(0);
}
const data = JSON.parse(fs.readFileSync(RESULTS, "utf8"));

/** Flatten Playwright's nested suites into one row per test. */
function collect(suite, file, acc) {
  for (const child of suite.suites ?? []) collect(child, child.file ?? file, acc);
  for (const spec of suite.specs ?? []) {
    for (const t of spec.tests ?? []) {
      // The last result is the one that counted (earlier ones are retries).
      const r = (t.results ?? []).at(-1) ?? {};
      acc.push({
        file: spec.file ?? file,
        title: spec.title,
        ok: r.status === "passed",
        status: r.status ?? "unknown",
        ms: r.duration ?? 0,
        // Buffer attachments (testInfo.attach with body) arrive base64 in
        // `body`; file attachments arrive as `path`. Take either.
        shots: (r.attachments ?? []).filter((a) => a.contentType === "image/png" && (a.path || a.body)),
      });
    }
  }
  return acc;
}
const rows = (data.suites ?? []).flatMap((s) => collect(s, s.file, []));

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

const sections = rows
  .map((row) => {
    const strip = row.shots
      .map((a) => {
        const b64 = a.body ?? fs.readFileSync(a.path).toString("base64");
        return `<figure><img alt="${esc(a.name)}" src="data:image/png;base64,${b64}"><figcaption>${esc(a.name)}</figcaption></figure>`;
      })
      .join("\n");
    const badge = row.ok ? `<span class="badge ok">PASS</span>` : `<span class="badge fail">${esc(row.status.toUpperCase())}</span>`;
    return `<section>
<h2>${badge} ${esc(row.title)} <span class="meta">${esc(path.basename(row.file))} · ${secs(row.ms)}</span></h2>
${strip || "<p class='meta'>no step screenshots attached</p>"}
</section>`;
  })
  .join("\n");

const passed = rows.filter((r) => r.ok).length;
const stamp = data.stats?.startTime ?? new Date().toISOString();
const allOk = passed === rows.length;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify report — Agent Flow real-host E2E</title>
<style>
  :root{--bg:#f7f8fa;--panel:#fff;--ink:#1c2024;--muted:#5b6570;--line:#e5e8ec;--ok:#1a7f52;--ok-soft:#e6f4ec;--stop:#b0341d;--stop-soft:#fbe9e5}
  @media (prefers-color-scheme:dark){:root{--bg:#0f1216;--panel:#161a20;--ink:#e8ebee;--muted:#9aa4af;--line:#242a31;--ok:#5cc48d;--ok-soft:#132419;--stop:#e88872;--stop-soft:#2a1713}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1100px;margin:0 auto;padding:40px 24px 80px}
  h1{font-size:24px;letter-spacing:-.02em;margin:0 0 4px}
  .sub{color:var(--muted);margin:0 0 28px}
  section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:16px 0}
  h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .meta{color:var(--muted);font-weight:400;font-size:12.5px}
  .badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;letter-spacing:.03em}
  .badge.ok{background:var(--ok-soft);color:var(--ok)}
  .badge.fail{background:var(--stop-soft);color:var(--stop)}
  figure{display:inline-block;vertical-align:top;margin:0 12px 8px 0;max-width:340px}
  figure img{max-width:100%;border:1px solid var(--line);border-radius:8px;display:block}
  figcaption{font-size:12px;color:var(--muted);margin-top:5px}
</style>
</head>
<body><div class="wrap">
<h1>Verify report — real-host E2E</h1>
<p class="sub">${passed}/${rows.length} journeys passed · a real VS Code host, driven end to end · ${esc(stamp)}</p>
${sections}
</div></body>
</html>
`;

const md = [
  `## Real-host E2E — verify report`,
  ``,
  `${allOk ? "✅" : "❌"} **${passed}/${rows.length} journeys passed** (${esc(stamp)})`,
  ``,
  `| Journey | Verdict | Time | Steps shot |`,
  `|---|---|---|---|`,
  ...rows.map((r) => `| ${r.title} | ${r.ok ? "✅ pass" : `❌ ${r.status}`} | ${secs(r.ms)} | ${r.shots.length} |`),
  ``,
  `The screenshot-strip report is in the run's \`verify-report\` artifact.`,
].join("\n");

fs.writeFileSync(OUT_HTML, html);
fs.writeFileSync(OUT_MD, md);
console.log(`verify-report: ${passed}/${rows.length} passed → ${OUT_HTML} (${(html.length / 1024 / 1024).toFixed(1)}MB), ${OUT_MD}`);
