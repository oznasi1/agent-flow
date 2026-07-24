import * as React from "react";
import { send } from "./vscodeApi";
import { OutboundMessage, MarketplaceView, PluginView, SkillRef } from "../types";

let toastSeq = 0;

function ChipRow({ label, icon, items }: { label: string; icon: string; items: SkillRef[] }): JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div className="chiprow">
      <span className="chiprow-l">{icon} {label}</span>
      <span className="chips">
        {items.map((it) => <span key={it.path} className="chip" title={it.path}>{it.name}</span>)}
      </span>
    </div>
  );
}

function Plugin({ p, addCommand }: { p: PluginView; addCommand: string }): JSX.Element {
  const snippet = `${addCommand}\n${p.installCommand}`;
  return (
    <div className="plugin">
      <div className="plugin-hd">
        <span className="plugin-nm">{p.name}</span>
      </div>
      {p.description && <div className="plugin-desc">{p.description}</div>}
      <ChipRow label="Skills" icon="🧩" items={p.skills} />
      <ChipRow label="Agents" icon="🤖" items={p.agents} />
      <ChipRow label="Commands" icon="⌘" items={p.commands} />
      <div className="snippet">
        <pre>{snippet}</pre>
        <button className="copy" onClick={() => send({ type: "mkt:copy", text: snippet })}>📋 Copy</button>
      </div>
    </div>
  );
}

function Market({ m }: { m: MarketplaceView }): JSX.Element {
  return (
    <section className="mkt">
      <div className="mkt-hd">
        <span className="mkt-nm">{m.name}</span>
        <a className="mkt-repo" href={`https://github.com/${m.repo}`}>{m.repo}</a>
        {!m.error && <span className="mkt-ct">{m.plugins.length} plugin{m.plugins.length === 1 ? "" : "s"}</span>}
        <span className="sp" />
        <span className="mkt-x" title={`Remove ${m.repo}`} onClick={() => send({ type: "mkt:remove", repo: m.repo })}>×</span>
      </div>
      {m.description && !m.error && <div className="mkt-desc">{m.description}</div>}
      {m.error ? (
        <div className="mkt-err">{m.error.message}</div>
      ) : m.plugins.length === 0 ? (
        <div className="mkt-err">No plugins listed in this marketplace.</div>
      ) : (
        <div className="plugins">{m.plugins.map((p) => <Plugin key={p.name} p={p} addCommand={m.addCommand} />)}</div>
      )}
    </section>
  );
}

export function MarketplaceApp(): JSX.Element {
  const [markets, setMarkets] = React.useState<MarketplaceView[]>([]);
  const [ready, setReady] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string }[]>([]);

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "mkt:state") { setMarkets(m.marketplaces); setReady(true); }
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

  const add = () => {
    const v = input.trim();
    if (!v) return;
    send({ type: "mkt:add", repo: v });
    setInput("");
  };

  return (
    <>
      <div className="hd">
        <div className="title">Marketplace<span className="sub">Claude Code plugins & skills</span></div>
        <span className="sp" />
        <div className="add">
          <input
            value={input}
            spellCheck={false}
            placeholder="owner/repo or github.com URL…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
          />
          <button className="btn" onClick={add}>+ Add</button>
        </div>
        <button className="btn ghost" onClick={() => send({ type: "mkt:refresh" })}>⟳ Refresh</button>
      </div>

      <details className="how">
        <summary>How it works</summary>
        <div className="how-body">
          A marketplace is a GitHub repo of Claude Code plugins. Add one above, then install its
          plugins from Claude Code:
          <pre>/plugin marketplace add owner/repo{"\n"}/plugin install &lt;plugin&gt;@&lt;marketplace&gt;</pre>
        </div>
      </details>

      {loading && <div className="loading">Loading…</div>}

      {ready && markets.length === 0 ? (
        <div className="empty">
          <div className="big">No marketplaces yet</div>
          <div>Add a GitHub plugin-marketplace repo above to browse its plugins and skills.</div>
        </div>
      ) : (
        <div className="list">{markets.map((m) => <Market key={m.repo} m={m} />)}</div>
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.level}`}>{t.message}</div>)}
      </div>
    </>
  );
}
