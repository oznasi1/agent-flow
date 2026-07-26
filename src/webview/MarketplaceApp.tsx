import * as React from "react";
import { send } from "./vscodeApi";
import { AssetType, AssetView, ClaudeAssetsView, OutboundMessage, PluginRowView } from "../types";

let toastSeq = 0;

const EMPTY: ClaudeAssetsView = { marketplaces: [], plugins: [], assets: [], notSetUp: false, scannedAt: 0 };
const TYPES: { k: AssetType; label: string; glyph: string }[] = [
  { k: "skill", label: "Skills", glyph: "S" },
  { k: "command", label: "Commands", glyph: "/" },
  { k: "agent", label: "Agents", glyph: "A" },
  { k: "hook", label: "Hooks", glyph: "H" },
];
const LABEL: Record<AssetType, string> = { skill: "Skills", command: "Commands", agent: "Agents", hook: "Hooks" };
const GLYPH: Record<AssetType, string> = { skill: "S", command: "/", agent: "A", hook: "H" };
const COUNT_KEY: Record<AssetType, AssetType> = { skill: "skill", command: "command", agent: "agent", hook: "hook" };

type TypeFilter = AssetType | "all" | "plugins";
type ScopeFilter = "all" | "installed" | "enabled";

/** One selectable thing — an asset, or a plugin under the Plugins filter. */
interface Row {
  key: string;
  kind: "asset" | "plugin";
  type: AssetType | null;
  name: string;
  display: string;
  description: string;
  where: string;
  enabled: boolean | null;
  state: AssetView["state"];
  file: string;
  rel: string;
  copy: string;
  extra: string[];
}

const stateLabel: Record<AssetView["state"], string> = {
  installed: "installed",
  clone: "on disk",
  manifest: "not downloaded",
  user: "yours",
};

function assetRow(a: AssetView): Row {
  return {
    key: `a:${a.type}:${a.marketplace}:${a.plugin}:${a.rel}:${a.name}`,
    kind: "asset",
    type: a.type,
    name: a.name,
    display: a.type === "command" ? `/${a.name}` : a.name,
    description: a.description,
    where: `${a.plugin}${a.marketplace ? ` · ${a.marketplace}` : ""}`,
    enabled: a.enabled,
    state: a.state,
    file: a.file,
    rel: a.rel,
    copy: a.type === "command" ? `/${a.name}` : a.name,
    extra: [LABEL[a.type].replace(/s$/, "")],
  };
}

function pluginRow(p: PluginRowView): Row {
  const counts = TYPES.filter((t) => p.counts[COUNT_KEY[t.k]] > 0).map((t) => `${t.glyph} ${p.counts[COUNT_KEY[t.k]]}`);
  return {
    key: `p:${p.marketplace}:${p.name}`,
    kind: "plugin",
    type: null,
    name: p.name,
    display: p.name,
    description: p.description,
    where: p.marketplace,
    enabled: p.enabled,
    state: p.state,
    file: "",
    rel: "",
    copy: p.installCommand,
    extra: [...(p.version ? [`v${p.version}`] : []), ...p.scopes.map((s) => `${s} scope`), ...counts],
  };
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button type="button" className={`pill${on ? " on" : ""}`} onClick={onClick}>
      {children}
    </button>
  );
}

