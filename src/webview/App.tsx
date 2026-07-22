import * as React from "react";
import { send } from "./vscodeApi";
import { deriveStatuses, fmtEst, isPrReviewStatus, matchesStatus, moveKey, prioClass } from "./helpers";
import { Filter, FilterVisibility, JiraTask, OutboundMessage, Size } from "../types";

let toastSeq = 0;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "mysprint", label: "My sprint" },
  { id: "mine", label: "Mine" },
  { id: "sprint", label: "Sprint" },
  { id: "backlog", label: "Backlog" },
  { id: "unassigned", label: "Unassigned" },
];

const SIZES: { id: Size; label: string; title: string }[] = [
  { id: "any", label: "Any", title: "Any estimate" },
  { id: "s", label: "S", title: "≤ 4h" },
  { id: "m", label: "M", title: "4h – 2d" },
  { id: "l", label: "L", title: "> 2d" },
];

interface DetailState {
  loading: boolean;
  descriptionText?: string;
  repos?: string[];
  selected?: string[];
}

interface CardDnd {
  onBegin: () => void;
  onHover: (pos: "before" | "after") => void;
  onDrop: (pos: "before" | "after") => void;
  onEnd: () => void;
  dragging: boolean;
  hint: "before" | "after" | null;
}

const PlayIcon = () => (
  <svg className="take-icon" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M7 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 7 5.5z" />
  </svg>
);

const SearchIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M11.74 10.3a5 5 0 1 0-1.44 1.44l3 3 1.44-1.44-3-3zM3.5 7a3.5 3.5 0 1 1 7 0 3.5 3.5 0 0 1-7 0z"
    />
  </svg>
);

// A sprint flag with a "+" badge — "add this to my sprint".
const SprintAddIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M3 1.4a.7.7 0 0 1 1.4 0V14.6a.7.7 0 0 1-1.4 0z" />
    <path fill="currentColor" d="M5 2.3h6.4L10.1 4.7l1.3 2.4H5z" />
    <path fill="currentColor" d="M11.3 8.6h1.3v2h2v1.3h-2v2h-1.3v-2h-2v-1.3h2z" />
  </svg>
);

// A git pull-request glyph — kick off the PR-review agent for an approved/initiated PR.
const AddressPrIcon = () => (
  <svg className="take-icon" width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
    <path
      fill="currentColor"
      d="M3.5 1a2 2 0 0 0-.75 3.85V11.15a2 2 0 1 0 1.5 0V4.85A2 2 0 0 0 3.5 1zm0 11.25a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zm0-9.75a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5zM12.5 11.15V6.5a2.5 2.5 0 0 0-2.5-2.5H9.1l1.2-1.2L9.4 2 6.8 4.6l2.6 2.6.9-.9-1.2-1.2H10a1 1 0 0 1 1 1v4.65a2 2 0 1 0 1.5 0zM11.75 14a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5z"
    />
  </svg>
);

// A compass — free-form "explore" (not attached to a task).
const CompassIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
    <path fill="currentColor" d="M16.5 7.5l-2.1 5.2-5.2 2.1 2.1-5.2z" />
  </svg>
);

