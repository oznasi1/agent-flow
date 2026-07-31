/**
 * The board: a split master–detail page, served as one self-contained document.
 * Coverage-excluded like the other markup modules — its behaviour is verified by
 * the route tests and by manual review, not by asserting on strings.
 */
export function boardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent Flow · Company</title>
<style>
  :root {
    --bg: #ffffff; --panel: #f6f7f9; --line: #d8dce3; --text: #14171c;
    --dim: #5d6572; --accent: #2f6feb; --fail: #c0392b; --ok: #1e7f4f;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171c; --panel: #1b1f26; --line: #2b313b; --text: #e6e9ef;
      --dim: #98a1b0; --accent: #6a9bff; --fail: #e56a5c; --ok: #56c48d;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: var(--bg); color: var(--text); }
  header { display: flex; align-items: center; gap: 12px; padding: 10px 14px;
           border-bottom: 1px solid var(--line); background: var(--panel); }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; }
  .spacer { flex: 1; }
  .pill { font-size: 12px; color: var(--dim); border: 1px solid var(--line);
          border-radius: 99px; padding: 2px 9px; }
  button { font: inherit; padding: 5px 12px; border: 1px solid var(--line);
           border-radius: 6px; background: var(--bg); color: var(--text); cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  main { display: flex; height: calc(100vh - 49px); }
  #list { width: 300px; border-right: 1px solid var(--line); overflow-y: auto; }
  #list .row { padding: 9px 12px; border-bottom: 1px solid var(--line); cursor: pointer; }
  #list .row:hover { background: var(--panel); }
  #list .row[aria-selected="true"] { background: var(--panel); box-shadow: inset 2px 0 0 var(--accent); }
  #list .role { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); }
  #list .t { display: block; margin-top: 2px; }
  #detail { flex: 1; overflow-y: auto; padding: 18px 22px; }
  #detail h2 { font-size: 17px; margin: 0 0 6px; }
  .why { color: var(--dim); margin: 0 0 14px; }
  .meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .art { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-bottom: 16px; }
  .art .head { padding: 6px 10px; background: var(--panel); border-bottom: 1px solid var(--line);
               font-size: 12px; color: var(--dim); }
  .art pre { margin: 0; padding: 11px; overflow-x: auto; font-family: var(--mono); font-size: 12.5px; }
  .art iframe { width: 100%; height: 460px; border: 0; background: #fff; }
  .post { padding: 14px 16px; max-width: 34em; white-space: pre-wrap; }
  .d-add { color: var(--ok); } .d-del { color: var(--fail); } .d-hunk { color: var(--dim); }
  .checks { font-family: var(--mono); font-size: 12px; color: var(--dim); margin-bottom: 14px; }
  .acts { display: flex; gap: 8px; align-items: center; }
  .kbd { font-family: var(--mono); font-size: 11px; color: var(--dim); }
  textarea { width: 100%; min-height: 74px; margin: 10px 0; padding: 8px; font: inherit;
             background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; }
  .hidden { display: none; }
  .strip { border-top: 1px solid var(--line); padding: 10px 12px; }
  .strip h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
              color: var(--dim); margin: 0 0 6px; }
  .strip .l { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; font-size: 13px; }
  .quar { color: var(--fail); }
  .empty { color: var(--dim); padding: 26px 0; }
</style>
</head>
<body>
<header>
  <h1>Agent Flow · Company</h1>
  <span class="pill" id="count">…</span>
  <span class="pill" id="cycle"></span>
  <span class="spacer"></span>
  <button id="runBtn">Run a cycle</button>
  <button id="pauseBtn">…</button>
</header>
<main>
  <div id="list"></div>
  <div id="detail"><p class="empty">Loading…</p></div>
</main>
<script>
const KEY = new URLSearchParams(location.search).get("key") || "";
let state = { pending: [], landed: [], quarantined: [], paused: false, lastCycle: null };
let sel = 0;

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

async function api(path, opts) {
  const glue = path.includes("?") ? "&" : "?";
  const res = await fetch(path + glue + "key=" + encodeURIComponent(KEY), opts);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function load() {
  const { body } = await api("/api/queue");
  state = body;
  if (sel >= state.pending.length) sel = Math.max(0, state.pending.length - 1);
  render();
}

function renderDiff(text) {
  return text.split("\\n").map(l => {
    const c = l.startsWith("+++") || l.startsWith("---") ? "d-hunk"
      : l.startsWith("@@") ? "d-hunk"
      : l.startsWith("+") ? "d-add"
      : l.startsWith("-") ? "d-del" : "";
    return '<span class="' + c + '">' + esc(l) + "</span>";
  }).join("\\n");
}

function renderMarkdown(text) {
  return esc(text)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h2>$1</h2>")
    .replace(/^- (.*)$/gm, "• $1")
    .replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")
    .replace(/\`(.+?)\`/g, '<code>$1</code>');
}

function renderList() {
  const list = document.getElementById("list");
  if (state.pending.length === 0 && state.quarantined.length === 0) {
    list.innerHTML = '<p class="empty" style="padding:14px">Nothing waiting on you.</p>';
  } else {
    list.innerHTML = state.pending.map((it, i) =>
      '<div class="row" data-i="' + i + '" aria-selected="' + (i === sel) + '">' +
      '<span class="role">' + esc(it.role.replace(/^company-/, "")) + "</span>" +
      '<span class="t">' + esc(it.title) + "</span></div>").join("");
  }
  if (state.quarantined.length > 0) {
    list.innerHTML += '<div class="strip"><h3>Could not be read</h3>' +
      state.quarantined.map(q =>
        '<div class="l quar">' + esc(q.file) + " — " + esc(q.error) + "</div>").join("") + "</div>";
  }
  if (state.landed.length > 0) {
    list.innerHTML += '<div class="strip"><h3>Landed on its own</h3>' +
      state.landed.map(r =>
        '<div class="l"><span>' + esc(r.title) + "</span>" +
        '<span class="spacer"></span><span class="kbd">' + esc(r.sha.slice(0, 7)) + "</span>" +
        '<button data-undo="' + esc(r.id) + '">Undo</button></div>').join("") + "</div>";
  }
  list.querySelectorAll("[data-i]").forEach(el =>
    el.onclick = () => { sel = Number(el.dataset.i); render(); });
  list.querySelectorAll("[data-undo]").forEach(el =>
    el.onclick = async () => {
      if (!confirm("Revert this commit?")) return;
      const { body } = await api("/api/undo", { method: "POST", body: JSON.stringify({ id: el.dataset.undo }) });
      if (!body.ok) alert(body.detail || body.error || "revert failed");
      load();
    });
}

async function renderDetail() {
  const d = document.getElementById("detail");
  const it = state.pending[sel];
  if (!it) { d.innerHTML = '<p class="empty">Nothing selected.</p>'; return; }

  const checks = it.checks
    ? '<div class="checks">' + Object.entries(it.checks)
        .map(([k, v]) => esc(k) + ": " + esc(v)).join(" · ") + "</div>"
    : "";

  d.innerHTML =
    "<h2>" + esc(it.title) + "</h2>" +
    '<p class="why">' + esc(it.why) + "</p>" +
    '<div class="meta"><span class="pill">' + esc(it.kind) + "</span>" +
      '<span class="pill">' + esc(it.role.replace(/^company-/, "")) + "</span>" +
      (it.branch ? '<span class="pill kbd">' + esc(it.branch) + "</span>" : "") +
      '<span class="pill">on approve: ' + esc(it.on_approve) + "</span></div>" +
    checks +
    '<div class="art" id="art"><div class="head">loading artifact…</div></div>' +
    '<textarea id="note" class="hidden" placeholder="What should change, and why"></textarea>' +
    '<div class="acts">' +
      '<button class="primary" id="ap">Approve</button>' +
      '<button id="rv">Revise…</button>' +
      '<button id="rj">Reject</button>' +
      '<span class="spacer"></span><span class="kbd">j k · a · v · r</span>' +
    "</div>";

  document.getElementById("ap").onclick = () => decide("approve");
  document.getElementById("rj").onclick = () => decide("reject");
  document.getElementById("rv").onclick = () => {
    const note = document.getElementById("note");
    if (note.classList.contains("hidden")) { note.classList.remove("hidden"); note.focus(); }
    else decide("revise");
  };

  const { status, body } = await api("/api/artifact?id=" + encodeURIComponent(it.id));
  const art = document.getElementById("art");
  if (status !== 200) {
    art.innerHTML = '<div class="head quar">' + esc(body.error || "could not read the artifact") + "</div>";
    return;
  }
  const head = '<div class="head">' + esc(body.type) +
    (body.truncated ? " · truncated" : "") + "</div>";
  if (body.type === "html") {
    art.innerHTML = head + '<iframe sandbox="" srcdoc="' + esc(body.content) + '"></iframe>';
  } else if (body.type === "diff") {
    art.innerHTML = head + "<pre>" + renderDiff(body.content) + "</pre>";
  } else if (body.type === "markdown") {
    art.innerHTML = head + '<div class="post">' + renderMarkdown(body.content) + "</div>";
  } else {
    art.innerHTML = head + '<div class="post">' + esc(body.content) + "</div>";
  }
}

async function decide(verdict) {
  const it = state.pending[sel];
  if (!it) return;
  const noteEl = document.getElementById("note");
  const note = noteEl ? noteEl.value : "";
  if (verdict === "revise" && note.trim() === "") { noteEl.focus(); return; }
  const { status, body } = await api("/api/decision", {
    method: "POST",
    body: JSON.stringify({ id: it.id, verdict, note }),
  });
  if (status !== 200) { alert(body.error || "could not record that"); return; }
  load();
}

function render() {
  document.getElementById("count").textContent = state.pending.length + " pending";
  document.getElementById("cycle").textContent = state.lastCycle || "no cycle yet";
  const pb = document.getElementById("pauseBtn");
  pb.textContent = state.paused ? "Paused — resume" : "Pause";
  pb.className = state.paused ? "primary" : "";
  document.getElementById("runBtn").disabled = state.paused;
  renderList();
  renderDetail();
}

document.getElementById("pauseBtn").onclick = async () => {
  await api("/api/pause", { method: "POST", body: JSON.stringify({ paused: !state.paused }) });
  load();
};
document.getElementById("runBtn").onclick = async () => {
  const { body } = await api("/api/cycle", { method: "POST", body: JSON.stringify({ mode: "full" }) });
  alert(body.detail || body.error || "started");
  load();
};

document.addEventListener("keydown", e => {
  if (e.target.tagName === "TEXTAREA") {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) decide("revise");
    return;
  }
  if (e.key === "j" && sel < state.pending.length - 1) { sel++; render(); }
  else if (e.key === "k" && sel > 0) { sel--; render(); }
  else if (e.key === "a") decide("approve");
  else if (e.key === "r") decide("reject");
  else if (e.key === "v") document.getElementById("rv").click();
});

load();
setInterval(load, 30000);
</script>
</body>
</html>`;
}
