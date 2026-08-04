import * as React from "react";
import { send } from "./vscodeApi";
import { fuzzyScore, phraseScore } from "../engine/fuzzy";
import { categoryLabel, orderSections, sectionKey, Section } from "../engine/sections";
import { AssetType, AssetView, ClaudeAssetsView, OutboundMessage, PluginRowView } from "../types";
import { FilePreview } from "./FilePreview";
import { PickerItem, PluginPicker } from "./PluginPicker";

let toastSeq = 0;

const CACHE_MAX = 50; // bodies, not bytes — a rescan clears the lot anyway

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
/** The order type blocks appear in when browsing, matching the pills. */
const TYPE_ORDER: Record<AssetType, number> = { skill: 0, command: 1, agent: 2, hook: 3 };

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
  plugin: string; // raw, for the plugin filter — `where` is a display string
  marketplace: string; // raw, for the marketplace filter
  category: string;
  readme: string; // plugin rows only; "" for assets
  enabled: boolean | null;
  state: AssetView["state"];
  file: string;
  rel: string;
  copy: string;
  extra: string[];
}

/** A row that survived the current query, carrying how well it matched. */
interface Scored extends Row {
  score: number;
}

const stateLabel: Record<AssetView["state"], string> = {
  installed: "installed",
  clone: "on disk",
  manifest: "not downloaded",
  user: "yours",
};

function assetRow(a: AssetView, i: number): Row {
  return {
    // Position in the scan, not the asset's fields: a plugin can register several
    // hooks sharing an event, matcher and file, and duplicate React keys orphan
    // DOM nodes that then survive every later filter change.
    key: `a${i}:${a.type}:${a.name}`,
    kind: "asset",
    type: a.type,
    name: a.name,
    display: a.type === "command" ? `/${a.name}` : a.name,
    description: a.description,
    where: `${a.plugin}${a.marketplace ? ` · ${a.marketplace}` : ""}`,
    plugin: a.plugin,
    marketplace: a.marketplace,
    category: a.category,
    readme: "",
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
    plugin: p.name,
    marketplace: p.marketplace,
    category: p.category,
    readme: p.readme,
    enabled: p.enabled,
    state: p.state,
    file: "",
    rel: "",
    copy: p.installCommand,
    extra: [...(p.version ? [`v${p.version}`] : []), ...p.scopes.map((s) => `${s} scope`), ...counts],
  };
}

/** Plugin identity for filtering. Names collide across marketplaces. */
const pluginKey = (r: { plugin: string; marketplace: string }): string => `${r.plugin}@${r.marketplace}`;

/** Split a selection key back apart. The separator is the FIRST "@": plugin names
 * are manifest identifiers, but a marketplace name can be a workspace folder name
 * and may contain one of its own. */
const splitPluginKey = (key: string): { name: string; marketplace: string } => {
  const at = key.indexOf("@");
  return { name: key.slice(0, at), marketplace: key.slice(at + 1) };
};

/** How well a row answers every term in the query, or null if it misses one.
 * The name carries the most weight, then the blurb, then where it came from — so
 * a skill named "deploy" outranks one that merely mentions deploying. Terms are
 * ANDed, which is what makes a second word narrow the list instead of widen it. */
function rowScore(r: Row, terms: string[]): number | null {
  const weigh = (s: number | null, k: number) => (s === null ? -Infinity : s * k);
  let total = 0;
  for (const t of terms) {
    const best = Math.max(
      weigh(fuzzyScore(t, r.display), 3),
      weigh(phraseScore(t, r.description), 1),
      weigh(phraseScore(t, r.where), 0.8),
    );
    if (best === -Infinity) return null;
    total += best;
  }
  return total;
}