export function MarketplaceApp(): JSX.Element {
  const [view, setView] = React.useState<ClaudeAssetsView>(EMPTY);
  const [loading, setLoading] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [type, setType] = React.useState<TypeFilter>("all");
  const [scope, setScope] = React.useState<ScopeFilter>("all");
  const [sel, setSel] = React.useState(0);
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string }[]>([]);

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "mkt:assets") setView(m.view);
      else if (m.type === "mkt:loading") setLoading(m.loading);
      else if (m.type === "toast") {
        const id = ++toastSeq;
        setToasts((t) => [...t.slice(-2), { id, level: m.level, message: m.message }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
      }
    };
    window.addEventListener("message", handler);
    send({ type: "mkt:ready" });
    return () => window.removeEventListener("message", handler);
  }, []);

  const counts = React.useMemo(() => {
    const c: Record<AssetType, number> = { skill: 0, command: 0, agent: 0, hook: 0 };
    for (const a of view.assets) c[a.type]++;
    return c;
  }, [view]);

  const rows = React.useMemo(() => {
    const base: Row[] = type === "plugins" ? view.plugins.map(pluginRow) : view.assets.map(assetRow);
    const needle = q.trim().toLowerCase();
    return base.filter((r) => {
      if (type !== "all" && type !== "plugins" && r.type !== type) return false;
      if (scope === "installed" && r.state !== "installed" && r.state !== "user") return false;
      if (scope === "enabled" && r.enabled === false) return false;
      if (!needle) return true;
      return `${r.name} ${r.description} ${r.where}`.toLowerCase().includes(needle);
    });
  }, [view, q, type, scope]);

  const index = Math.min(sel, rows.length - 1);
  const active = rows[index];
  const setFilter = (next: TypeFilter) => { setType(next); setSel(0); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { setSel((s) => Math.min(s + 1, rows.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setSel((s) => Math.max(s - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && active?.file) send({ type: "mkt:open", file: active.file });
  };

  let lastType: AssetType | null | undefined;

  return (
    <>
      <div className="hd">
        <div className="title">Marketplace<span className="sub">everything Claude Code can do on this machine</span></div>
        <span className="sp" />
        <button
          type="button"
          className="btn"
          onClick={() => send({ type: "mkt:copy", text: "/plugin marketplace add owner/repo" })}
        >
          + Add a marketplace
        </button>
        <button type="button" className="btn" onClick={() => send({ type: "mkt:refresh" })}>⟳ Rescan</button>
      </div>

      <div className="bar">
        <div className="search">
          <input
            value={q}
            spellCheck={false}
            autoFocus
            placeholder="Search skills, commands, agents, hooks…"
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="pills">
          <Pill on={type === "all"} onClick={() => setFilter("all")}>All<span className="n">{view.assets.length}</span></Pill>
          {TYPES.map((t) => (
            <Pill key={t.k} on={type === t.k} onClick={() => setFilter(t.k)}>
              {t.label}<span className="n">{counts[t.k]}</span>
            </Pill>
          ))}
          <Pill on={type === "plugins"} onClick={() => setFilter("plugins")}>
            Plugins<span className="n">{view.plugins.length}</span>
          </Pill>
        </div>
        <div className="pills">
          <Pill on={scope === "all"} onClick={() => { setScope("all"); setSel(0); }}>Everywhere</Pill>
          <Pill on={scope === "installed"} onClick={() => { setScope("installed"); setSel(0); }}>Installed only</Pill>
          <Pill on={scope === "enabled"} onClick={() => { setScope("enabled"); setSel(0); }}>Enabled only</Pill>
        </div>
        {view.marketplaces.length > 0 && (
          <div className="srcs">
            {view.marketplaces.map((m) => (
              <span key={`${m.name}:${m.origin}`} className={`tag${m.stale ? " bad" : ""}`} title={m.origin}>
                {m.stale ? `${m.name} — stale` : m.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {loading && <div className="loading">Scanning ~/.claude…</div>}

      {view.notSetUp ? (
        <div className="empty">
          <div className="big">Claude Code isn't set up on this machine yet</div>
          <div>
            Nothing was found under <code>~/.claude/plugins</code>. Add a marketplace in Claude Code and its
            plugins, skills and commands will show up here.
          </div>
        </div>
      ) : (
        <div className="split">
          <div className="results">
            {rows.length === 0 ? (
              <div className="empty">
                <div className="big">Nothing matches{q.trim() ? ` “${q.trim()}”` : ""}</div>
                <div>Try a shorter word, or clear the filters.</div>
              </div>
            ) : (
              rows.map((r, i) => {
                const head = type === "all" && r.type !== lastType ? ((lastType = r.type), r.type) : null;
                return (
                  <React.Fragment key={r.key}>
                    {head && (
                      <div className="grouphd">
                        <span className="lb">{LABEL[head]}</span>
                        <span className="rule" />
                      </div>
                    )}
                    <div className={`row t-${r.type ?? "plugin"}${i === index ? " on" : ""}`} onClick={() => setSel(i)}>
                      <span className="glyph">{r.type ? GLYPH[r.type] : "P"}</span>
                      <span className="body">
                        <span className="top">
                          <span className={`nm${r.type === "command" ? " mono" : ""}`}>{r.display}</span>
                          <span className="meta">{r.where}</span>
                          {r.enabled === false && <span className="tag off">disabled</span>}
                          {r.kind === "plugin" && <span className="tag dim">{stateLabel[r.state]}</span>}
                        </span>
                        {r.description && <span className="ds">{r.description}</span>}
                      </span>
                    </div>
                  </React.Fragment>
                );
              })
            )}
          </div>

          {active && (
            <div className="detail">
              <div className={`dh t-${active.type ?? "plugin"}`}>
                <span className="glyph">{active.type ? GLYPH[active.type] : "P"}</span>
                <span className="dn">{active.display}</span>
              </div>
              <div className="tags">
                <span className="tag">{stateLabel[active.state]}</span>
                {active.enabled === false && <span className="tag off">disabled</span>}
                {active.enabled === true && <span className="tag ok">enabled</span>}
                {active.extra.map((x) => <span key={x} className="tag">{x}</span>)}
              </div>
              <div className="dd">{active.description || "No description in the frontmatter."}</div>
              <dl className="kv">
                <dt>Where</dt>
                <dd>{active.where}</dd>
                {active.rel && (
                  <>
                    <dt>File</dt>
                    <dd>{active.rel}</dd>
                  </>
                )}
              </dl>
              {active.copy && (
                <div className="snip">
                  <pre>{active.copy}</pre>
                  <button type="button" className="btn cp" onClick={() => send({ type: "mkt:copy", text: active.copy })}>
                    Copy
                  </button>
                </div>
              )}
              {active.file && (
                <div className="acts">
                  <button type="button" className="btn pri" onClick={() => send({ type: "mkt:open", file: active.file })}>
                    Open file
                  </button>
                  <button type="button" className="btn" onClick={() => send({ type: "mkt:reveal", file: active.file })}>
                    Reveal in Finder
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.level}`}>{t.message}</div>)}
      </div>
    </>
  );
}