export function App(): JSX.Element {
  const [authed, setAuthed] = React.useState<boolean | null>(null);
  const [configured, setConfigured] = React.useState(true); // assume yes until told otherwise (no setup-flash)
  const [error, setError] = React.useState<{ message: string; canRetry: boolean } | null>(null);
  const [project, setProject] = React.useState("");
  const [me, setMe] = React.useState<string | null>(null);
  // The task status that reveals the "Address PR" card action (configurable; from the host).
  const [prReviewStatus, setPrReviewStatus] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("mysprint");
  const [size, setSize] = React.useState<Size>("any");
  // Which secondary filter controls are shown (from settings, via the host). All
  // shown until the host says otherwise — nothing flashes hidden on first paint.
  const [filters, setFilters] = React.useState<FilterVisibility>({ size: true, status: true, repo: true, search: true });
  // Client-side status lens: the set of selected statuses (empty = show all).
  const [statuses, setStatuses] = React.useState<Set<string>>(new Set());
  const [repoQuery, setRepoQuery] = React.useState("");
  const [tasks, setTasks] = React.useState<JiraTask[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [toasts, setToasts] = React.useState<{ id: number; level: string; message: string }[]>([]);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [details, setDetails] = React.useState<Record<string, DetailState>>({});
  const [dragKey, setDragKey] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ key: string; pos: "before" | "after" } | null>(null);
  const dragKeyRef = React.useRef<string | null>(null);
  const tasksRef = React.useRef<JiraTask[]>([]);
  React.useEffect(() => { tasksRef.current = tasks; }, [tasks]);

  const endDrag = () => { dragKeyRef.current = null; setDragKey(null); setDropTarget(null); };
  const beginDrag = (key: string) => { dragKeyRef.current = key; setDragKey(key); };
  const commitDrop = (targetKey: string, pos: "before" | "after") => {
    const dk = dragKeyRef.current;
    if (dk && dk !== targetKey) {
      const next = moveKey(tasksRef.current, dk, targetKey, pos);
      setTasks(next);
      send({ type: "reorder", order: next.map((t) => t.key) });
    }
    endDrag();
  };

  // Watchdog: if the host never answers our `ready` (extension failed to activate,
  // a handler threw before replying), don't sit on a blank/"connecting" panel forever
  // — surface it so the user knows something is wrong and can retry.
  const gotState = React.useRef(false);
  const watchdog = React.useRef<number | null>(null);
  const armWatchdog = React.useCallback(() => {
    if (watchdog.current != null) window.clearTimeout(watchdog.current);
    gotState.current = false;
    watchdog.current = window.setTimeout(() => {
      if (!gotState.current) {
        setError({
          message: "Agent Flow isn't responding. Open the “Agent Flow” output channel for details, or reload the window.",
          canRetry: true,
        });
      }
    }, 18000); // longer than the host's 15s request timeout, so a real error wins first
  }, []);

  React.useEffect(() => {
    const handler = (ev: MessageEvent<OutboundMessage>) => {
      const m = ev.data;
      gotState.current = true; // any message means the host is alive — stand down the watchdog
      switch (m.type) {
        case "state":
          setError(null);
          setAuthed(m.authed);
          setConfigured(m.configured);
          setProject(m.project);
          setMe(m.me);
          setPrReviewStatus(m.prReviewStatus);
          setFilters(m.filters);
          break;
        case "error":
          setLoading(false);
          setError({ message: m.message, canRetry: m.canRetry });
          break;
        case "tasks":
          setError(null);
          setFilter(m.filter);
          setTasks(m.tasks);
          setExpanded(new Set());
          // Drop status selections that no longer exist in the fresh pool — otherwise
          // a selected status with no chip would silently hide everything.
          setStatuses((prev) => {
            if (prev.size === 0) return prev;
            const present = new Set(m.tasks.map((t) => t.status));
            const kept = [...prev].filter((s) => present.has(s));
            return kept.length === prev.size ? prev : new Set(kept);
          });
          break;
        case "detail":
          setDetails((prev) => ({
            ...prev,
            [m.key]: { loading: false, descriptionText: m.descriptionText, repos: m.repos, selected: m.inferred },
          }));
          break;
        case "statusChanged":
          setTasks((prev) =>
            m.removed
              ? prev.filter((t) => t.key !== m.key)
              : prev.map((t) => (t.key === m.key ? { ...t, status: m.status, statusCategory: m.category } : t)),
          );
          break;
        case "movedToSprint":
          setTasks((prev) =>
            m.removed
              ? prev.filter((t) => t.key !== m.key)
              : prev.map((t) => (t.key === m.key ? { ...t, assignee: m.assignee, inOpenSprint: true } : t)),
          );
          break;
        case "loading":
          setLoading(m.loading);
          break;
        case "toast": {
          const id = ++toastSeq;
          setToasts((t) => [...t.slice(-2), { id, level: m.level, message: m.message }]);
          setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
          break;
        }
      }
    };
    window.addEventListener("message", handler);
    send({ type: "ready" });
    armWatchdog();
    return () => {
      window.removeEventListener("message", handler);
      if (watchdog.current != null) window.clearTimeout(watchdog.current);
    };
  }, [armWatchdog]);

  const retry = () => {
    setError(null);
    armWatchdog();
    send({ type: "retry" });
  };

  const refetch = (f: Filter, s: Size) => {
    setFilter(f);
    setSize(s);
    send({ type: "fetch", filter: f, size: s });
  };

  const toggleExpand = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        if (!details[key]) {
          setDetails((d) => ({ ...d, [key]: { loading: true } }));
          send({ type: "detail", key });
        }
      }
      return next;
    });
  };

  const setSelected = (key: string, selected: string[]) =>
    setDetails((prev) => ({ ...prev, [key]: { ...prev[key], selected } }));

  // Status lens chips, derived from the loaded pool (adapts to the project's workflow).
  const availableStatuses = React.useMemo(() => deriveStatuses(tasks), [tasks]);
  const toggleStatus = (name: string) =>
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // Narrow the current pool to tasks touching a repo (matches the inferred service chips)
  // and, if a status lens is active, to the selected statuses.
  const q = repoQuery.trim().toLowerCase();
  const visibleTasks = tasks.filter(
    (t) =>
      (!q || (t.services ?? []).some((s) => s.toLowerCase().includes(q))) && matchesStatus(t, statuses),
  );
  // Reorder only makes sense on the full My-sprint list, not a filtered subset.
  const canReorder = filter === "mysprint" && !q && statuses.size === 0;

  // Toasts float over every state (gate or list), so keep them out of the branch bodies.
  const toastStack = <ToastStack toasts={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />;
  const gate = (content: JSX.Element): JSX.Element => (
    <>{content}{toastStack}</>
  );

  // Persistent, actionable failure — shown instead of a vanishing toast.
  if (error) {
    return gate(
      <div className="gate">
        <div className="gate-error">⚠ {error.message}</div>
        {error.canRetry && <button className="btn" onClick={retry}>Retry</button>}
      </div>,
    );
  }

  // Handshake in flight (or the host never replied — the watchdog turns this into an
  // error above). Never a blank panel.
  if (authed === null) {
    return gate(<div className="gate"><div>Connecting to Jira…</div></div>);
  }

  // Never set up: no Jira site URL / project key yet.
  if (!configured) {
    return gate(
      <div className="gate">
        <div>Agent Flow isn't connected to Jira yet — add your site URL and project to get started.</div>
        <button className="btn" onClick={() => send({ type: "runSetup" })}>Run setup</button>
      </div>,
    );
  }

  if (authed === false) {
    return gate(
      <div className="gate">
        <div>Connect Agent Flow to your Jira to see your task pool.</div>
        <button className="btn" onClick={() => send({ type: "signIn" })}>Sign in to Jira</button>
      </div>,
    );
  }

  return (
    <div>
      <div className="header">
        <span className="title">📋 {project || "Tasks"}</span>
        <button
          className="explore"
          onClick={() => send({ type: "explore" })}
          title="Explore repos with a Claude Code agent — pick repos, no ticket needed"
        >
          <CompassIcon /> Explore
        </button>
        {me && <span className="me">{me}</span>}
      </div>

      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f.id} className={`tab${filter === f.id ? " active" : ""}`} onClick={() => refetch(f.id, size)}>
            {f.label}
          </button>
        ))}
      </div>

      {filters.size && (
        <div className="sizes">
          <span className="sizes-label">Size</span>
          {SIZES.map((s) => (
            <button
              key={s.id}
              className={`size-chip${size === s.id ? " active" : ""}`}
              title={s.title}
              onClick={() => refetch(filter, s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {filters.status && availableStatuses.length > 0 && (
        <div className="statuses">
          <span className="statuses-label">Status</span>
          <button
            className={`status-chip${statuses.size === 0 ? " active" : ""}`}
            title="Any status"
            onClick={() => setStatuses(new Set())}
          >
            All
          </button>
          {availableStatuses.map((s) => (
            <button
              key={s.name}
              className={`status-chip${statuses.has(s.name) ? " active" : ""}`}
              onClick={() => toggleStatus(s.name)}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {filters.repo && (
        <div className="repo-filter">
          <SearchIcon />
          <input
            value={repoQuery}
            spellCheck={false}
            placeholder="Filter by repo…"
            onChange={(e) => setRepoQuery(e.target.value)}
          />
          {repoQuery && (
            <span className="repo-filter-clear" title="Clear repo filter" onClick={() => setRepoQuery("")}>×</span>
          )}
        </div>
      )}

      {filter === "mysprint" && (
        <div className="reorder-bar">
          <button className="reset-order" title="Clear your manual order" onClick={() => send({ type: "resetOrder", size })}>
            Reset order
          </button>
        </div>
      )}

      {loading && <div className="loading">Loading…</div>}
      {!loading && authed !== null && visibleTasks.length === 0 && (
        <div className="empty">
          {q
            ? `No tasks touch “${repoQuery.trim()}”.`
            : statuses.size > 0
              ? "No tasks match the selected status."
              : "No tasks in this view."}
        </div>
      )}

      <div
        className="list"
        onDragLeave={
          canReorder
            ? (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null); }
            : undefined
        }
      >
        {visibleTasks.map((t) => (
          <TaskCard
            key={t.key}
            task={t}
            me={me}
            prReviewStatus={prReviewStatus}
            open={expanded.has(t.key)}
            detail={details[t.key]}
            onToggle={() => toggleExpand(t.key)}
            onSelect={(sel) => setSelected(t.key, sel)}
            dnd={
              canReorder
                ? {
                    onBegin: () => beginDrag(t.key),
                    onHover: (pos) => setDropTarget({ key: t.key, pos }),
                    onDrop: (pos) => commitDrop(t.key, pos),
                    onEnd: endDrag,
                    dragging: dragKey === t.key,
                    hint: dropTarget && dropTarget.key === t.key && dragKey && dragKey !== t.key ? dropTarget.pos : null,
                  }
                : undefined
            }
          />
        ))}
      </div>

      {toastStack}
    </div>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: { id: number; level: string; message: string }[];
  onDismiss: (id: number) => void;
}): JSX.Element | null {
  if (toasts.length === 0) return null;
  const icon = (l: string) => (l === "success" ? "✓" : l === "error" ? "⚠" : "ℹ");
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.level}`} role="status" onClick={() => onDismiss(t.id)}>
          <span className="toast-ico">{icon(t.level)}</span>
          <span className="toast-msg">{t.message}</span>
        </div>
      ))}
    </div>
  );
}

function TaskCard(props: {
  task: JiraTask;
  me: string | null;
  prReviewStatus: string;
  open: boolean;
  detail?: DetailState;
  onToggle: () => void;
  onSelect: (selected: string[]) => void;
  dnd?: CardDnd;
}): JSX.Element {
  const { task, me, prReviewStatus, open, detail, onToggle, onSelect, dnd } = props;
  const unassigned = !task.assignee || task.assignee.toLowerCase() === "unassigned";
  const isMe = !!me && task.assignee === me;
  // Offer "add to my sprint" when it isn't already there: unassigned tasks, or tasks
  // already assigned to me that aren't in the active sprint yet.
  const showAddToSprint = unassigned || (isMe && !task.inOpenSprint);
  // Offer "Address PR" once the ticket reaches the configured PR-review status.
  const canAddressPr = isPrReviewStatus(task.status, prReviewStatus);
  const armed = React.useRef(false); // true only while a drag started from the grip

  const take = (e: React.MouseEvent) => {
    e.stopPropagation();
    const services = open && detail?.selected ? detail.selected : undefined;
    send({ type: "take", key: task.key, services });
  };

  const addressPr = (e: React.MouseEvent) => {
    e.stopPropagation();
    const services = open && detail?.selected ? detail.selected : undefined;
    send({ type: "addressPr", key: task.key, services });
  };

  const addToSprint = (e: React.MouseEvent) => {
    e.stopPropagation();
    send({ type: "addToMySprint", key: task.key });
  };

  const dropPos = (e: React.DragEvent): "before" | "after" => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return e.clientY < r.top + r.height / 2 ? "before" : "after";
  };

  const cls = [
    "card", prioClass(task.priority),
    open ? "open" : "",
    dnd?.dragging ? "dragging" : "",
    dnd?.hint === "before" ? "drop-before" : dnd?.hint === "after" ? "drop-after" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      className={cls}
      draggable={!!dnd}
      onMouseDown={dnd ? () => { armed.current = false; } : undefined}
      onDragStart={dnd ? (e) => {
        if (!armed.current) { e.preventDefault(); return; } // only the grip arms a drag
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", task.key);
        dnd.onBegin();
      } : undefined}
      onDragOver={dnd ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; dnd.onHover(dropPos(e)); } : undefined}
      onDrop={dnd ? (e) => { e.preventDefault(); dnd.onDrop(dropPos(e)); } : undefined}
      onDragEnd={dnd ? () => { armed.current = false; dnd.onEnd(); } : undefined}
    >
      <div className="card-main" onClick={onToggle}>
        <div className="card-top">
          {dnd && (
            <span
              className="grip"
              title="Drag to reorder"
              onMouseDown={(e) => { e.stopPropagation(); armed.current = true; }}
              onClick={(e) => e.stopPropagation()}
            >⠿</span>
          )}
          <span className={`chev${open ? " open" : ""}`}>›</span>
          <a
            className="key"
            href={task.url}
            title="Open in Jira"
            onClick={(e) => e.stopPropagation() /* don't toggle expand; global handler opens externally */}
          >{task.key}</a>
          {task.status && (
            <button
              className={`status status-btn status--${task.statusCategory || "new"}`}
              title="Change status"
              onClick={(e) => { e.stopPropagation(); send({ type: "changeStatus", key: task.key }); }}
            >
              {task.status}<span className="status-caret">▾</span>
            </button>
          )}
          <div className="card-actions">
            {showAddToSprint && (
              <button
                className="sprint-add"
                onClick={addToSprint}
                title={`Add ${task.key} to your active sprint${unassigned ? " and assign it to you" : ""}`}
              >
                <SprintAddIcon /> Add to my sprint
              </button>
            )}
            {canAddressPr && (
              <button
                className="address-pr"
                onClick={addressPr}
                title={`Address the PR for ${task.key} — check it out in a worktree and work through the review feedback`}
              >
                <AddressPrIcon /> Address PR
              </button>
            )}
            <button className="take" onClick={take} title="Take this task — open its workspace">
              <PlayIcon /> Take
            </button>
          </div>
        </div>
        <div className="summary">{task.summary}</div>
        {!open && (
          <div className="meta">
            <span className={`assignee${unassigned ? " unassigned" : ""}`}>{unassigned ? "Unassigned" : task.assignee}</span>
            {task.estimateSeconds != null && (
              <span className="est" title="Original estimate">⏱ {fmtEst(task.estimateSeconds)}</span>
            )}
            {(task.services ?? []).map((s) => (
              <span key={s} className="svc guess">{s}</span>
            ))}
          </div>
        )}
      </div>

      {open && <CardDetail detail={detail} onSelect={onSelect} />}
    </div>
  );
}

function CardDetail(props: { detail?: DetailState; onSelect: (s: string[]) => void }): JSX.Element {
  const { detail, onSelect } = props;
  if (!detail || detail.loading) return <div className="detail"><div className="detail-loading">Loading ticket…</div></div>;

  const selected = detail.selected ?? [];
  const available = (detail.repos ?? []).filter((r) => !selected.includes(r));
  const remove = (name: string) => onSelect(selected.filter((s) => s !== name));
  const add = (name: string) => { if (name) onSelect([...selected, name]); };

  return (
    <div className="detail">
      <div className="desc">{detail.descriptionText?.trim() || "No description on the ticket."}</div>
      <div className="sel-label">Repos this task touches</div>
      <div className="chips">
        {selected.length === 0 && <span className="chip-none">none selected</span>}
        {selected.map((s) => (
          <span key={s} className="chip">
            {s}
            <span className="x" title="Remove" onClick={() => remove(s)}>×</span>
          </span>
        ))}
      </div>
      <RepoPicker available={available} onAdd={add} />
    </div>
  );
}

/** Command-palette-style repo picker: filter-as-you-type, keyboard-navigable,
 * inline (no floating popup to get clipped by the card's overflow). */
export function RepoPicker({ available, onAdd }: { available: string[]; onAdd: (name: string) => void }): JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(
    () => available.filter((r) => r.toLowerCase().includes(q.toLowerCase())),
    [available, q],
  );

  React.useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  React.useEffect(() => setActive(0), [q, open]);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (available.length === 0) return null;

  const choose = (name: string) => {
    onAdd(name);
    setQ("");
    setActive(0);
    inputRef.current?.focus();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[active]) choose(filtered[active]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  return (
    <div className="repo-picker" ref={rootRef}>
      {!open ? (
        <button className="repo-add" onClick={() => setOpen(true)}>
          <span className="repo-add-plus">+</span> add repo
        </button>
      ) : (
        <div className="repo-combo">
          <div className="repo-search">
            <SearchIcon />
            <input
              ref={inputRef}
              value={q}
              spellCheck={false}
              placeholder="Filter repos…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKey}
            />
          </div>
          <div className="repo-list" role="listbox">
            {filtered.length === 0 && <div className="repo-empty">No repos match “{q}”</div>}
            {filtered.map((r, i) => (
              <div
                key={r}
                role="option"
                aria-selected={i === active}
                className={`repo-row${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => { e.preventDefault(); choose(r); }}
              >
                <span className="repo-name">{r}</span>
                <span className="repo-add-hint">add ⏎</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
