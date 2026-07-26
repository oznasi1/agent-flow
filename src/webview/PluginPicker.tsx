import * as React from "react";

export interface PickerItem {
  key: string; // `${plugin}@${marketplace}` — plugin names collide across marketplaces
  name: string;
  marketplace: string;
  count: number;
}

/** The multi-select over plugins. A dropdown rather than pills because three
 * hundred plugins is far past what a pill row can hold. */
export function PluginPicker({
  items,
  selected,
  onToggle,
  onClear,
}: {
  items: PickerItem[];
  selected: string[];
  onToggle: (key: string) => void;
  onClear: () => void;
}): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => i.name.toLowerCase().includes(needle)) : items;

  return (
    <div className="picker">
      <button type="button" className={`pill${selected.length ? " on" : ""}`} onClick={() => setOpen(!open)}>
        Plugins ▾{selected.length > 0 && <span className="n">{selected.length}</span>}
      </button>
      {open && (
        <div className="pop">
          <input
            className="pq"
            value={q}
            spellCheck={false}
            autoFocus
            placeholder="Filter plugins…"
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="plist">
            {shown.map((i) => (
              <label key={i.key} className="pitem">
                <input
                  type="checkbox"
                  // Same-named plugins from different marketplaces are a real case
                  // (it's why the selection key is `plugin@marketplace`) — fold the
                  // marketplace into the accessible name so they're distinguishable
                  // by screen reader too, not just by the visual `.pm` span.
                  aria-label={`${i.name} (${i.marketplace})`}
                  checked={selected.includes(i.key)}
                  onChange={() => onToggle(i.key)}
                />
                <span className="pn">{i.name}</span>
                <span className="pm">{i.marketplace}</span>
                <span className="n">{i.count}</span>
              </label>
            ))}
            {shown.length === 0 && <div className="pempty">No plugin matches “{q.trim()}”.</div>}
          </div>
          {selected.length > 0 && (
            <button type="button" className="btn pclear" onClick={onClear}>
              Clear {selected.length}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
