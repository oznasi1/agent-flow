import * as React from "react";
import Fuse from "fuse.js";
import { send } from "./vscodeApi";
import {
  addOnce, deriveStatuses, effectiveFilter, fmtEst, gateCopy, isPrReviewStatus, isTopPriority,
  matchesStatus, moveKey, railClass, visibleFilters,
} from "./helpers";
import { Filter, FilterVisibility, Task, OutboundMessage, Size, NotepadItemView } from "../types";
import type { SerializedCaps } from "../tasks/provider";
import { GaugeMark } from "./GaugeMark";
import { Notepad } from "./Notepad";

let toastSeq = 0;

const FILTER_LABELS: Record<Filter, string> = {
  mysprint: "My sprint",
  mine: "Mine",
  sprint: "Sprint",
  backlog: "Backlog",
  unassigned: "Unassigned",
  all: "All",
};

// Everything on, and the shipped Jira label — what a first paint renders before
// `state` arrives. `state` is asynchronous (a real round-trip through the
// extension host), so there is always a gap between mount and the first message;
// defaulting to the permissive end of both axes means that gap renders exactly
// today's UI (every control visible, "Connecting to Jira…") rather than either a
// stripped-down panel for a Jira user or a flash of a nameless source ("Connecting
// to …") before the truth arrives a moment later.
const DEFAULT_SOURCE_LABEL = "Jira";
const DEFAULT_CAPS: SerializedCaps = {
  supportedFilters: ["unassigned", "mine", "mysprint", "sprint", "backlog", "all"],
  sizes: true, labels: true, sprints: true, components: true,
};

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
  sourceComponents?: string[]; // components on the ticket, spelled as the source spells them
  // repo name → canonical component name; `null` means the project's component
  // list couldn't be read, so no chip's state (on-ticket, pushable, local-only)
  // can be claimed.
  mappable?: Record<string, string> | null;
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

const FilterIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M1 2.5h14L9.4 8.7v4.2l-2.8 1.6V8.7z" />
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