function Pill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}>
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
  const [cat, setCat] = React.useState<string | null>(null);
  const [pluginSel, setPluginSel] = React.useState<string[]>([]);
  const [mktSel, setMktSel] = React.useState<string[]>([]);
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string }[]>([]);
  const [files, setFiles] = React.useState<Map<string, { text: string; truncated: boolean }>>(new Map());
  // Reads already in flight. Kept out of state so arrival doesn't re-trigger the
  // effect that asked for them.
  const asked = React.useRef(new Set<string>());

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      if (m.type === "mkt:assets") {
        setView(m.view);
        // A rescan may have found edited files; the old bodies are no longer true.
        setFiles(new Map());
        asked.current.clear();
      } else if (m.type === "mkt:file") {
        setFiles((prev) => {
          const next = new Map(prev);
          next.delete(m.file); // re-insert so Map order is least-recently-added first
          next.set(m.file, { text: m.text, truncated: m.truncated });
          while (next.size > CACHE_MAX) next.delete(next.keys().next().value as string);
          return next;
        });
      } else if (m.type === "mkt:loading") setLoading(m.loading);
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

  const terms = React.useMemo(() => q.trim().split(/\s+/).filter(Boolean), [q]);
  const searching = terms.length > 0;

  /** Query and scope are applied before the type filter, so the pills can tally
   * what the query actually leaves and the counts move as you type. `skip` drops
   * one dimension so a control can count the rows it would reveal rather than the
   * rows already surviving it. */
  const sift = React.useCallback(
    (base: Row[], skip: "category" | "plugin" | "" = ""): Scored[] => {
      const out: Scored[] = [];
      for (const r of base) {
        if (scope === "installed" && r.state !== "installed" && r.state !== "user") continue;
        if (scope === "enabled" && r.enabled === false) continue;
        if (skip !== "category" && cat && r.category !== cat) continue;
        if (skip !== "plugin" && pluginSel.length && !pluginSel.includes(pluginKey(r))) continue;
        if (mktSel.length && !mktSel.includes(r.marketplace)) continue;
        const score = searching ? rowScore(r, terms) : 0;
        if (score === null) continue;
        out.push({ ...r, score });
      }
      return out;
    },
    [terms, searching, scope, cat, pluginSel, mktSel],
  );

  const assetRows = React.useMemo(() => view.assets.map(assetRow), [view]);
  const pluginRows = React.useMemo(() => view.plugins.map(pluginRow), [view]);

  const assets = React.useMemo(() => sift(assetRows), [assetRows, sift]);
  const plugins = React.useMemo(() => sift(pluginRows), [pluginRows, sift]);
  const assetsNoCat = React.useMemo(() => sift(assetRows, "category"), [assetRows, sift]);
  const pluginsNoCat = React.useMemo(() => sift(pluginRows, "category"), [pluginRows, sift]);
  const assetsNoPlugin = React.useMemo(() => sift(assetRows, "plugin"), [assetRows, sift]);
  const pluginsNoPlugin = React.useMemo(() => sift(pluginRows, "plugin"), [pluginRows, sift]);

  const counts = React.useMemo(() => {
    const c: Record<AssetType, number> = { skill: 0, command: 0, agent: 0, hook: 0 };
    for (const r of assets) if (r.type) c[r.type]++;
    return c;
  }, [assets]);

  /** Rows of the active type, from a pair that has already been sifted. */
  const forType = React.useCallback(
    (a: Scored[], p: Scored[]): Scored[] =>
      type === "plugins" ? p : type === "all" ? a : a.filter((r) => r.type === type),
    [type],
  );

  // Counted against every dimension except the plugin one, so the numbers show
  // what checking a box would reveal. Already-selected plugins stay listed even at
  // zero — a selection must never be stranded out of reach of its own checkbox.
  const pickerItems: PickerItem[] = React.useMemo(() => {
    const by = new Map<string, PickerItem>();
    for (const r of forType(assetsNoPlugin, pluginsNoPlugin)) {
      const key = pluginKey(r);
      const at = by.get(key);
      if (at) at.count++;
      else by.set(key, { key, name: r.plugin, marketplace: r.marketplace, count: 1 });
    }
    for (const key of pluginSel) {
      if (by.has(key)) continue;
      const { name, marketplace } = splitPluginKey(key);
      by.set(key, { key, name, marketplace, count: 0 });
    }
    return [...by.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [assetsNoPlugin, pluginsNoPlugin, forType, pluginSel]);

  const togglePlugin = (key: string): void => {
    setPluginSel((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));
    setSel(0);
  };

  const toggleMkt = (name: string): void => {
    setMktSel((s) => (s.includes(name) ? s.filter((n) => n !== name) : [...s, name]));
    setSel(0);
  };

  // Sections count what they would reveal, so they exclude the category dimension
  // but honour every other one.
  const sections: Section[] = React.useMemo(
    () => (searching || cat ? [] : orderSections(forType(assetsNoCat, pluginsNoCat))),
    [assetsNoCat, pluginsNoCat, forType, searching, cat],
  );

  const rows = React.useMemo(() => {
    const picked = forType(assets, plugins);
    if (searching) return [...picked].sort((a, b) => b.score - a.score);
    // Section order first, then the old type order inside a section, so a block
    // still reads Skills → Commands → Agents → Hooks. Both sorts are stable, so
    // the scan's plugin-clustered order survives inside each run.
    // Rank is keyed the same way orderSections bucketed the rows (sectionKey), or
    // a row with a raw "" category misses the "uncategorized" entry and falls
    // through to rank 0 instead of pinning to the end.
    const rank = new Map(sections.map((s, i) => [s.category, i]));
    const byType = (r: Scored) => (r.type ? TYPE_ORDER[r.type] : 0);
    return [...picked].sort(
      (a, b) =>
        (rank.get(sectionKey(a.category)) ?? 0) - (rank.get(sectionKey(b.category)) ?? 0) || byType(a) - byType(b),
    );
  }, [assets, plugins, forType, searching, sections]);

  const index = Math.min(sel, rows.length - 1);
  const active = rows[index];
  const setFilter = (next: TypeFilter) => { setType(next); setSel(0); };

  // A plugin row has no source file of its own; its README is the closest thing.
  const previewFile = active ? (active.kind === "plugin" ? active.readme : active.file) : "";

  React.useEffect(() => {
    if (!previewFile || files.has(previewFile) || asked.current.has(previewFile)) return;
    asked.current.add(previewFile);
    send({ type: "mkt:read", file: previewFile });
  }, [previewFile, files]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { setSel((s) => Math.min(s + 1, rows.length - 1)); e.preventDefault(); }
    else if (e.key === "ArrowUp") { setSel((s) => Math.max(s - 1, 0)); e.preventDefault(); }
    else if (e.key === "Enter" && active?.file) send({ type: "mkt:open", file: active.file });
  };

  let lastCat: string | undefined;
  // Headers only when browsing: a search is ranked by relevance, so grouping it
  // would put a header above nearly every row. A focused category needs none —
  // the chip already says which one you are in.
  const grouped = !searching && !cat;

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
          <div className="seg" role="group" aria-label="Kind">
            <Pill on={type === "all"} onClick={() => setFilter("all")}>All<span className="n">{assets.length}</span></Pill>
            {TYPES.map((t) => (
              <Pill key={t.k} on={type === t.k} onClick={() => setFilter(t.k)}>
                {t.label}<span className="n">{counts[t.k]}</span>
              </Pill>
            ))}
            <Pill on={type === "plugins"} onClick={() => setFilter("plugins")}>
              Plugins<span className="n">{plugins.length}</span>
            </Pill>
          </div>
        </div>
        <div className="pills">
          <div className="seg" role="group" aria-label="Scope">
            <Pill on={scope === "all"} onClick={() => { setScope("all"); setSel(0); }}>Everywhere</Pill>
            <Pill on={scope === "installed"} onClick={() => { setScope("installed"); setSel(0); }}>Installed only</Pill>
            <Pill on={scope === "enabled"} onClick={() => { setScope("enabled"); setSel(0); }}>Enabled only</Pill>
          </div>
          <PluginPicker
            items={pickerItems}
            selected={pluginSel}
            onToggle={togglePlugin}
            onClear={() => { setPluginSel([]); setSel(0); }}
          />
        </div>
        {(cat || pluginSel.length > 0 || mktSel.length > 0) && (
          <div className="chips">
            {cat && (
              <button type="button" className="chip" onClick={() => { setCat(null); setSel(0); }}>
                {categoryLabel(cat)} ×
              </button>
            )}
            {pluginSel.map((k) => (
              <button key={k} type="button" className="chip" onClick={() => togglePlugin(k)}>
                {splitPluginKey(k).name} ×
              </button>
            ))}
            {mktSel.map((n) => (
              <button key={n} type="button" className="chip" onClick={() => toggleMkt(n)}>
                {n} ×
              </button>
            ))}
            <button
              type="button"
              className="chip clear"
              onClick={() => { setCat(null); setPluginSel([]); setMktSel([]); setSel(0); }}
            >
              Clear
            </button>
          </div>
        )}
        {view.marketplaces.length > 0 && (
          <div className="srcs">
            {view.marketplaces.map((m) => (
              <button
                key={`${m.name}:${m.origin}`}
                type="button"
                className={`tag${m.stale ? " bad" : ""}${mktSel.includes(m.name) ? " on" : ""}`}
                title={m.origin}
                onClick={() => toggleMkt(m.name)}
              >
                {m.stale ? `${m.name} — stale` : m.name}
              </button>
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
                // Bucket by sectionKey, not the raw category: a raw "" is falsy, so
                // comparing raw values would both miss the header (an empty head is
                // indistinguishable from "no header here") and could re-head every
                // uncategorized row if one ever sat next to a literal "uncategorized".
                const key = sectionKey(r.category);
                const head = grouped && key !== lastCat ? ((lastCat = key), key) : null;
                const section = head ? sections.find((s) => s.category === head) : null;
                return (
                  <React.Fragment key={r.key}>
                    {section && (
                      <button
                        type="button"
                        className="grouphd"
                        onClick={() => { setCat(section.category); setSel(0); }}
                      >
                        <span className="lb">{section.label}</span>
                        <span className="n">{section.count}</span>
                        <span className="rule" />
                      </button>
                    )}
                    <div className={`row t-${r.type ?? "plugin"}${i === index ? " on" : ""}`} onClick={() => setSel(i)}>
                      <span className="glyph">{r.type ? GLYPH[r.type] : "P"}</span>
                      <span className="body">
                        <span className="top">
                          <span className={`nm${r.type === "command" ? " mono" : ""}`}>{r.display}</span>
                          {r.kind === "asset" ? (
                            <>
                              {/* Plugin rows have no name to disambiguate — r.plugin equals
                                  r.display there, so the clickable button is asset-only. */}
                              <button
                                type="button"
                                className="meta link"
                                onClick={(e) => { e.stopPropagation(); togglePlugin(pluginKey(r)); }}
                              >
                                {r.plugin}
                              </button>
                              <span className="meta">· {r.marketplace}</span>
                            </>
                          ) : (
                            <span className="meta">{r.marketplace}</span>
                          )}
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
              <FilePreview
                file={previewFile}
                cached={files.get(previewFile)}
                fence={active.type === "hook" ? "json" : ""}
                onOpen={() => send({ type: "mkt:open", file: previewFile })}
              />
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