// A sprint column with a minus — remove the ticket from the active sprint (to backlog).
const SprintRemoveIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M3 1.4a.7.7 0 0 1 1.4 0V14.6a.7.7 0 0 1-1.4 0z" />
    <path fill="currentColor" d="M5 2.3h6.4L10.1 4.7l1.3 2.4H5z" />
    <path fill="currentColor" d="M9.3 11.3h5v1.3h-5z" />
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
  const [error, setError] = React.useState<{ message: string; canRetry: boolean; canRunDoctor?: boolean } | null>(null);
  const [project, setProject] = React.useState("");
  const [liveCount, setLiveCount] = React.useState<number | undefined>(undefined);
  const [me, setMe] = React.useState<string | null>(null);
  // The task status that reveals the "Address PR" card action (configurable; from the host).
  const [prReviewStatus, setPrReviewStatus] = React.useState("");
  // The source's user-facing name and what it can do — see DEFAULT_SOURCE_LABEL/
  // DEFAULT_CAPS for why the pre-`state` defaults are what they are.
  const [sourceLabel, setSourceLabel] = React.useState(DEFAULT_SOURCE_LABEL);
  const [caps, setCaps] = React.useState<SerializedCaps>(DEFAULT_CAPS);
  const [filter, setFilter] = React.useState<Filter>("mysprint");
  const [size, setSize] = React.useState<Size>("any");
  // Which secondary filter controls are shown (from settings, via the host). All
  // shown until the host says otherwise — nothing flashes hidden on first paint.
  const [filters, setFilters] = React.useState<FilterVisibility>({ size: true, status: true, repo: true, search: true });
  // Client-side status lens: the set of selected statuses (empty = show all).
  const [statuses, setStatuses] = React.useState<Set<string>>(new Set());
  const [selectedRepos, setSelectedRepos] = React.useState<Set<string>>(new Set());
  const toggleRepo = (name: string) =>
    setSelectedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const clearRepos = () => setSelectedRepos(new Set());
  // Multi-select batch launch (only surfaced when the repo filter is one repo).
  const [batchSelected, setBatchSelected] = React.useState<Set<string>>(new Set());
  const toggleBatch = (key: string) =>
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const clearBatch = () => setBatchSelected(new Set());
  const [textQuery, setTextQuery] = React.useState("");
  // Which of the panel's two views is showing. Not persisted: the panel always
  // opens on Tasks, which is what the sidebar is primarily for.
  const [tab, setTab] = React.useState<"tasks" | "notepad">("tasks");
  const [notes, setNotes] = React.useState<NotepadItemView[]>([]);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [toasts, setToasts] = React.useState<
    { id: number; level: string; message: string; action?: { label: string; url: string } }[]
  >([]);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [details, setDetails] = React.useState<Record<string, DetailState>>({});
  const [dragKey, setDragKey] = React.useState<string | null>(null);
  const [dropTarget, setDropTarget] = React.useState<{ key: string; pos: "before" | "after" } | null>(null);
  const dragKeyRef = React.useRef<string | null>(null);
  const tasksRef = React.useRef<Task[]>([]);
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
          message: "Agent Flow Deck isn't responding. Open the “Agent Flow Deck” output channel for details, or reload the window.",
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
          setLiveCount(m.liveCount);
          setSourceLabel(m.sourceLabel);
          setCaps(m.caps);
          break;
        case "error":
          setLoading(false);
          setError({ message: m.message, canRetry: m.canRetry, canRunDoctor: m.canRunDoctor });
          break;
        case "tasks":
          setError(null);
          setFilter(m.filter);
          setTasks(m.tasks);
          setLiveCount(m.liveCount);
          setExpanded(new Set());
          setBatchSelected(new Set());
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
            [m.key]: {
              loading: false,
              descriptionText: m.descriptionText,
              repos: m.repos,
              selected: m.inferred,
              sourceComponents: m.sourceComponents,
              mappable: m.mappable,
            },
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
        case "removedFromSprint":
          setTasks((prev) => prev.filter((t) => t.key !== m.key));
          break;
        case "componentsChanged":
          // On success the optimistic update already stands. On failure, undo
          // exactly what was applied: `on` says which direction, `movedChip`
          // whether the chip's own presence changed with it.
          if (m.ok) break;
          setDetails((prev) => {
            const d = prev[m.key];
            if (!d) return prev;
            const component = d.mappable?.[m.repo] ?? m.repo;
            const sourceComponents = d.sourceComponents ?? [];
            const selected = d.selected ?? [];
            return {
              ...prev,
              [m.key]: {
                ...d,
                sourceComponents: m.on ? sourceComponents.filter((c) => c !== component) : addOnce(sourceComponents, component),
                selected: !m.movedChip
                  ? selected
                  : m.on
                    ? selected.filter((s) => s !== m.repo)
                    : addOnce(selected, m.repo),
              },
            };
          });
          break;
        case "loading":
          setLoading(m.loading);
          break;
        case "notepad:notes":
          setNotes(m.notes);
          break;
        case "toast": {
          const id = ++toastSeq;
          setToasts((t) => [...t.slice(-2), { id, level: m.level, message: m.message, action: m.action }]);
          // Errors stay until dismissed — a Jira validator message is longer than
          // 4.2s of reading, and it usually needs acting on.
          if (m.level !== "error") {
            setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
          }
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

  /** Apply a chip-list edit, writing whatever part of it the source can accept. Adding a
   * repo the project has a component for pushes it; removing a chip only writes when
   * that component is actually on the ticket — a chip inferred from a label or a text
   * mention has nothing to remove. Both changes are optimistic; `componentsChanged`
   * with `ok: false` undoes them. */
  const setSelected = (key: string, selected: string[]) => {
    const d = details[key];
    const mappable = d?.mappable ?? {};
    const before = d?.selected ?? [];
    const added = selected.filter((s) => !before.includes(s));
    const removed = before.filter((s) => !selected.includes(s));
    let sourceComponents = d?.sourceComponents ?? [];
    for (const repo of added) {
      const component = mappable[repo];
      if (!component) continue;
      send({ type: "setComponent", key, repo, on: true, movedChip: true });
      sourceComponents = addOnce(sourceComponents, component);
    }
    for (const repo of removed) {
      const component = mappable[repo];
      if (!component || !sourceComponents.includes(component)) continue;
      send({ type: "setComponent", key, repo, on: false, movedChip: true });
      sourceComponents = sourceComponents.filter((c) => c !== component);
    }
    setDetails((prev) => ({ ...prev, [key]: { ...prev[key], selected, sourceComponents } }));
  };

  /** `↑` on a chip whose component the ticket lacks: write it, and show it as
   * on-ticket at once. The chip itself doesn't move, hence `movedChip: false`. */
  const pushComponent = (key: string, repo: string) => {
    const component = details[key]?.mappable?.[repo];
    if (!component) return;
    send({ type: "setComponent", key, repo, on: true, movedChip: false });
    setDetails((prev) => ({
      ...prev,
      [key]: { ...prev[key], sourceComponents: addOnce(prev[key]?.sourceComponents ?? [], component) },
    }));
  };

  // Status lens chips, derived from the loaded pool (adapts to the project's workflow).
  const availableStatuses = React.useMemo(() => deriveStatuses(tasks), [tasks]);
  const toggleStatus = (name: string) =>
    setStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // The repos in play across the current pool — options for the multiselect.
  const allRepos = React.useMemo(
    () => [...new Set(tasks.flatMap((t) => t.services ?? []))].sort((a, b) => a.localeCompare(b)),
    [tasks],
  );

  // Fuzzy index over each task's title (summary only — description is out of scope).
  const fuse = React.useMemo(
    () => new Fuse(tasks, { keys: ["summary"], threshold: 0.4, ignoreLocation: true }),
    [tasks],
  );

  // Search first (ordered by relevance when a query is active), then narrow to
  // tasks touching any selected repo (OR) and, if a status lens is active, to
  // the selected statuses. All three filter types combine as AND.
  const q = textQuery.trim();
  const searched = q ? fuse.search(q).map((r) => r.item) : tasks;
  const visibleTasks = searched.filter(
    (t) =>
      (selectedRepos.size === 0 || (t.services ?? []).some((s) => selectedRepos.has(s))) &&
      matchesStatus(t, statuses),
  );
  // Multi-select needs a repo filter — without one there is no bounded repo set to
  // map each task onto, and the host has nothing to intersect its inference against.
  const batchMode = selectedRepos.size >= 1;
  const batchRepos = [...selectedRepos];
  // Only currently-visible tasks are launchable: a status/search filter that hides a
  // selected card silently drops it (state is untouched, just never launched).
  const selectedVisible = batchMode ? visibleTasks.filter((t) => batchSelected.has(t.key)) : [];
  // Reorder only makes sense on the full My-sprint list, not a filtered subset —
  // and not at all on a source with no sprint concept, which the tab bar itself
  // never leaves reachable, but a stale echo of an old `filter` state shouldn't
  // resurrect the drag affordance either.
  const canReorder = filter === "mysprint" && caps.sprints && selectedRepos.size === 0 && !q && statuses.size === 0;
  // The tab the bar actually highlights — never the raw, possibly-unsupported
  // `filter` state directly. Before the first `tasks` message lands, `filter` is
  // still its hardcoded "mysprint" default; on a source without that lens (or any
  // lens this source doesn't support after a live `taskSource` edit), rendering by
  // raw `filter` would leave the whole tab bar unpressed.
  const activeFilter = effectiveFilter(filter, caps.supportedFilters);

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
        {error.canRunDoctor && (
          <button className="btn" onClick={() => send({ type: "runDoctor" })}>
            Run Doctor
          </button>
        )}
      </div>,
    );
  }

  const copy = gateCopy(sourceLabel);

  // Handshake in flight (or the host never replied — the watchdog turns this into an
  // error above). Never a blank panel.
  if (authed === null) {
    return gate(<div className="gate"><div>{copy.connecting}</div></div>);
  }

  // Never set up: no source site URL / project key yet.
  if (!configured) {
    return gate(
      <div className="gate">
        <div>{copy.unconfigured}</div>
        <button className="btn" onClick={() => send({ type: "runSetup" })}>Run setup</button>
      </div>,
    );
  }

  if (authed === false) {
    return gate(
      <div className="gate">
        <div>{copy.unauthed}</div>
        <button className="btn" onClick={() => send({ type: "signIn" })}>{copy.signIn}</button>
      </div>,
    );
  }

  return (
    <div>
      <div className="header">
        <span className="title"><GaugeMark live={liveCount} /> {project || "Tasks"}</span>
        <button
          className="explore"
          onClick={() => send({ type: "explore" })}
          title="Explore repos with a Claude Code agent — pick repos, no ticket needed"
        >
          <CompassIcon /> Explore
        </button>
        {me && <span className="me">{me}</span>}
      </div>

      <div className="tabbar" role="tablist" aria-label="Panel view">
        <button role="tab" aria-selected={tab === "tasks"} onClick={() => setTab("tasks")}>Tasks</button>
        <button role="tab" aria-selected={tab === "notepad"} onClick={() => setTab("notepad")}>Notepad</button>
      </div>

      {tab === "notepad" && <Notepad notes={notes} />}

      {tab === "tasks" && <>
      <div className="lenses">
        <div className="lens">
          <div className="seg" role="group" aria-label="Task filter">
            {visibleFilters(caps.supportedFilters).map((id) => (
              <button
                key={id}
                aria-pressed={activeFilter === id}
                onClick={() => refetch(id, size)}
              >
                {FILTER_LABELS[id]}
              </button>
            ))}
          </div>
        </div>

        {caps.sizes && filters.size && (
          <div className="lens">
            <span className="seg-label">Size</span>
            <div className="seg" role="group" aria-label="Size">
              {SIZES.map((s) => (
                <button
                  key={s.id}
                  aria-pressed={size === s.id}
                  title={s.title}
                  onClick={() => refetch(filter, s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {filters.status && availableStatuses.length > 0 && (
          <div className="lens">
            <span className="seg-label">Status</span>
            <div className="seg" role="group" aria-label="Status">
              <button
                aria-pressed={statuses.size === 0}
                title="Any status"
                onClick={() => setStatuses(new Set())}
              >
                All
              </button>
              {availableStatuses.map((s) => (
                <button
                  key={s.name}
                  aria-pressed={statuses.has(s.name)}
                  onClick={() => toggleStatus(s.name)}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {filters.repo && (
        <RepoMultiSelect
          repos={allRepos}
          selected={selectedRepos}
          onToggle={toggleRepo}
          onClear={clearRepos}
        />
      )}

      {filters.search && (
        <div className="text-search">
          <SearchIcon />
          <input
            value={textQuery}
            spellCheck={false}
            placeholder="Search title…"
            onChange={(e) => setTextQuery(e.target.value)}
          />
          {textQuery && (
            <span className="text-search-clear" title="Clear search" onClick={() => setTextQuery("")}>×</span>
          )}
        </div>
      )}

      {filter === "mysprint" && caps.sprints && (
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
            ? `No titles match “${q}”.`
            : selectedRepos.size > 0
              ? "No tasks touch the selected repos."
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
            sourceLabel={sourceLabel}
            caps={caps}
            open={expanded.has(t.key)}
            detail={details[t.key]}
            project={project}
            onToggle={() => toggleExpand(t.key)}
            onSelect={(sel) => setSelected(t.key, sel)}
            onPush={(repo) => pushComponent(t.key, repo)}
            batch={batchMode ? { checked: batchSelected.has(t.key), onToggle: () => toggleBatch(t.key) } : undefined}
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
            onRemoveFromSprint={
              filter === "mysprint" && caps.sprints ? () => send({ type: "removeFromSprint", key: t.key, size }) : undefined
            }
          />
        ))}
      </div>

      {batchMode && selectedVisible.length > 0 && (
        <div className="batch-bar">
          <span className="batch-count">{selectedVisible.length} selected</span>
          <button
            className="batch-selectall"
            onClick={() => setBatchSelected(new Set(visibleTasks.map((t) => t.key)))}
          >
            Select all visible
          </button>
          <button className="batch-clear" onClick={clearBatch}>Clear selection</button>
          <button
            className="batch-launch"
            title={`Open ${selectedVisible.length} ${selectedVisible.length === 1 ? "task" : "tasks"} across ${batchRepos.join(", ")}, each in its own worktree with its own Claude Code session`}
            onClick={() => send({ type: "takeBatch", keys: selectedVisible.map((t) => t.key), repos: batchRepos })}
          >
            <PlayIcon /> Launch in parallel
          </button>
        </div>
      )}
      </>}
      {toastStack}
    </div>
  );
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: { id: number; level: string; message: string; action?: { label: string; url: string } }[];
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
          {t.action && (
            <button
              className="toast-action"
              onClick={(e) => {
                // The toast dismisses on click; opening the ticket must not also
                // close the message explaining why you're being sent there.
                e.stopPropagation();
                send({ type: "openExternal", url: t.action!.url });
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function TaskCard(props: {
  task: Task;
  me: string | null;
  prReviewStatus: string;
  sourceLabel: string;
  caps: SerializedCaps;
  open: boolean;
  detail?: DetailState;
  project: string;
  onToggle: () => void;
  onSelect: (selected: string[]) => void;
  onPush: (repo: string) => void;
  batch?: { checked: boolean; onToggle: () => void };
  dnd?: CardDnd;
  onRemoveFromSprint?: () => void;
}): JSX.Element {
  const { task, me, prReviewStatus, sourceLabel, caps, open, detail, project, onToggle, onSelect, onPush, batch, dnd, onRemoveFromSprint } = props;
  const unassigned = !task.assignee || task.assignee.toLowerCase() === "unassigned";
  const isMe = !!me && task.assignee === me;
  // Offer "add to my sprint" when it isn't already there: unassigned tasks, or tasks
  // already assigned to me that aren't in the active sprint yet. Gated on
  // `caps.sprints` FIRST — `Task.inOpenSprint` is a required boolean, so a source
  // with no sprint concept at all still has to report `false`, which would
  // otherwise make this true for both an unassigned task and one already assigned
  // to the current user, and render a button with no working action behind it.
  const showAddToSprint = caps.sprints && (unassigned || (isMe && !task.inOpenSprint));
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
    "card", railClass(task.statusCategory),
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
          {batch && (
            <input
              type="checkbox"
              className="card-check"
              checked={batch.checked}
              title="Select for parallel launch"
              onClick={(e) => e.stopPropagation()}
              onChange={() => batch.onToggle()}
            />
          )}
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
            title={gateCopy(sourceLabel).openIn}
            onClick={(e) => e.stopPropagation() /* don't toggle expand; global handler opens externally */}
          >{task.key}</a>
          {isTopPriority(task.priority) && <span className="p-top" title={`Priority: ${task.priority}`}>Highest</span>}
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
            {onRemoveFromSprint && (
              <button
                className="sprint-remove icon-only"
                onClick={(e) => { e.stopPropagation(); onRemoveFromSprint(); }}
                title={`Remove ${task.key} from your active sprint (move it to the backlog)`}
                aria-label={`Remove ${task.key} from your active sprint (move it to the backlog)`}
              >
                <SprintRemoveIcon />
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
            {/* The edited list once a detail has loaded for this card, falling back
                to the inferred guess until then. */}
            {(detail?.selected ?? task.services ?? []).map((s) => (
              <span key={s} className="svc guess" title="Inferred from the ticket, not recorded on it">~{s}</span>
            ))}
          </div>
        )}
      </div>

      {open && (
        <CardDetail
          taskKey={task.key}
          project={project}
          sourceLabel={sourceLabel}
          componentsSupported={caps.components}
          detail={detail}
          onSelect={onSelect}
          onPush={onPush}
        />
      )}
    </div>
  );
}

function CardDetail(props: {
  taskKey: string;
  project: string;
  sourceLabel: string;
  componentsSupported: boolean;
  detail?: DetailState;
  onSelect: (s: string[]) => void;
  onPush: (repo: string) => void;
}): JSX.Element {
  const { taskKey, project, sourceLabel, componentsSupported, detail, onSelect, onPush } = props;
  if (!detail || detail.loading) return <div className="detail"><div className="detail-loading">Loading ticket…</div></div>;

  const selected = detail.selected ?? [];
  const sourceComponents = detail.sourceComponents ?? [];
  const mappable = detail.mappable;
  // "The list couldn't be read" — only askable of a source that HAS components.
  const unknown = componentsSupported && mappable == null;
  // Nothing about the ticket can be claimed for a chip: either there is no component
  // concept at all, or the list is unreadable. Both render the chip plain.
  const plain = !componentsSupported || unknown;
  const available = (detail.repos ?? []).filter((r) => !selected.includes(r));
  const remove = (name: string) => onSelect(selected.filter((s) => s !== name));
  const add = (name: string) => { if (name) onSelect([...selected, name]); };

  return (
    <div className="detail">
      <div className="desc">{detail.descriptionText?.trim() || "No description on the ticket."}</div>
      {/* Which repos a task touches is NOT a components capability: it is what `take`
       * sends as `services`, and it is inferred from summary, description and labels
       * as much as from components. So the selection and its picker render for every
       * source; only the component-derived state on a chip needs the capability —
       * see docs/CONNECTORS.md's capability table. */}
      <div className="sel-label">Repos this task touches</div>
      <div className="chips">
        {selected.length === 0 && <span className="chip-none">none selected</span>}
        {selected.map((s) => {
          // Three states when the component list is known: on the ticket (solid),
          // a component the ticket lacks (dashed, with a push affordance), or no
          // component at all (dashed, local-only). Only the first can be removed
          // from the source. When none of the three can be claimed — no components
          // on this source, or a list that couldn't be read — the chip renders
          // plain, with no dash and no push.
          const component = plain ? undefined : mappable![s];
          const onTicket = !!component && sourceComponents.includes(component);
          return (
            <span
              key={s}
              className={`chip${plain || onTicket ? "" : " off-ticket"}`}
              title={
                // A source with no components has nothing to explain: saying the list
                // couldn't be read would blame a connection for a capability that was
                // never there.
                !componentsSupported
                  ? undefined
                  : unknown
                    ? `Couldn't read ${project}'s components — can't tell which are on ${taskKey}`
                    : onTicket
                      ? undefined
                      : component
                        ? `Not on ${taskKey} in ${sourceLabel} — ↑ adds it`
                        : `No ${project} component named “${s}” — this selection stays local`
              }
            >
              {s}
              {!onTicket && component && (
                <span className="up" title={`Add ${component} to ${taskKey}`} onClick={() => onPush(s)}>↑</span>
              )}
              <span
                className="x"
                title={onTicket ? `Remove ${component} from ${taskKey}` : "Remove"}
                onClick={() => remove(s)}
              >×</span>
            </span>
          );
        })}
      </div>
      <RepoPicker available={available} onAdd={add} />
    </div>
  );
}

/** Shared scaffolding for the inline command-palette combos (RepoPicker,
 * RepoMultiSelect): open/query/active state, focus-on-open, active-reset on
 * change, click-outside-to-close, and Arrow/Enter/Escape handling. The consumer
 * supplies what Enter does via `onEnter`. */
export function useComboFilter(items: string[], onEnter: (item: string) => void) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const filtered = React.useMemo(
    () => items.filter((r) => r.toLowerCase().includes(q.toLowerCase())),
    [items, q],
  );

  React.useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  React.useEffect(() => setActive(0), [q, open]);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (filtered[active]) onEnter(filtered[active]); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
  };

  return { open, setOpen, q, setQ, active, setActive, filtered, inputRef, rootRef, onKeyDown };
}

/** Command-palette-style repo picker: filter-as-you-type, keyboard-navigable,
 * inline (no floating popup to get clipped by the card's overflow). */
export function RepoPicker({ available, onAdd }: { available: string[]; onAdd: (name: string) => void }): JSX.Element | null {
  const { open, setOpen, q, setQ, active, setActive, filtered, inputRef, rootRef, onKeyDown } =
    useComboFilter(available, (name) => choose(name));

  const choose = (name: string) => {
    onAdd(name);
    setQ("");
    setActive(0);
    inputRef.current?.focus();
  };

  if (available.length === 0) return null;

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
              onKeyDown={onKeyDown}
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

/** Multiselect repo filter: a trigger that opens a checkbox list —
 * filter-as-you-type, keyboard-navigable, OR-combining. The popup
 * deliberately floats (`.repo-pop` is `position: absolute`); that's safe here
 * because the multiselect sits at the top of the sidebar, not inside an
 * `overflow: hidden` card, so the popup can't get clipped. Renders nothing
 * when the pool has no repos. Shares its command-palette scaffolding with
 * RepoPicker via useComboFilter; Enter toggles the active repo (the combo
 * stays open). */
export function RepoMultiSelect({
  repos,
  selected,
  onToggle,
  onClear,
}: {
  repos: string[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  onClear: () => void;
}): JSX.Element | null {
  const { open, setOpen, q, setQ, active, setActive, filtered, inputRef, rootRef, onKeyDown } =
    useComboFilter(repos, onToggle);

  if (repos.length === 0) return null;

  return (
    <div className="repo-select" ref={rootRef}>
      <button className="repo-select-trigger" onClick={() => setOpen(!open)}>
        <FilterIcon />
        <span className={`repo-select-label${selected.size ? "" : " placeholder"}`}>Filter repos</span>
        {selected.size > 0 && <span className="repo-count">{selected.size}</span>}
        <span className="repo-select-caret">▾</span>
      </button>
      {open && (
        <div className="repo-pop">
          <div className="repo-search">
            <SearchIcon />
            <input
              ref={inputRef}
              value={q}
              spellCheck={false}
              placeholder="Filter repos…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="repo-list" role="listbox">
            {filtered.length === 0 && <div className="repo-empty">No repos match “{q}”</div>}
            {filtered.map((r, i) => {
              const on = selected.has(r);
              return (
                <div
                  key={r}
                  role="option"
                  aria-selected={on}
                  className={`repo-opt${i === active ? " active" : ""}${on ? " checked" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => { e.preventDefault(); onToggle(r); }}
                >
                  <span className="repo-box">{on ? "✓" : ""}</span>
                  <span className="repo-name">{r}</span>
                </div>
              );
            })}
          </div>
          <div className="repo-pop-foot">
            <span>{selected.size} selected</span>
            <button className="repo-clear-all" onMouseDown={(e) => { e.preventDefault(); onClear(); }}>Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}
