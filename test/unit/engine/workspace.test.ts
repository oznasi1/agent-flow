import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as childProcess from "child_process";
import { attachmentFileName, briefMarkdown, openWorkspace, writeBriefInto, maybeSeedAgent, watchPlansAndSeed, listWorkspaceFiles, mergeReposIntoWorkspace, workspaceFolders, workspaceFolderPaths, planWorkspaceMerge, agentPrompt, mentionInWorkspace, containingRoot, BRIEF_DIR, BRIEF_FILE, type OpenRequest, type TicketRef, type MergeCandidate } from "../../../src/engine/workspace";
import { commands, env, extensions, setConfig, window, workspace } from "../../_mocks/vscode";
import { fakeContext, mkRepos } from "../../_helpers/factories";

vi.mock("fs");
vi.mock("child_process");

const existsSync = vi.mocked(fs.existsSync);
const statSync = vi.mocked(fs.statSync);
const readFileSync = vi.mocked(fs.readFileSync);
const writeFileSync = vi.mocked(fs.writeFileSync);
const appendFileSync = vi.mocked(fs.appendFileSync);
const mkdirSync = vi.mocked(fs.mkdirSync);
const readdirSync = vi.mocked(fs.readdirSync);
const rmSync = vi.mocked(fs.rmSync);
const realpathSync = vi.mocked(fs.realpathSync);
const watch = vi.mocked(fs.watch);
const exec = vi.mocked(childProcess.exec);
const execSync = vi.mocked(childProcess.execSync);

const CLAUDE_OPEN_CMD = "claude-vscode.primaryEditor.open";

beforeEach(() => {
  vi.mocked(fs).mkdirSync.mockReset();
  writeFileSync.mockReset();
  appendFileSync.mockReset();
  rmSync.mockReset();
  // .git exists (dir), nothing else does → ensureGitExcluded appends once.
  existsSync.mockReset().mockImplementation((p) => String(p).endsWith("/.git"));
  statSync.mockReset().mockReturnValue({ isFile: () => false } as unknown as fs.Stats);
  readFileSync.mockReset().mockReturnValue("");
  readdirSync.mockReset().mockReturnValue([] as never);
  realpathSync.mockReset().mockImplementation((p) => String(p)); // identity canon
  execSync.mockReset().mockReturnValue(""); // git ls-files → no files
  // `open -a` succeeds by invoking its callback with no error.
  exec.mockReset().mockImplementation(((_cmd: string, cb: (e: unknown) => void) => cb(null)) as never);
  // The config store persists across tests, so clear the surface: leaving it on
  // "terminal" would divert every one of the ~40 extension-panel seeding tests.
  setConfig({ agentSurface: undefined });
});

const baseReq = (over: Partial<OpenRequest> = {}): OpenRequest => ({
  ticket: { key: "PROJ-1", summary: "Do the thing", url: "https://jira/PROJ-1" },
  planMd: "## Plan\n\nsteps",
  descriptionText: "no files here",
  services: mkRepos(["account-service", "webapp"]),
  mode: "multiroot",
  promptTemplate: "Start {key}: {summary} {url}{files}",
  workspaceDir: "/ws",
  seedAgent: true,
  ...over,
});

const writeArg = (predicate: (path: string) => boolean) =>
  writeFileSync.mock.calls.find((c) => predicate(String(c[0])));

describe("openWorkspace — multiroot", () => {
  it("writes a .code-workspace, briefs, git-excludes, opens, and seeds a plan", async () => {
    const result = await openWorkspace(baseReq());

    expect(result.mode).toBe("multiroot");
    expect(result.workspaceFile).toBe("/ws/PROJ-1.code-workspace");
    expect(result.opened).toEqual(["/ws/PROJ-1.code-workspace"]);
    expect(result.briefs).toHaveLength(2);
    expect(result.briefs.every((b) => b.gitExcluded)).toBe(true);

    // workspace file content lists both repos as folders
    const wsWrite = writeArg((p) => p.endsWith(".code-workspace"));
    expect(wsWrite).toBeTruthy();
    const ws = JSON.parse(String(wsWrite![1]));
    expect(ws.folders.map((f: { name: string }) => f.name)).toEqual(["account-service", "webapp"]);

    // each repo gets a TASK.md brief mentioning the ticket
    const brief = writeArg((p) => p.endsWith("TASK.md"));
    expect(String(brief![1])).toContain("PROJ-1");

    // a plan file is written for the seed handshake, carrying the rendered prompt
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    expect(planWrite).toBeTruthy();
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.seedAgent).toBe(true);
    expect(plan.matches[0].prompt).toContain("Start PROJ-1");
  });

  it("key-qualifies a worktree root's folder name and leaves a main checkout bare", async () => {
    // The explorer shows one row per root. A worktree row named for its repo alone is
    // indistinguishable from the repo's own checkout sitting beside it, so it carries
    // the key too — repo first, so a service's rows group together.
    await openWorkspace(
      baseReq({
        services: [
          { name: "account-service", path: "/repos/account-service/.claude/worktrees/PROJ-1", isGit: true },
          { name: "webapp", path: "/repos/webapp", isGit: true },
        ],
      }),
    );
    const ws = JSON.parse(String(writeArg((p) => p.endsWith(".code-workspace"))![1]));
    expect(ws.folders).toEqual([
      { name: "account-service-PROJ-1", path: "/repos/account-service/.claude/worktrees/PROJ-1" },
      { name: "webapp", path: "/repos/webapp" },
    ]);
  });

  it("qualifies a worktree's mentions with the same name its folder carries", async () => {
    execSync.mockReturnValue("src/export.py\n"); // git ls-files result
    await openWorkspace(
      baseReq({
        descriptionText: "see src/export.py",
        services: [{ name: "account-service", path: "/repos/account-service/.claude/worktrees/PROJ-1", isGit: true }],
      }),
    );
    const plan = JSON.parse(String(writeArg((p) => p.includes("plans") && p.endsWith(".json"))![1]));
    // `@account-service/…` would name the checkout next door, not this worktree.
    expect(plan.matches[0].prompt).toContain("@account-service-PROJ-1/src/export.py");
  });

  it("falls back to openFolder when `open -a` fails", async () => {
    exec.mockImplementation(((_cmd: string, cb: (e: unknown) => void) => cb(new Error("no app"))) as never);
    const result = await openWorkspace(baseReq());
    expect(commands.executeCommand).toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.anything(),
      expect.objectContaining({ forceNewWindow: true }),
    );
    expect(result.opened).toEqual(["/ws/PROJ-1.code-workspace"]);
  });

  // The same-window reuse branch is gone: openFolder is only ever reached as the
  // fallback for a failed `open -a`, and only ever with forceNewWindow: true. Aimed at
  // the request that USED to take the deleted branch — a plain baseReq() never reached
  // it even before the deletion, so it would guard nothing.
  it("never asks openFolder to reuse the current window", async () => {
    exec.mockImplementation(((_cmd: string, cb: (e: unknown) => void) => cb(new Error("no app"))) as never);
    await openWorkspace(
      baseReq({
        openIn: "current",
        currentWindow: { identity: "/repos/account-service", kind: "folder", roots: [{ name: "account-service", path: "/repos/account-service" }] },
      }),
    );
    const reuse = commands.executeCommand.mock.calls.filter(
      (c) => c[0] === "vscode.openFolder" && (c[2] as { forceNewWindow?: boolean })?.forceNewWindow === false,
    );
    expect(reuse).toEqual([]);
  });

  it("does not write a plan file when seedAgent is off", async () => {
    await openWorkspace(baseReq({ seedAgent: false }));
    expect(writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"))).toBeUndefined();
  });

  it("always writes a durable run record for the Deck (even with seedAgent off)", async () => {
    await openWorkspace(baseReq({ seedAgent: false }));
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWrite).toBeTruthy();
    const run = JSON.parse(String(runWrite![1]));
    expect(run.key).toBe("PROJ-1");
    expect(run.mode).toBe("multiroot");
    expect(run.repos.map((r: { name: string }) => r.name)).toEqual(["account-service", "webapp"]);
  });

  it("writes no run record when recordRun is false — opening into work that already has one", async () => {
    // A seed opens another agent into a place that already exists; the run it
    // belongs to is already on disk, and writing one here would not merge but
    // OVERWRITE that record under the same key (narrower repos, reset createdAt,
    // dropped/forced kind/mode/workspaceFile) — see deckView.ts's seed path.
    await openWorkspace(baseReq({ recordRun: false }));
    expect(writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"))).toBeUndefined();
  });

  it("still writes a run record when recordRun is omitted — every existing caller is unaffected", async () => {
    // The protective test for the flag's default: every caller that predates
    // `recordRun` (every ordinary Take) never sets it, and must keep getting a
    // run record exactly as before. If the default ever flips, this is what fails.
    await openWorkspace(baseReq());
    expect(writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"))).toBeTruthy();
  });

  it("stamps the provider it actually seeded onto the run record", async () => {
    // The record must name the agent that was started, not the setting — under `ask`
    // those differ, and the card's tool mark reads this field.
    const res = await openWorkspace(baseReq({ seedAgent: true }));
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWrite).toBeTruthy();
    expect(JSON.parse(String(runWrite![1])).provider).toBe(res.provider);
  });

  it("stamps no provider when the launch seeded no agent", async () => {
    // Nothing is driving this run yet; a stamp here would put a tool mark on a card
    // that never started an agent at all.
    await openWorkspace(baseReq({ seedAgent: false }));
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWrite).toBeTruthy();
    expect(JSON.parse(String(runWrite![1])).provider).toBeUndefined();
  });
});

describe("openWorkspace — attachments", () => {
  const copyFileSync = vi.mocked(fs.copyFileSync);
  const targets = () => copyFileSync.mock.calls.map((c) => String(c[1]));

  beforeEach(() => copyFileSync.mockReset());

  it("copies each attachment into .pick-task/images/<run key>/ in every repo", async () => {
    await openWorkspace(baseReq({ attachments: [{ path: "/store/i1.png", name: "shot.png" }] }));
    expect(targets()).toContain("/repos/account-service/.pick-task/images/PROJ-1/shot.png");
    expect(targets()).toContain("/repos/webapp/.pick-task/images/PROJ-1/shot.png");
  });

  // The reason the run key is in that path at all: two launches into one checkout each
  // de-duplicate against their own attachment list only, so a shared filename — and every
  // pasted screenshot is called `image.png` — used to mean the second launch replaced the
  // first agent's image under it.
  it("keeps two tasks' same-named attachments apart in one checkout", async () => {
    await openWorkspace(baseReq({
      services: mkRepos(["account-service"]),
      attachments: [{ path: "/store/i1.png", name: "image.png" }],
    }));
    await openWorkspace(baseReq({
      ticket: { key: "PROJ-2", summary: "Another", url: "https://jira/PROJ-2" },
      services: mkRepos(["account-service"]),
      attachments: [{ path: "/store/i2.png", name: "image.png" }],
    }));
    expect(targets()).toContain("/repos/account-service/.pick-task/images/PROJ-1/image.png");
    expect(targets()).toContain("/repos/account-service/.pick-task/images/PROJ-2/image.png");
  });

  // Keys are built from free text (a notepad title) or handed over by a task source, and
  // this is the one place a key becomes a directory rather than a filename fragment.
  it("folds a key that would escape or split the images directory into one segment", async () => {
    await openWorkspace(baseReq({
      ticket: { key: "../../etc/pwned", summary: "Nope", url: "" },
      services: mkRepos(["account-service"]),
      attachments: [{ path: "/store/i1.png", name: "shot.png" }],
    }));
    expect(targets()).toEqual(["/repos/account-service/.pick-task/images/etc-pwned/shot.png"]);
  });

  // Defensive rather than reachable — every key a caller builds carries a literal prefix
  // (`notepad-`, `explore-`) or comes from a task source. Named anyway because the failure
  // it prevents is silent: an empty segment collapses in `path.join`, putting the file back
  // in the shared `images/` slot this change exists to get out of.
  it("still gives a key with nothing sluggable in it a directory of its own", async () => {
    await openWorkspace(baseReq({
      ticket: { key: "///", summary: "Nope", url: "" },
      services: mkRepos(["account-service"]),
      attachments: [{ path: "/store/i1.png", name: "shot.png" }],
    }));
    expect(targets()).toEqual(["/repos/account-service/.pick-task/images/task/shot.png"]);
  });

  it("disambiguates two attachments that share a filename", async () => {
    await openWorkspace(baseReq({
      services: mkRepos(["account-service"]),
      attachments: [
        { path: "/store/i1.png", name: "shot.png" },
        { path: "/store/i2.png", name: "shot.png" },
      ],
    }));
    expect(new Set(targets()).size).toBe(2);
    expect(targets().every((t) => t.startsWith("/repos/account-service/.pick-task/images/"))).toBe(true);
  });

  it("creates no images directory and copies nothing when there are no attachments", async () => {
    await openWorkspace(baseReq());
    expect(targets()).toEqual([]);
    expect(mkdirSync.mock.calls.map((c) => String(c[0])).some((p) => p.includes("/images"))).toBe(false);
  });
});

describe("attachmentFileName", () => {
  it("keeps each name when they differ", () => {
    const all = [{ path: "/s/i1.png", name: "a.png" }, { path: "/s/i2.png", name: "b.png" }];
    expect(attachmentFileName(all, 0)).toBe("a.png");
    expect(attachmentFileName(all, 1)).toBe("b.png");
  });

  it("folds the source stem into a name an earlier attachment already claimed", () => {
    const all = [{ path: "/s/i1.png", name: "shot.png" }, { path: "/s/i2.png", name: "shot.png" }];
    expect(attachmentFileName(all, 0)).toBe("shot.png");
    expect(attachmentFileName(all, 1)).toBe("shot-i2.png");
  });
});

describe("openWorkspace — run kind", () => {
  const runWriteOf = () => {
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWrite).toBeTruthy();
    return JSON.parse(String(runWrite![1]));
  };

  it("stamps the run's kind when one is given", async () => {
    await openWorkspace(baseReq({ kind: "review" }));
    expect(runWriteOf().kind).toBe("review");
  });

  it("leaves the kind absent for a plain take — every pre-existing run record looks like this", async () => {
    await openWorkspace(baseReq());
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWriteOf().kind).toBeUndefined();
    // Not just "reads as undefined": the serialized record must not carry the key
    // at all, matching every runs/*.json file written before `kind` existed.
    expect(String(runWrite![1])).not.toContain("kind");
  });
});

describe("openWorkspace: parent and children on the run record", () => {
  const lastWrittenRun = () => {
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWrite).toBeTruthy();
    return JSON.parse(String(runWrite![1]));
  };

  // `in` rather than `toBeUndefined()`: a key that exists holding `undefined` would
  // satisfy the latter. Note the limit of this assertion — `writeRun` serialises with
  // JSON.stringify, which drops undefined-valued keys, so it cannot distinguish the
  // conditional spread from an unconditional `parentKey: req.parentKey`. What it DOES
  // catch is a falsy default (`?? ""`, `|| null`), which is how this realistically
  // regresses: those land in the JSON and a reader then sees a run whose parent is "".
  it("omits both fields when the request carries neither", async () => {
    await openWorkspace(baseReq());
    const run = lastWrittenRun();
    expect("parentKey" in run).toBe(false);
    expect("children" in run).toBe(false);
  });

  it("stamps parentKey when the take came from a parent's tree", async () => {
    await openWorkspace(baseReq({ parentKey: "PROJ-1" }));
    expect(lastWrittenRun().parentKey).toBe("PROJ-1");
  });

  it("stores the child worktrees an orchestrator run owns", async () => {
    const children = [
      { key: "PROJ-2", summary: "first", repo: "webapp", path: "/repos/webapp/.claude/worktrees/PROJ-2", branch: "PROJ-2-first" },
    ];
    await openWorkspace(baseReq({ children }));
    expect(lastWrittenRun().children).toEqual(children);
  });

  it("omits an empty children array rather than storing one", async () => {
    await openWorkspace(baseReq({ children: [] }));
    expect("children" in lastWrittenRun()).toBe(false);
  });
});

describe("openWorkspace — per-window", () => {
  it("opens one window per repo and records each path as a match", async () => {
    const result = await openWorkspace(baseReq({ mode: "per-window" }));
    expect(result.workspaceFile).toBeUndefined();
    expect(result.opened).toEqual(["/repos/account-service", "/repos/webapp"]);
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches.map((m: { matchPath: string }) => m.matchPath)).toEqual([
      "/repos/account-service",
      "/repos/webapp",
    ]);
  });
});

describe("openWorkspace — promptSuffix", () => {
  const planMatches = () => {
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    return JSON.parse(String(planWrite![1])).matches as { matchPath: string; prompt: string }[];
  };
  // Free text the user wrote, carrying every placeholder renderPrompt substitutes.
  const SUFFIX = "Details from the note:\n\n{summary} {key} {url} {brief} {files}";

  it("appends the suffix to the seeded prompt verbatim, placeholders and all", async () => {
    await openWorkspace(baseReq({ promptSuffix: SUFFIX }));
    const [{ prompt }] = planMatches();
    // Verbatim: the note is the user's own words, so a `{summary}` inside it stays
    // `{summary}` rather than being filled with the ticket's summary.
    expect(prompt).toBe(`Start PROJ-1: Do the thing https://jira/PROJ-1\n\n${SUFFIX}`);
  });

  it("keeps the suffix after the relevant-files block", async () => {
    execSync.mockReturnValue("src/export.py\n"); // git ls-files result
    await openWorkspace(baseReq({ descriptionText: "see src/export.py", promptSuffix: "Details from the note:\n\nlook here" }));
    const [{ prompt }] = planMatches();
    expect(prompt.indexOf("look here")).toBeGreaterThan(prompt.indexOf("Relevant files:"));
  });

  it("gives every window its own copy on a per-window launch", async () => {
    await openWorkspace(baseReq({ mode: "per-window", promptSuffix: "Details from the note:\n\ntwo windows" }));
    const matches = planMatches();
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.prompt.endsWith("Details from the note:\n\ntwo windows"))).toBe(true);
  });

  it("carries it into a window seeded in place", async () => {
    await openWorkspace(
      baseReq({
        openIn: "current",
        currentWindow: { identity: "/repos/account-service", kind: "folder", roots: [{ name: "account-service", path: "/repos/account-service" }] },
        promptSuffix: "Details from the note:\n\nseeded here",
      }),
    );
    expect(planMatches()[0].prompt).toContain("Details from the note:\n\nseeded here");
  });

  it("leaves the prompt untouched when absent or blank", async () => {
    await openWorkspace(baseReq());
    const plain = planMatches()[0].prompt;
    writeFileSync.mockClear();
    await openWorkspace(baseReq({ promptSuffix: "   \n  " }));
    expect(planMatches()[0].prompt).toBe(plain);
  });
});

describe("openWorkspace — git exclude", () => {
  it("appends .pick-task/ to info/exclude when absent", async () => {
    await openWorkspace(baseReq({ services: mkRepos(["solo"]) }));
    const appended = appendFileSync.mock.calls.find((c) => String(c[0]).endsWith("info/exclude"));
    expect(appended).toBeTruthy();
    expect(String(appended![1])).toContain(".pick-task/");
  });

  it("does not append when .pick-task/ is already excluded", async () => {
    existsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("/.git") || s.endsWith("info/exclude");
    });
    readFileSync.mockReturnValue(".pick-task/\n");
    const result = await openWorkspace(baseReq({ services: mkRepos(["solo"]) }));
    expect(appendFileSync).not.toHaveBeenCalled();
    expect(result.briefs[0].gitExcluded).toBe(true);
  });

  it("reports gitExcluded=false for a non-git repo", async () => {
    existsSync.mockReturnValue(false); // no .git anywhere
    const result = await openWorkspace(baseReq({ services: mkRepos(["solo"], { isGit: false }) }));
    expect(result.briefs[0].gitExcluded).toBe(false);
  });

  it("resolves a worktree's shared commondir for the exclude path", async () => {
    existsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("/.git") || s.endsWith("/commondir");
    });
    statSync.mockReturnValue({ isFile: () => true } as unknown as fs.Stats);
    readFileSync.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith("/.git")) return "gitdir: /main/.git/worktrees/w";
      if (s.endsWith("/commondir")) return "../..";
      return "";
    });
    await openWorkspace(baseReq({ services: mkRepos(["solo"]) }));
    const appended = appendFileSync.mock.calls.find((c) => String(c[0]) === "/main/.git/info/exclude");
    expect(appended).toBeTruthy();
  });
});

describe("openWorkspace — relevant files", () => {
  it("threads matched files into the brief and the prompt mentions", async () => {
    execSync.mockReturnValue("src/export.py\n"); // git ls-files result
    const result = await openWorkspace(
      baseReq({
        services: mkRepos(["solo"]),
        descriptionText: "fix `src/export.py`",
      }),
    );
    expect(result.briefs[0].files).toBe(1);
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches[0].prompt).toContain("Relevant files:");
    expect(plan.matches[0].prompt).toContain("export.py");
  });
});

describe("agentPrompt", () => {
  const ticket: TicketRef = { key: "PROJ-1", summary: "Do the thing", url: "https://jira/PROJ-1" };

  it("defaults {brief} to the relative BRIEF_DIR/BRIEF_FILE path", () => {
    expect(agentPrompt(ticket, [], "{brief}")).toBe(`${BRIEF_DIR}/${BRIEF_FILE}`);
  });

  it("uses an explicit briefPath verbatim when given — the shared-window case", () => {
    // Task 4's shared window has N worktree roots each holding the same relative
    // .pick-task/TASK.md, so the seeded prompt needs an absolute, disambiguated path.
    expect(agentPrompt(ticket, [], "{brief}", "/abs/wt/.pick-task/TASK.md")).toBe("/abs/wt/.pick-task/TASK.md");
  });
});

describe("maybeSeedAgent", () => {
  const planJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      key: "PROJ-1",
      createdAt: Date.now(),
      seedAgent: true,
      matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "do it" }],
      ...over,
    });

  const withWorkspaceFile = () => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/PROJ-1.code-workspace" };
  };

  /** The "already seeded this window" guard for one plan file. It carries the plan's
   * createdAt, so a test that pre-sets it has to pin the same value into the plan. */
  const guardKey = (createdAt: number, key = "PROJ-1", identity = "/ws/PROJ-1.code-workspace") =>
    `seeded:${key}:${createdAt}:${identity}`;

  describe("seedProvider", () => {
    // Both cases resolve the agent at seed time, in the target window — the two halves
    // of that resolution: the plan's own `provider` when it has one, and the live
    // setting when it does not.
    afterEach(() => {
      setConfig({ agentProvider: undefined });
    });

    it("a plan's own provider beats a conflicting live setting", async () => {
      setConfig({ agentProvider: "claude-code" });
      withWorkspaceFile();
      readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
      readFileSync.mockReturnValue(planJson({ provider: "cursor" }));
      commands.getCommands.mockResolvedValue(["workbench.action.chat.open", CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      await maybeSeedAgent(context, () => {});

      expect(commands.executeCommand).toHaveBeenCalledWith(
        "workbench.action.chat.open",
        expect.objectContaining({ query: "do it" }),
      );
      expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    });

    it("degrades a bare ask setting to Claude Code at seed time", async () => {
      // Reachable, not theoretical: a plan written under claude-code can sit on disk for
      // up to PLAN_TTL_MS while the user flips the setting to ask, and the plan is
      // re-read here. Degrading beats prompting in a window nobody expected a dialog in.
      setConfig({ agentProvider: "ask" });
      withWorkspaceFile();
      readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
      readFileSync.mockReturnValue(planJson()); // no `provider` field
      commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      await maybeSeedAgent(context, () => {});

      expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
      expect(window.showQuickPick).not.toHaveBeenCalled();
    });
  });

  it("returns early with no single-workspace identity", async () => {
    workspace.workspaceFile = undefined;
    workspace.workspaceFolders = undefined;
    const { context } = fakeContext();
    await maybeSeedAgent(context, () => {});
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it("returns quietly when the plan dir does not exist", async () => {
    withWorkspaceFile();
    readdirSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    const { context } = fakeContext();
    await expect(maybeSeedAgent(context, () => {})).resolves.toBeUndefined();
  });

  it("seeds the matching plan via the Claude Code command", async () => {
    withWorkspaceFile();
    const createdAt = Date.now();
    readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ createdAt }));
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context, globalState } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(globalState.update).toHaveBeenCalledWith(guardKey(createdAt), true);
  });

  it("deletes an expired plan and does not seed", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-old.json"] as never);
    readFileSync.mockReturnValue(planJson({ createdAt: Date.now() - 16 * 60 * 1000 }));
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(rmSync).toHaveBeenCalled();
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, expect.anything());
  });

  it("skips a plan whose matchPath is a different window", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ matches: [{ matchPath: "/other/window", prompt: "do it" }] }));
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
  });

  // Within one plan's life this guard is what stops the watcher and activation from
  // both seeding the same session.
  it("does not re-seed a window already seeded from this very plan (globalState guard)", async () => {
    withWorkspaceFile();
    const createdAt = Date.now();
    readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ createdAt }));
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext({ globalState: { [guardKey(createdAt)]: true } });

    await maybeSeedAgent(context, () => {});
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
  });

  // Nothing ever clears a `seeded:` key, and the shared-window filename is deterministic
  // — so a key-and-window-only guard made re-launching the same selection open a window
  // with correct folders and briefs and zero Claude sessions, while the toast still
  // claimed a session per task.
  it("seeds a re-launch of the same task into the same window", async () => {
    withWorkspaceFile();
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext(); // one window's globalState across both passes

    readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
    readFileSync.mockReturnValue(
      planJson({
        createdAt: Date.now() - 60_000,
        matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "first take" }],
      }),
    );
    await maybeSeedAgent(context, () => {});

    // Re-taking the same key writes a NEW plan naming the same deterministic window.
    readdirSync.mockReturnValue(["PROJ-1-2.json"] as never);
    readFileSync.mockReturnValue(
      planJson({ matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "second take" }] }),
    );
    await maybeSeedAgent(context, () => {});

    const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
    expect(seeds.map((c) => c[2])).toEqual(["first take", "second take"]);
  });

  it("seeds every plan matching this window, in (createdAt, seq) order", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["PROJ-2-1.json", "PROJ-1-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("PROJ-1")
          ? planJson({ key: "PROJ-1", seq: 0, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "first" }] })
          : planJson({ key: "PROJ-2", seq: 1, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "second" }] }),
      );
      commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
      expect(seeds.map((c) => c[2])).toEqual(["first", "second"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the new-tab command when seeding more than one session", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("PROJ-1")
          ? planJson({ key: "PROJ-1", seq: 0 })
          : planJson({ key: "PROJ-2", seq: 1 }),
      );
      commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      expect(commands.executeCommand).toHaveBeenCalledWith("claude-vscode.editor.open", undefined, "do it");
      expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the primary-editor command when the new-tab command is unregistered", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("PROJ-1") ? planJson({ key: "PROJ-1", seq: 0 }) : planJson({ key: "PROJ-2", seq: 1 }),
      );
      commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds the remaining plans when one is already consumed", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      const createdAt = Date.now();
      readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("PROJ-1")
          ? planJson({ key: "PROJ-1", createdAt, seq: 0, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "first" }] })
          : planJson({ key: "PROJ-2", createdAt, seq: 1, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "second" }] }),
      );
      commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
      const { context } = fakeContext({ globalState: { [guardKey(createdAt)]: true } });

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
      expect(seeds.map((c) => c[2])).toEqual(["second"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the clipboard fallback when seeding several sessions", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("PROJ-1") ? planJson({ key: "PROJ-1", seq: 0 }) : planJson({ key: "PROJ-2", seq: 1 }),
      );
      commands.getCommands.mockResolvedValue([]); // no Claude command at all
      env.openExternal.mockResolvedValue(false); // URI handler fails too
      const { context } = fakeContext();

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      expect(env.clipboard.writeText).not.toHaveBeenCalled();
      expect(window.showInformationMessage).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names Claude Code in the batch fallback notification by default", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("PROJ-1") ? planJson({ key: "PROJ-1", seq: 0 }) : planJson({ key: "PROJ-2", seq: 1 }),
      );
      commands.getCommands.mockResolvedValue([]); // no Claude command at all
      env.openExternal.mockResolvedValue(false); // URI handler fails too
      const { context } = fakeContext();

      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Agent Flow Deck: couldn't start Claude Code for PROJ-1."),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes overlapping passes so a batch is never seeded twice", async () => {
    vi.useFakeTimers();
    try {
      withWorkspaceFile();
      // Both passes read the same two plan FILES, and a plan file is written once — so
      // pin createdAt instead of letting the fixture re-stamp it on the second read.
      const createdAt = Date.now();
      readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("PROJ-1")
          ? planJson({ key: "PROJ-1", createdAt, seq: 0, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "first" }] })
          : planJson({ key: "PROJ-2", createdAt, seq: 1, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "second" }] }),
      );
      commands.getCommands.mockResolvedValue(["claude-vscode.editor.open", CLAUDE_OPEN_CMD]);
      const { context } = fakeContext();

      // Simulates the watcher's debounce firing a second pass mid-batch — e.g. another
      // plan-dir write lands while the first pass is still staggering between sessions.
      // Without serializing, the second pass would re-collect the still-unguarded PROJ-2
      // (its `seeded:` guard isn't written until its turn in the first pass) and seed it again.
      const first = maybeSeedAgent(context, () => {});
      const second = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await Promise.all([first, second]);

      const seeds = commands.executeCommand.mock.calls.filter((c) => String(c[0]).startsWith("claude-vscode."));
      expect(seeds.map((c) => c[2])).toEqual(["first", "second"]); // each plan seeded exactly once
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("seedClaudeCode fallback chain (via maybeSeedAgent)", () => {
  const planJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      key: "PROJ-1",
      createdAt: Date.now(),
      seedAgent: true,
      matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "do it" }],
      ...over,
    });

  const setupMatchingPlan = (over: Record<string, unknown> = {}) => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/PROJ-1.code-workspace" };
    readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson(over));
  };

  it("falls back to the URI handler when the command never registers", async () => {
    vi.useFakeTimers();
    try {
      setupMatchingPlan();
      commands.getCommands.mockResolvedValue([]); // command never appears
      env.openExternal.mockResolvedValue(true);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync(); // flush the 7 polling delays
      await p;

      expect(env.openExternal).toHaveBeenCalled();
      expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the clipboard when the URI handler declines", async () => {
    vi.useFakeTimers();
    try {
      setupMatchingPlan();
      commands.getCommands.mockResolvedValue([]);
      env.openExternal.mockResolvedValue(false);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await p;

      expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
      expect(window.showInformationMessage).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("names Claude Code in the clipboard-fallback notification by default", async () => {
    vi.useFakeTimers();
    try {
      setupMatchingPlan();
      commands.getCommands.mockResolvedValue([]);
      env.openExternal.mockResolvedValue(false);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await p;

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        "Agent Flow Deck: opened workspace for PROJ-1. Claude Code prompt copied — paste it into the panel to start.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  /** Drive one seed pass to completion with the CLI boot delay faked away. */
  const seedWithTimers = async (context: Parameters<typeof maybeSeedAgent>[0]) => {
    vi.useFakeTimers();
    try {
      const pending = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  };

  /** The terminal object handed back by the i-th createTerminal call. */
  const terminalAt = (i = 0) => window.createTerminal.mock.results[i].value;

  const BRACKET_ON = "\u001b[200~";
  const BRACKET_OFF = "\u001b[201~";

  describe("terminal surface", () => {
    beforeEach(() => {
      window.createTerminal.mockClear();
      setConfig({ agentSurface: "terminal" });
    });

    it("runs claude in a terminal named for the ticket and types the prompt unsubmitted", async () => {
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal).toHaveBeenCalledTimes(1);
      expect(window.createTerminal.mock.calls[0][0]).toMatchObject({ name: "Claude · PROJ-1" });
      const t = terminalAt();
      expect(t.show).toHaveBeenCalled();
      // First send runs the CLI (submitted); second types the prompt (NOT submitted).
      expect(t.sendText.mock.calls[0]).toEqual(["claude", true]);
      expect(t.sendText.mock.calls[1][1]).toBe(false);
      expect(t.sendText.mock.calls[1][0]).toContain("do it");
      // Never touches the extension panel.
      expect(commands.executeCommand).not.toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    });

    it("wraps the prompt in bracketed paste so a multi-line prompt is not submitted early", async () => {
      // renderPrompt appends "\n\nRelevant files: …" whenever a task has file
      // mentions, so this is the common case, not an edge case. Without the
      // markers the TUI would submit at the blank line and drop the file list.
      const prompt = "Start PROJ-1\n\nRelevant files: @a.ts";
      setupMatchingPlan({ matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt }] });
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(terminalAt().sendText.mock.calls[1][0]).toBe(`${BRACKET_ON}${prompt}${BRACKET_OFF}`);
    });

    it("uses a folder matchPath as the terminal cwd", async () => {
      workspace.workspaceFile = undefined;
      workspace.workspaceFolders = [{ uri: { fsPath: "/repos/api" } }];
      readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
      readFileSync.mockReturnValue(
        planJson({ matches: [{ matchPath: "/repos/api", prompt: "do it" }] }),
      );
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal.mock.calls[0][0]).toMatchObject({ cwd: "/repos/api" });
    });

    it("omits cwd when the match is a .code-workspace file", async () => {
      // A workspace file is not a directory. Omitting cwd lets VS Code default to
      // the window's first root, which is the right answer for a multiroot window.
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal.mock.calls[0][0]?.cwd).toBeUndefined();
    });

    it("falls back to the clipboard when creating the terminal throws", async () => {
      setupMatchingPlan();
      window.createTerminal.mockImplementationOnce(() => {
        throw new Error("no terminal for you");
      });
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
      expect(window.showInformationMessage).toHaveBeenCalled();
    });

    it("types /remote-control and leaves the prompt on the clipboard", async () => {
      // Same contract as the panel: the slash command cannot be stacked ahead of
      // a prompt in one submission, so the prompt travels by clipboard.
      setupMatchingPlan({ remoteControl: true });
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
      expect(terminalAt().sendText.mock.calls[1][0]).toBe(
        `${BRACKET_ON}/remote-control PROJ-1${BRACKET_OFF}`,
      );
      expect(terminalAt().sendText.mock.calls[1][1]).toBe(false);
      // The user is told what to press.
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Remote Control"),
      );
    });

    it("gives each task in a batch its own named terminal", async () => {
      workspace.workspaceFile = { scheme: "file", fsPath: "/ws/PROJ-1.code-workspace" };
      readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-2-1.json"] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes("PROJ-1")
          ? planJson({ key: "PROJ-1", seq: 0 })
          : planJson({ key: "PROJ-2", seq: 1 }),
      );
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal.mock.calls.map((c) => c[0]?.name)).toEqual([
        "Claude · PROJ-1",
        "Claude · PROJ-2",
      ]);
    });
  });

  describe("seedAgentSession — copilot terminal", () => {
    beforeEach(() => {
      env.uriScheme = "vscode";
      setConfig({ agentProvider: "copilot", agentSurface: "terminal" });
      window.createTerminal.mockClear();
    });

    afterEach(() => {
      env.uriScheme = "cursor";
      setConfig({ agentProvider: undefined, agentSurface: undefined });
    });

    it("names the terminal for Copilot and runs the copilot CLI", async () => {
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal).toHaveBeenCalledTimes(1);
      expect(window.createTerminal.mock.calls[0][0]).toMatchObject({ name: "Copilot · PROJ-1" });
      expect(terminalAt(0).sendText).toHaveBeenNthCalledWith(1, "copilot", true);
    });

    it("pre-types the prompt on the Copilot terminal only after its own boot delay, without submitting it", async () => {
      // Tied to the terminal actually named for Copilot (not "whichever terminal
      // was created first") and to copilot's own 2000ms bootMs, so this goes red
      // if the copilot branch ever falls back to claude's CLI/table entry or its
      // 1500ms delay.
      setupMatchingPlan();
      const { context } = fakeContext();

      vi.useFakeTimers();
      try {
        const pending = maybeSeedAgent(context, () => {});

        // Flush the synchronous-through-microtasks work — seedPass chaining,
        // globalState.update, terminal creation, and the CLI sendText — which all
        // happens before the boot-delay setTimeout is armed.
        await vi.advanceTimersByTimeAsync(0);

        const i = window.createTerminal.mock.calls.findIndex((c) => c[0]?.name === "Copilot · PROJ-1");
        expect(i).toBeGreaterThanOrEqual(0);
        const t = terminalAt(i);
        expect(t.sendText).toHaveBeenNthCalledWith(1, "copilot", true);
        expect(t.sendText).toHaveBeenCalledTimes(1); // paste not typed yet — still inside the boot delay

        await vi.advanceTimersByTimeAsync(1999); // one tick short of copilot's 2000ms bootMs
        expect(t.sendText).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1); // bootMs elapses
        expect(t.sendText).toHaveBeenCalledTimes(2);
        const [text, addNewLine] = t.sendText.mock.calls[1];
        expect(addNewLine).toBe(false);
        expect(text).toContain("[200~");

        await pending;
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses Claude's terminal name and CLI when the provider is unset", async () => {
      setConfig({ agentProvider: undefined });
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.createTerminal.mock.calls[0][0]).toMatchObject({ name: "Claude · PROJ-1" });
      expect(terminalAt(0).sendText).toHaveBeenNthCalledWith(1, "claude", true);
    });
  });

  it("uses the extension panel and no terminal when agentSurface is unset", async () => {
    setConfig({ agentSurface: undefined });
    window.createTerminal.mockClear();
    setupMatchingPlan();
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(window.createTerminal).not.toHaveBeenCalled();
  });

  describe("seedAgentSession — copilot panel", () => {
    const CHAT_OPEN_CMD = "workbench.action.chat.open";

    beforeEach(() => {
      env.uriScheme = "vscode";
      setConfig({ agentProvider: "copilot", agentSurface: undefined });
      commands.getCommands.mockResolvedValue([CHAT_OPEN_CMD]);
      // These tests describe a host where Copilot Chat IS installed. The mock
      // resets getExtension to undefined per test, which — before the gate in
      // seedChatPanel existed — silently meant "not installed" and the tests
      // passed only because core VS Code registers the command anyway.
      extensions.getExtension.mockReturnValue({ packageJSON: {} });
    });

    afterEach(() => {
      env.uriScheme = "cursor";
      setConfig({ agentProvider: undefined });
    });

    it("falls back to the clipboard when Copilot Chat is not installed, even though core registers the command", async () => {
      // The bug this pins: VS Code >=1.9x registers workbench.action.chat.open
      // with no chat extension installed, so command presence proves nothing.
      // Without the extension the seed must take the documented clipboard
      // fallback instead of executing a command that visibly does nothing.
      extensions.getExtension.mockReturnValue(undefined);
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(commands.executeCommand).not.toHaveBeenCalledWith(CHAT_OPEN_CMD, expect.anything());
      expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
    });

    it("asks for the extension by the chat panel's own id", async () => {
      // GitHub.copilot alone has no chat panel; GitHub.copilot-chat is what
      // registers the UI the seed opens. Pin the id so a refactor cannot
      // quietly gate on the wrong extension.
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(extensions.getExtension).toHaveBeenCalledWith("GitHub.copilot-chat");
    });

    it("opens chat with the prompt prefilled and unsubmitted", async () => {
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(commands.executeCommand).toHaveBeenCalledWith(
        CHAT_OPEN_CMD,
        expect.objectContaining({ isPartialQuery: true, mode: "agent" }),
      );
      const arg = commands.executeCommand.mock.calls.find((c) => c[0] === CHAT_OPEN_CMD)?.[1] as {
        query: string;
      };
      expect(arg.query).toContain("do it");
    });

    it('logs "opened Copilot Chat via" on success, byte-identical to the pre-Cursor wording', async () => {
      // Regression guard for a real drift: seedChatPanel's success log used to be a
      // hardcoded "opened Copilot Chat via ...". Generalizing it for Cursor via
      // providerLabel(provider) silently changed the Copilot text to "opened Copilot
      // via ..." — "Copilot Chat" is the chat panel's own product name and is NOT
      // what providerLabel("copilot") returns ("Copilot"). No test caught that until
      // this one, so it has to pin the exact string, not just check it mentions
      // Copilot.
      setupMatchingPlan();
      const { context } = fakeContext();
      const logs: string[] = [];

      await maybeSeedAgent(context, (m) => logs.push(m));

      expect(logs).toContain(`seed PROJ-1: opened Copilot Chat via ${CHAT_OPEN_CMD} (attempt 1)`);
    });

    it("never calls Claude Code's open command", async () => {
      // Asserted on the command id alone, independent of argument shape: Claude's
      // real call is executeCommand(cmd, undefined, seedText), and expect.anything()
      // never matches `undefined` — an argument-shaped matcher here would be
      // trivially true even if this branch called Claude's command directly.
      // Covers both Claude command ids: the multi-session path prefers
      // "claude-vscode.editor.open" over "claude-vscode.primaryEditor.open".
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      const claudeCmdIds = new Set([CLAUDE_OPEN_CMD, "claude-vscode.editor.open"]);
      const claudeCalls = commands.executeCommand.mock.calls.filter((c) => claudeCmdIds.has(String(c[0])));
      expect(claudeCalls).toEqual([]);
    });

    it("falls back to the clipboard when no chat command is registered", async () => {
      commands.getCommands.mockResolvedValue([]);
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(env.clipboard.writeText).toHaveBeenCalled();
      expect(window.showInformationMessage).toHaveBeenCalled();
    });

    it("names Copilot, not Claude Code, in the clipboard-fallback notification", async () => {
      commands.getCommands.mockResolvedValue([]);
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        "Agent Flow Deck: opened workspace for PROJ-1. Copilot prompt copied — paste it into the panel to start.",
      );
    });

    it("does not try the Claude Code URI handler", async () => {
      commands.getCommands.mockResolvedValue([]);
      setupMatchingPlan();
      const { context } = fakeContext();

      await seedWithTimers(context);

      expect(env.openExternal).not.toHaveBeenCalled();
    });

    it("degrades to the clipboard when the chat-open command probe throws on every attempt", async () => {
      // Exercises seedCopilotPanel's own catch (workspace.ts:779-781): the probe
      // itself rejects — not merely "the command isn't registered yet" — and the
      // seeding path must still degrade the same way as "no chat command", not
      // hang or leave an unhandled rejection.
      commands.getCommands.mockRejectedValue(new Error("registry unavailable"));
      setupMatchingPlan();
      const { context } = fakeContext();
      const logs: string[] = [];

      vi.useFakeTimers();
      try {
        const pending = maybeSeedAgent(context, (m) => logs.push(m));
        await vi.runAllTimersAsync();
        await pending;
      } finally {
        vi.useRealTimers();
      }

      // The catch really ran — on the very first polling attempt, not just
      // "eventually gave up" — which is what proves the rejection was caught
      // rather than left to surface as an unhandled rejection.
      expect(logs.some((m) => m.includes("copilot command attempt 1 threw"))).toBe(true);
      // It never managed to open Copilot Chat.
      expect(commands.executeCommand).not.toHaveBeenCalledWith(CHAT_OPEN_CMD, expect.anything());
      // The seeding path degrades exactly like "no chat command registered": the
      // prompt lands on the clipboard and the user is told to paste it.
      expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        "Agent Flow Deck: opened workspace for PROJ-1. Copilot prompt copied — paste it into the panel to start.",
      );
    });

    it("tries the chat-open command exactly once when it is registered but throws, then falls back to the clipboard", async () => {
      // Once CHAT_OPEN_CMD is found registered, a throw from executeCommand is a real
      // failure on its merits (e.g. the still-unverified argument shape), not the
      // activation race the 7x/700ms retry loop exists to ride out (that race is
      // "command not yet registered", covered by the getCommands-throws test above).
      // Retrying a call that fails on its merits would stall ~4.9s and could reopen
      // the chat panel on every attempt — so this pins exactly ONE executeCommand
      // call for CHAT_OPEN_CMD before the seeding path degrades to the clipboard.
      commands.getCommands.mockResolvedValue([CHAT_OPEN_CMD]);
      commands.executeCommand.mockImplementation((cmd: unknown) =>
        cmd === CHAT_OPEN_CMD ? Promise.reject(new Error("bad argument shape")) : Promise.resolve(undefined),
      );
      setupMatchingPlan();
      const { context } = fakeContext();
      const logs: string[] = [];

      vi.useFakeTimers();
      try {
        const pending = maybeSeedAgent(context, (m) => logs.push(m));
        await vi.runAllTimersAsync();
        await pending;
      } finally {
        vi.useRealTimers();
      }

      const chatCalls = commands.executeCommand.mock.calls.filter((c) => c[0] === CHAT_OPEN_CMD);
      expect(chatCalls).toHaveLength(1);
      expect(logs.some((m) => m.includes("registered but threw"))).toBe(true);
      expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        "Agent Flow Deck: opened workspace for PROJ-1. Copilot prompt copied — paste it into the panel to start.",
      );
    });
  });

  // No editor command that opens a Copilot chat tab with a prefilled query has been
  // verified to exist (Task 2's dev-host spike hasn't run), so a Copilot batch must
  // degrade to the brief notification rather than ever touching the single-instance
  // panel command — that would silently overwrite every task's prompt but the last.
  describe("seedAgentSession — copilot batch", () => {
    const CHAT_OPEN_CMD = "workbench.action.chat.open";

    beforeEach(() => {
      env.uriScheme = "vscode";
      setConfig({ agentProvider: "copilot", agentSurface: undefined });
      commands.getCommands.mockResolvedValue([CHAT_OPEN_CMD]);
      // These tests describe a host where Copilot Chat IS installed. The mock
      // resets getExtension to undefined per test, which — before the gate in
      // seedChatPanel existed — silently meant "not installed" and the tests
      // passed only because core VS Code registers the command anyway.
      extensions.getExtension.mockReturnValue({ packageJSON: {} });
    });

    afterEach(() => {
      env.uriScheme = "cursor";
      setConfig({ agentProvider: undefined });
    });

    /** Seed two matching plans in one pass (the file's batch pattern — see
     * "seeds every plan matching this window" above), with the polling delay
     * faked away so the test doesn't burn real seconds. */
    const seedTwoTasks = async (key1: string, key2: string) => {
      workspace.workspaceFile = { scheme: "file", fsPath: "/ws/PROJ-1.code-workspace" };
      readdirSync.mockReturnValue([`${key1}-1.json`, `${key2}-1.json`] as never);
      readFileSync.mockImplementation((p) =>
        String(p).includes(key1)
          ? planJson({
              key: key1,
              seq: 0,
              matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: `Start ${key1}` }],
            })
          : planJson({
              key: key2,
              seq: 1,
              matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: `Start ${key2}` }],
            }),
      );
      const { context } = fakeContext();
      vi.useFakeTimers();
      try {
        const pending = maybeSeedAgent(context, () => {});
        await vi.runAllTimersAsync();
        await pending;
      } finally {
        vi.useRealTimers();
      }
    };

    it("never reuses the single-instance panel for a batch", async () => {
      await seedTwoTasks("PROJ-1", "PROJ-2");
      expect(commands.executeCommand).not.toHaveBeenCalledWith(CHAT_OPEN_CMD, expect.anything());
    });

    it("returns false immediately, without polling for a chat command", async () => {
      // The multi guard short-circuits before the poll loop — proven here by asserting
      // getCommands is never even called, not just that its result goes unused.
      await seedTwoTasks("PROJ-1", "PROJ-2");
      expect(commands.getCommands).not.toHaveBeenCalled();
    });

    it("points at the briefs for each task, with the clipboard withheld", async () => {
      // One clipboard can't carry two prompts — this is the fallback maybeSeedAgent's
      // multi path already uses for Claude Code, and a Copilot batch must land here too.
      await seedTwoTasks("PROJ-1", "PROJ-2");
      expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining(BRIEF_DIR));
      expect(window.showInformationMessage).toHaveBeenCalledTimes(2); // one per task
      expect(env.clipboard.writeText).not.toHaveBeenCalled();
    });

    // Task 5 routes a Copilot batch onto this exact notification, so it must name
    // Copilot rather than the Claude Code wording that shipped before providers existed.
    it("names Copilot, not Claude Code, in the batch fallback notification", async () => {
      await seedTwoTasks("PROJ-1", "PROJ-2");
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Agent Flow Deck: couldn't start Copilot for PROJ-1."),
      );
      expect(window.showInformationMessage).toHaveBeenCalledWith(
        expect.stringContaining("Agent Flow Deck: couldn't start Copilot for PROJ-2."),
      );
    });
  });
});

describe("Cursor seeding (via maybeSeedAgent)", () => {
  const CHAT_CMD = "workbench.action.chat.open";

  const planJson = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      key: "PROJ-1",
      createdAt: Date.now(),
      seedAgent: true,
      matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "do it" }],
      ...over,
    });

  const withWorkspaceFile = () => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/PROJ-1.code-workspace" };
  };

  beforeEach(() => {
    setConfig({ agentProvider: "cursor" });
    env.uriScheme = "cursor";
  });

  it("opens a Cursor composer with the prompt pre-filled and unsubmitted", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson());
    commands.getCommands.mockResolvedValue([CHAT_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CHAT_CMD, {
      query: "do it",
      isPartialQuery: true,
      mode: "agent",
    });
  });

  it("seeds every task of a batch, unlike Copilot", async () => {
    // Cursor's handler calls createComposer({ openInNewTab: true }), so N calls give
    // N tabs. Copilot's panel is single-instance and bails to the briefs instead.
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-1.json", "PROJ-1-2.json"] as never);
    readFileSync
      .mockReturnValueOnce(planJson({ seq: 0, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "first" }] }))
      .mockReturnValueOnce(planJson({ key: "PROJ-2", seq: 1, matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "second" }] }));
    commands.getCommands.mockResolvedValue([CHAT_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    const queries = commands.executeCommand.mock.calls
      .filter((c: unknown[]) => c[0] === CHAT_CMD)
      .map((c: unknown[]) => (c[1] as { query: string }).query);
    expect(queries).toEqual(["first", "second"]);
  });

  it("runs cursor-agent on the terminal surface", async () => {
    setConfig({ agentProvider: "cursor", agentSurface: "terminal" });
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ matches: [{ matchPath: "/repo", prompt: "do it" }] }));
    workspace.workspaceFile = undefined;
    workspace.workspaceFolders = [{ uri: { fsPath: "/repo" } }];
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(window.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Cursor · PROJ-1" }),
    );
    const terminal = window.createTerminal.mock.results[0].value;
    expect(terminal.sendText).toHaveBeenCalledWith("cursor-agent", true);
  });

  it("refuses Remote Control under cursor, as it does under copilot", async () => {
    withWorkspaceFile();
    readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
    readFileSync.mockReturnValue(planJson({ remoteControl: true }));
    commands.getCommands.mockResolvedValue([CHAT_CMD]);
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Remote Control needs Claude Code"),
    );
    expect(commands.executeCommand).not.toHaveBeenCalledWith(CHAT_CMD, expect.anything());
  });
});

describe("seedClaudeCode — remote control", () => {
  const seedPlan = (over: Record<string, unknown> = {}) => {
    workspace.workspaceFile = { scheme: "file", fsPath: "/ws/PROJ-1.code-workspace" };
    readdirSync.mockReturnValue(["PROJ-1-1.json"] as never);
    readFileSync.mockReturnValue(
      JSON.stringify({
        key: "PROJ-1",
        createdAt: Date.now(),
        seedAgent: true,
        matches: [{ matchPath: "/ws/PROJ-1.code-workspace", prompt: "do it" }],
        ...over,
      }),
    );
    commands.getCommands.mockResolvedValue([CLAUDE_OPEN_CMD]);
  };

  it("seeds the slash command and puts the task prompt on the clipboard", async () => {
    seedPlan({ remoteControl: true });
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "/remote-control PROJ-1");
    expect(env.clipboard.writeText).toHaveBeenCalledWith("do it");
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining("Remote Control"));
  });

  // The seed-time backstop. tasksView refuses the combination pre-flight, but a plan
  // file written under Claude Code can outlive a flip to Copilot, and the plan does
  // not carry the provider — it is re-read here, in the target window.
  describe("the Copilot provider", () => {
    beforeEach(() => {
      env.uriScheme = "vscode";
      setConfig({ agentProvider: "copilot" });
      window.createTerminal.mockClear();
    });

    afterEach(() => {
      env.uriScheme = "cursor";
      setConfig({ agentProvider: undefined });
    });

    it("refuses to seed Remote Control, opening no session at all", async () => {
      seedPlan({ remoteControl: true });
      const { context } = fakeContext();

      await maybeSeedAgent(context, () => {});

      expect(commands.executeCommand).not.toHaveBeenCalledWith("workbench.action.chat.open", expect.anything());
      expect(window.createTerminal).not.toHaveBeenCalled();
      // Refusing means refusing everything: no half-seed via the clipboard fallback,
      // and no "press Enter to connect" notice for a session that never opened.
      expect(env.clipboard.writeText).not.toHaveBeenCalled();
      expect(window.showInformationMessage).not.toHaveBeenCalled();
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining("Remote Control needs Claude Code"),
      );
    });

    it("tells the user to re-take the task, not to reload", async () => {
      // runSeedPass sets this plan's `seeded:` guard BEFORE calling seedAgentSession
      // and nothing clears it before the TTL, so "fix the setting and reload" would be
      // advice that cannot work. The message must not imply it.
      seedPlan({ remoteControl: true });
      const { context } = fakeContext();

      await maybeSeedAgent(context, () => {});

      const msg = String(window.showErrorMessage.mock.calls[0][0]);
      expect(msg).toContain("take PROJ-1 again");
      expect(msg).toContain("reloading this window won't re-seed it");
    });

    it("really has consumed the plan, so the advice above is the only thing that works", async () => {
      // Pins the premise rather than trusting it: seed once (refused), then flip to
      // Claude Code and seed again from the SAME plan and window. Nothing happens —
      // which is exactly why the message cannot promise a reload will help.
      seedPlan({ remoteControl: true });
      const { context } = fakeContext();
      await maybeSeedAgent(context, () => {});

      setConfig({ agentProvider: undefined }); // the user "fixes the setting"
      commands.executeCommand.mockClear();
      await maybeSeedAgent(context, () => {}); // and reloads

      expect(commands.executeCommand).not.toHaveBeenCalledWith(
        CLAUDE_OPEN_CMD,
        undefined,
        "/remote-control PROJ-1",
      );
    });

    it("still seeds a plan that does not ask for Remote Control", async () => {
      // The regression guard on the backstop's condition: `remoteControl &&` must be
      // load-bearing, or every Copilot seed would be refused.
      seedPlan({ remoteControl: false });
      commands.getCommands.mockResolvedValue(["workbench.action.chat.open"]);
      extensions.getExtension.mockReturnValue({ packageJSON: {} }); // Copilot Chat installed here
      const { context } = fakeContext();

      await maybeSeedAgent(context, () => {});

      expect(commands.executeCommand).toHaveBeenCalledWith("workbench.action.chat.open", expect.anything());
      expect(window.showErrorMessage).not.toHaveBeenCalled();
    });
  });

  it("seeds the prompt and leaves the clipboard alone when not requested", async () => {
    seedPlan({ remoteControl: false });
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
    // Removing the `if (!remoteControl) return` guard in announceRemoteControl would still
    // pass every assertion above — this is what actually catches that regression.
    expect(window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("treats an absent remoteControl flag as off", async () => {
    seedPlan();
    const { context } = fakeContext();

    await maybeSeedAgent(context, () => {});

    expect(commands.executeCommand).toHaveBeenCalledWith(CLAUDE_OPEN_CMD, undefined, "do it");
    expect(env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("sends the slash command through the URI handler too", async () => {
    vi.useFakeTimers();
    try {
      seedPlan({ remoteControl: true });
      commands.getCommands.mockResolvedValue([]); // command never registers
      env.openExternal.mockResolvedValue(true);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await p;

      const uri = String(vi.mocked(env.openExternal).mock.calls[0][0]);
      expect(uri).toContain(encodeURIComponent("/remote-control PROJ-1"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops Remote Control and keeps the task prompt when it falls back to the clipboard", async () => {
    vi.useFakeTimers();
    try {
      seedPlan({ remoteControl: true });
      commands.getCommands.mockResolvedValue([]);
      env.openExternal.mockResolvedValue(false);
      const { context } = fakeContext();

      const p = maybeSeedAgent(context, () => {});
      await vi.runAllTimersAsync();
      await p;

      // the prompt — not the slash command — is what the user is told to paste
      expect(env.clipboard.writeText).toHaveBeenLastCalledWith("do it");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchPlansAndSeed", () => {
  it("debounces plan-dir changes and re-runs seeding, and disposes cleanly", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      let fire: (() => void) | undefined;
      watch.mockImplementation(((_dir: string, cb: () => void) => {
        fire = cb;
        return { close } as unknown as fs.FSWatcher;
      }) as never);
      // Resolve a single-workspace identity so maybeSeedAgent proceeds far enough to
      // read the plan dir; readdirSync (no plan files, per the default mock) is the
      // observable signal for "ran once" that lets this test prove the debounce.
      workspace.workspaceFile = { scheme: "file", fsPath: "/ws/PROJ-1.code-workspace" };

      const disp = watchPlansAndSeed(fakeContext().context, () => {});
      expect(fs.mkdirSync).toHaveBeenCalled(); // ensured PLAN_DIR exists

      fire!();
      fire!(); // two rapid changes
      expect(readdirSync).not.toHaveBeenCalled(); // still debounced — timer hasn't fired yet
      // Async: maybeSeedAgent now chains onto a module-level promise (serializing
      // passes), so invoking it needs a flushed microtask, not just the timer firing.
      await vi.advanceTimersByTimeAsync(300);
      expect(readdirSync).toHaveBeenCalledTimes(1); // maybeSeedAgent read the plan dir once (debounced)

      disp.dispose();
      expect(close).toHaveBeenCalled(); // closes the real fs.watch, which stops further callbacks
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a pending debounce timer on dispose so it never fires", async () => {
    vi.useFakeTimers();
    try {
      const close = vi.fn();
      let fire: (() => void) | undefined;
      watch.mockImplementation(((_dir: string, cb: () => void) => {
        fire = cb;
        return { close } as unknown as fs.FSWatcher;
      }) as never);
      workspace.workspaceFile = { scheme: "file", fsPath: "/ws/PROJ-1.code-workspace" };

      const disp = watchPlansAndSeed(fakeContext().context, () => {});
      fire!(); // schedules a debounced maybeSeedAgent call
      disp.dispose(); // must clear that pending timer before it fires
      await vi.advanceTimersByTimeAsync(300);
      expect(readdirSync).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mergeReposIntoWorkspace", () => {
  const repos = mkRepos(["account-service", "webapp"]); // paths: /repos/account-service, /repos/webapp

  it("appends only missing repos and preserves comments + settings", () => {
    readFileSync.mockReturnValue(
      '{\n  // my workspace\n  "folders": [{ "name": "webapp", "path": "/repos/webapp" }],\n  "settings": { "editor.tabSize": 2 }\n}\n',
    );
    let written = "";
    writeFileSync.mockImplementation((_p, data) => { written = String(data); });

    const res = mergeReposIntoWorkspace("/ws/PROJ-1.code-workspace", repos);

    expect(res).toEqual({ added: ["account-service"], ok: true });
    expect(written).toContain("// my workspace");            // comment preserved
    expect(written).toContain('"editor.tabSize": 2');        // settings preserved
    expect(written).toContain('"path": "/repos/account-service"'); // repo added
    // webapp present exactly once (not duplicated)
    expect(written.match(/\/repos\/webapp/g)?.length).toBe(1);
  });

  it("is idempotent — no write when all repos already present", () => {
    readFileSync.mockReturnValue(
      '{ "folders": [{ "path": "/repos/account-service" }, { "path": "/repos/webapp" }] }',
    );
    const res = mergeReposIntoWorkspace("/ws/PROJ-1.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: true });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("resolves relative existing-folder paths against the workspace dir", () => {
    // workspace lives in /repos, folder path "webapp" → /repos/webapp (already present)
    readFileSync.mockReturnValue('{ "folders": [{ "path": "webapp" }] }');
    writeFileSync.mockImplementation(() => {});
    const res = mergeReposIntoWorkspace("/repos/team.code-workspace", repos);
    expect(res.added).toEqual(["account-service"]); // webapp matched via relative resolution
  });

  it("does NOT write on unparseable input (ok:false)", () => {
    readFileSync.mockReturnValue("{ this is : not json");
    const res = mergeReposIntoWorkspace("/ws/bad.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("does NOT write when the file can't be read (ok:false)", () => {
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    const res = mergeReposIntoWorkspace("/ws/missing.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
  });

  it("degrades gracefully when the workspace root is a JSON array (valid JSON, wrong shape)", () => {
    readFileSync.mockReturnValue("[]");
    const res = mergeReposIntoWorkspace("/ws/array.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("degrades gracefully when folders is a string (valid JSON, wrong shape)", () => {
    readFileSync.mockReturnValue('{ "folders": "nope" }');
    const res = mergeReposIntoWorkspace("/ws/bad-folders-string.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("degrades gracefully when folders is an object (valid JSON, wrong shape)", () => {
    readFileSync.mockReturnValue('{ "folders": {} }');
    const res = mergeReposIntoWorkspace("/ws/bad-folders-object.code-workspace", repos);
    expect(res).toEqual({ added: [], ok: false });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("refuses a folder nested inside an existing root, even when handed one directly", () => {
    // The write layer is the last line of defense: a caller that skips planWorkspaceMerge
    // must still not be able to nest a root inside a root.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/Users/me/projects" }] }');
    const res = mergeReposIntoWorkspace("/ws/t.code-workspace", [
      { name: "webapp", path: "/Users/me/projects/webapp/.claude/worktrees/PROJ-1" },
    ]);
    expect(res).toEqual({ added: [], ok: true });
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("still writes a folder that is inside no existing root", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/Users/me/projects" }] }');
    const res = mergeReposIntoWorkspace("/ws/t.code-workspace", [
      { name: "infra", path: "/elsewhere/infra" },
    ]);
    expect(res).toEqual({ added: ["infra"], ok: true });
    const written = String(writeFileSync.mock.calls[0][1]);
    expect(written).toContain("/elsewhere/infra");
  });

  it("does not let a root swallow a sibling sharing its prefix", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/api" }] }');
    const res = mergeReposIntoWorkspace("/ws/t.code-workspace", [
      { name: "api-gateway", path: "/repos/api-gateway" },
    ]);
    expect(res).toEqual({ added: ["api-gateway"], ok: true });
  });
});

describe("openWorkspace — existing workspace", () => {
  it("merges exactly foldersToAdd — never anything derived from services", async () => {
    // foldersToAdd names a repo that's in neither `services` nor the file, so a
    // regression to deriving the merge from `services` (which would settle on
    // account-service, the one of the two not already declared) is caught: it
    // wouldn't match "infra".
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/webapp" }] }' : "",
    );

    const result = await openWorkspace(
      baseReq({
        existingWorkspaceFile: "/ws/team.code-workspace",
        foldersToAdd: [{ name: "infra", path: "/repos/infra" }],
      }),
    );

    expect(result.mode).toBe("multiroot");
    expect(result.workspaceFile).toBe("/ws/team.code-workspace");
    expect(result.mergedRepos).toEqual(["infra"]);
    expect(result.mergeFailed).toBeUndefined();
    expect(writeArg((p) => p.endsWith("PROJ-1.code-workspace"))).toBeUndefined();
    expect(result.opened).toContain("/ws/team.code-workspace");
  });

  it("reports mergeFailed when the picked file is unparseable and still opens it", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? "{ broken" : "",
    );
    const result = await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/bad.code-workspace" }));
    expect(result.mergeFailed).toBe(true);
    expect(result.opened).toContain("/ws/bad.code-workspace");
  });

  it("seeds a plan whose matchPath is the picked workspace", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [] }' : "",
    );
    await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace" }));
    const planCall = writeArg((p) => p.includes("/.agentflow/plans/"));
    expect(planCall).toBeDefined();
    expect(String(planCall![1])).toContain('"matchPath": "/ws/team.code-workspace"');
  });

  it("leaves the file untouched when foldersToAdd is absent", async () => {
    // The user's workspace is their artifact: no approval, no write.
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/webapp" }] }' : "",
    );

    const result = await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace" }));

    expect(writeArg((p) => p.endsWith(".code-workspace"))).toBeUndefined();
    expect(result.mergedRepos).toEqual([]);
    expect(result.mergeFailed).toBeUndefined();
    expect(result.opened).toContain("/ws/team.code-workspace");
  });

  it("leaves the file untouched when foldersToAdd is empty", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/webapp" }] }' : "",
    );
    await openWorkspace(baseReq({ existingWorkspaceFile: "/ws/team.code-workspace", foldersToAdd: [] }));
    expect(writeArg((p) => p.endsWith(".code-workspace"))).toBeUndefined();
  });

  it("routes a worktree's mentions through its containing root", async () => {
    execSync.mockReturnValue("src/export.py\n"); // git ls-files
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/webapp" }] }' : "",
    );

    await openWorkspace(
      baseReq({
        services: [{ name: "webapp", path: "/repos/webapp/.claude/worktrees/PROJ-1", isGit: true }],
        descriptionText: "fix `src/export.py`",
        existingWorkspaceFile: "/ws/team.code-workspace",
      }),
    );

    const planWrite = writeArg((p) => p.includes("/.agentflow/plans/"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches[0].prompt).toContain("@webapp/.claude/worktrees/PROJ-1/src/export.py");
  });

  it("drops mentions for a repo that is inside no root", async () => {
    execSync.mockReturnValue("src/export.py\n");
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [{ "path": "/repos/webapp" }] }' : "",
    );

    await openWorkspace(
      baseReq({
        services: mkRepos(["infra"]),
        descriptionText: "fix `src/export.py`",
        existingWorkspaceFile: "/ws/team.code-workspace",
      }),
    );

    const plan = JSON.parse(String(writeArg((p) => p.includes("/.agentflow/plans/"))![1]));
    expect(plan.matches[0].prompt).not.toContain("Relevant files:");
    expect(plan.matches[0].prompt).not.toContain("@infra");
  });

  it("uses an absolute {brief} path, which a non-root repo's relative form can't provide", async () => {
    readFileSync.mockImplementation((p) =>
      String(p).endsWith(".code-workspace") ? '{ "folders": [] }' : "",
    );

    await openWorkspace(
      baseReq({
        services: mkRepos(["webapp"]),
        promptTemplate: "brief at {brief}",
        existingWorkspaceFile: "/ws/team.code-workspace",
      }),
    );

    const plan = JSON.parse(String(writeArg((p) => p.includes("/.agentflow/plans/"))![1]));
    expect(plan.matches[0].prompt).toBe("brief at /repos/webapp/.pick-task/TASK.md");
  });
});

describe("openWorkspace — existing folder window", () => {
  it("focuses the folder, seeds a matching plan, and reports repos not added as roots", async () => {
    // Two services; the open folder window is /repos/account-service.
    const result = await openWorkspace(
      baseReq({ existingFolder: "/repos/account-service" }),
    );

    expect(result.mode).toBe("per-window");
    expect(result.workspaceFile).toBeUndefined();
    expect(result.opened).toEqual(["/repos/account-service"]);
    // account-service IS the open folder; webapp can't be added as a root.
    expect(result.unaddedRepos).toEqual(["webapp"]);

    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0].matchPath).toBe("/repos/account-service");

    // The per-repo brief loop already writes account-service's TASK.md; the existingFolder
    // guard must not write a second one into the same folder.
    expect(
      writeFileSync.mock.calls.filter((c) => String(c[0]) === "/repos/account-service/.pick-task/TASK.md"),
    ).toHaveLength(1);
  });

  it("writes a brief into the target folder when it is not one of the repos", async () => {
    await openWorkspace(baseReq({ services: mkRepos(["solo"]), existingFolder: "/other/open-window" }));
    const brief = writeArg((p) => p === "/other/open-window/.pick-task/TASK.md");
    expect(brief).toBeTruthy();
    expect(String(brief![1])).toContain("PROJ-1");
  });

  // `absoluteBrief` exists for **Review with agent**: a review's brief belongs in the
  // review worktree, and the destination window is someone else's working repo. The
  // fallback write above would land a second brief in it — clobbering the one the agent
  // already working there was given, and pointing this launch's `{brief}` at it.
  describe("absoluteBrief", () => {
    const FALLBACK = "/other/open-window/.pick-task/TASK.md";

    it("writes no brief into the destination folder", async () => {
      await openWorkspace(baseReq({
        services: mkRepos(["solo"]), existingFolder: "/other/open-window", absoluteBrief: true,
      }));
      expect(writeArg((p) => p === FALLBACK)).toBeUndefined();
    });

    it("points the seeded {brief} at the launch's own brief instead", async () => {
      await openWorkspace(baseReq({
        services: mkRepos(["solo"]), existingFolder: "/other/open-window", absoluteBrief: true,
        promptTemplate: "brief at {brief}",
      }));
      const plan = JSON.parse(String(writeArg((p) => p.includes("/.agentflow/plans/"))![1]));
      expect(plan.matches[0].prompt).toBe("brief at /repos/solo/.pick-task/TASK.md");
    });

    // Nothing of ours is written there any more, so there is nothing to exclude — and
    // .git/info/exclude in a repo this launch does not own is not ours to append to.
    it("leaves the destination repo's git exclude alone", async () => {
      await openWorkspace(baseReq({
        services: mkRepos(["solo"]), existingFolder: "/other/open-window", absoluteBrief: true,
      }));
      expect(appendFileSync.mock.calls.some((c) => String(c[0]).startsWith("/other/open-window"))).toBe(false);
    });

    it("still focuses the destination window and seeds a plan match for it", async () => {
      const result = await openWorkspace(baseReq({
        services: mkRepos(["solo"]), existingFolder: "/other/open-window", absoluteBrief: true,
      }));
      expect(result.opened).toEqual(["/other/open-window"]);
      const plan = JSON.parse(String(writeArg((p) => p.includes("/.agentflow/plans/"))![1]));
      expect(plan.matches[0].matchPath).toBe("/other/open-window");
    });

    it("changes nothing when the destination IS one of the repos", async () => {
      // The per-repo brief loop already wrote this folder's brief; the flag has no
      // second write to suppress, and the plan must still name it.
      await openWorkspace(baseReq({
        services: mkRepos(["account-service"]), existingFolder: "/repos/account-service",
        absoluteBrief: true, promptTemplate: "brief at {brief}",
      }));
      expect(
        writeFileSync.mock.calls.filter((c) => String(c[0]) === "/repos/account-service/.pick-task/TASK.md"),
      ).toHaveLength(1);
      const plan = JSON.parse(String(writeArg((p) => p.includes("/.agentflow/plans/"))![1]));
      expect(plan.matches[0].prompt).toBe("brief at /repos/account-service/.pick-task/TASK.md");
    });
  });
});

describe("openWorkspace — keepExistingBrief", () => {
  const BRIEF = "/repos/account-service/.pick-task/TASK.md";
  /** The brief is already on disk, as it is in any worktree an agent is working in. */
  const briefExists = () =>
    existsSync.mockImplementation((p) => String(p).endsWith("/.git") || String(p) === BRIEF || String(p) === "/other/open-window/.pick-task/TASK.md");

  it("overwrites an existing brief by default — every caller before this flag relied on it", async () => {
    briefExists();
    await openWorkspace(baseReq({ services: mkRepos(["account-service"]) }));
    const brief = writeArg((p) => p === BRIEF);
    expect(brief).toBeTruthy();
    expect(String(brief![1])).toContain("PROJ-1");
  });

  it("leaves an existing brief untouched when asked to keep it", async () => {
    // A seed opens a SECOND agent in a worktree that is already working. That
    // worktree's TASK.md is the brief the running agent was given, and the file the
    // seeded prompt's {brief} resolves to — rewriting it destroys live, user-visible
    // content on an unattended path.
    briefExists();
    await openWorkspace(baseReq({ services: mkRepos(["account-service"]), keepExistingBrief: true }));
    expect(writeArg((p) => p === BRIEF)).toBeUndefined();
  });

  it("still writes a brief when none exists, even when asked to keep it", async () => {
    // "Keep" means never destroy, not never create: the seeded prompt's {brief} has to
    // resolve to something, and a place with no brief yet has nothing to preserve.
    await openWorkspace(baseReq({ services: mkRepos(["account-service"]), keepExistingBrief: true }));
    const brief = writeArg((p) => p === BRIEF);
    expect(brief).toBeTruthy();
  });

  it("reports the brief's path either way, so the seeded prompt can name it", async () => {
    briefExists();
    const kept = await openWorkspace(baseReq({ services: mkRepos(["account-service"]), keepExistingBrief: true }));
    expect(kept.briefs.map((b) => b.path)).toEqual([BRIEF]);
  });

  it("keeps the existingFolder fallback brief too", async () => {
    // The second write site: a target folder that is not one of `services`.
    briefExists();
    await openWorkspace(baseReq({
      services: mkRepos(["solo"]), existingFolder: "/other/open-window", keepExistingBrief: true,
    }));
    expect(writeArg((p) => p === "/other/open-window/.pick-task/TASK.md")).toBeUndefined();
  });
});

describe("openWorkspace — remote control", () => {
  const planOf = () => {
    const w = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    return JSON.parse(String(w![1]));
  };

  it("records remoteControl on the plan for a single-window launch", async () => {
    const result = await openWorkspace(baseReq({ remoteControl: true }));
    expect(result.remoteControl).toBe(true);
    expect(planOf().remoteControl).toBe(true);
  });

  it("records false when the launch did not ask", async () => {
    const result = await openWorkspace(baseReq());
    expect(result.remoteControl).toBe(false);
    expect(planOf().remoteControl).toBe(false);
  });

  it("withholds it when the launch opens more than one window", async () => {
    // per-window across two repos → two matches → two windows, one clipboard
    const result = await openWorkspace(baseReq({ mode: "per-window", remoteControl: true }));
    expect(planOf().matches).toHaveLength(2);
    expect(result.remoteControl).toBe(false);
    expect(planOf().remoteControl).toBe(false);
  });

  it("allows it for a per-window launch of a single repo", async () => {
    const result = await openWorkspace(
      baseReq({ mode: "per-window", services: mkRepos(["account-service"]), remoteControl: true }),
    );
    expect(planOf().matches).toHaveLength(1);
    expect(result.remoteControl).toBe(true);
  });

  it("withholds it when seedAgent is off — no plan file means nothing could ever seed it", async () => {
    const result = await openWorkspace(baseReq({ seedAgent: false, remoteControl: true }));
    expect(result.remoteControl).toBe(false);
    expect(writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"))).toBeUndefined();
  });
});
describe("openWorkspace — ask", () => {
  const planOf = () => {
    const w = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    return JSON.parse(String(w![1]));
  };

  // All three fixed settings, not just one: the picker is new behaviour that must stay
  // invisible to every user who never chose `ask`, and each value reaches the resolver
  // by its own branch.
  it.each([
    ["claude-code", "cursor"],
    ["copilot", "vscode"],
    ["cursor", "cursor"],
  ])("does not prompt under %s, and writes no provider to the plan", async (setting, scheme) => {
    setConfig({ agentProvider: setting });
    env.uriScheme = scheme;
    const result = await openWorkspace(baseReq({ seedAgent: true }));
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(result.provider).toBe(setting);
    // Absent, not the setting's value. The target window re-reads the preference live
    // at seed time, so flipping the setting still moves plans already sitting on disk —
    // only `ask` has no preference left to read and must pin its answer.
    expect(planOf().provider).toBeUndefined();
  });

  it("prompts under ask and writes the choice into the plan", async () => {
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "cursor";
    window.showQuickPick.mockResolvedValueOnce({ label: "Cursor", provider: "cursor" });
    const result = await openWorkspace(baseReq({ seedAgent: true }));
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe("cursor");
    expect(planOf().provider).toBe("cursor");
  });

  it("stamps the run record with the picked agent, not the setting's resolution", async () => {
    // `resolvedProvider("ask")` is pinned at "claude-code" regardless of what the
    // picker returns, so this is the one arrangement where the picked agent and the
    // setting's own resolution genuinely disagree. A stamp that reached for
    // `resolvedProvider(setting)` instead of the picked `provider` would still read
    // "claude-code" here and this is the only test that would catch it.
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "cursor";
    window.showQuickPick.mockResolvedValueOnce({ label: "Cursor", provider: "cursor" });
    await openWorkspace(baseReq({ seedAgent: true }));
    const runWrite = writeArg((p) => p.includes(".agentflow") && p.includes("runs") && p.endsWith(".json"));
    expect(runWrite).toBeTruthy();
    expect(JSON.parse(String(runWrite![1])).provider).toBe("cursor");
  });

  it("offers only the agents this host can run, under their product names", async () => {
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "cursor";
    window.showQuickPick.mockResolvedValueOnce({ label: "Cursor", provider: "cursor" });
    await openWorkspace(baseReq({ seedAgent: true }));
    const items = window.showQuickPick.mock.calls[0][0] as { label: string; provider: string }[];
    expect(items.map((i) => i.provider)).toEqual(["claude-code", "cursor"]);
    expect(items.map((i) => i.label)).toEqual(["Claude Code", "Cursor"]);
  });

  it("titles the picker exactly, and holds it open until it is answered", async () => {
    // The only new user-visible strings this feature adds, asserted whole so a renamed,
    // reworded or dropped key goes red. `title` is shared verbatim with the second
    // picker Task 6 adds, and `ignoreFocusOut` is what makes a pin load-bearing for an
    // unattended launch: without it a click elsewhere would dismiss this and cancel the
    // launch; with it an unattended `ask` launch waits rather than silently cancelling.
    setConfig({ agentProvider: "ask" });
    window.showQuickPick.mockResolvedValueOnce({ label: "Claude Code", provider: "claude-code" });
    await openWorkspace(baseReq({ seedAgent: true }));
    expect(window.showQuickPick.mock.calls[0][1]).toEqual({
      title: "Which tool?",
      placeHolder: "Pick the tool to start this session with",
      ignoreFocusOut: true,
    });
  });

  it("offers Copilot instead of Cursor on a VS Code host", async () => {
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "vscode";
    window.showQuickPick.mockResolvedValueOnce({ label: "Copilot", provider: "copilot" });
    const result = await openWorkspace(baseReq({ seedAgent: true }));
    const items = window.showQuickPick.mock.calls[0][0] as { provider: string }[];
    expect(items.map((i) => i.provider)).toEqual(["claude-code", "copilot"]);
    expect(result.provider).toBe("copilot");
    expect(planOf().provider).toBe("copilot");
  });

  it("honours a caller's pin under ask instead of prompting, and writes it into the plan", async () => {
    setConfig({ agentProvider: "ask" });
    const result = await openWorkspace(baseReq({ seedAgent: true, provider: "claude-code" }));
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(result.provider).toBe("claude-code");
    // A pin is a resolved `ask`, so it is pinned into the plan too — the target window
    // has no preference left to read either way.
    expect(planOf().provider).toBe("claude-code");
  });

  it("ignores a caller's pin under a fixed setting — the preference wins", async () => {
    // A pin replaces the PROMPT, not the preference. An Orchestrator rule pins Claude
    // Code only to avoid a dialog, and must still seed Cursor for a user whose setting
    // says `cursor`. Honouring it here would also make `OpenResult.provider` lie: the
    // plan carries no provider under a fixed setting, so the target window would read
    // the setting and seed Cursor while the toast named Claude Code.
    setConfig({ agentProvider: "cursor" });
    env.uriScheme = "cursor";
    const result = await openWorkspace(baseReq({ seedAgent: true, provider: "claude-code" }));
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(result.provider).toBe("cursor");
    expect(planOf().provider).toBeUndefined();
  });

  // A picker with one item is not a question — it is a modal, held open by
  // `ignoreFocusOut`, that can only be answered one way. On a host that is neither VS
  // Code nor Cursor, `hostProviders()` is exactly `["claude-code"]`, so `ask` there
  // used to raise that dialog on every single launch.
  it("does not prompt on a host with only one possible agent", async () => {
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "windsurf";
    const result = await openWorkspace(baseReq({ seedAgent: true }));
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(result.provider).toBe("claude-code");
    // Still a resolved `ask`, so the answer is pinned into the plan exactly as a
    // picked or caller-pinned one is.
    expect(planOf().provider).toBe("claude-code");
  });

  it("still prompts on a host with two possible agents", async () => {
    // The other half of the short-circuit: it must key on the LIST's length, not on
    // "ask is inert unless Cursor", or the picker would vanish in VS Code too.
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "vscode";
    window.showQuickPick.mockResolvedValueOnce({ label: "Copilot", provider: "copilot" });
    await openWorkspace(baseReq({ seedAgent: true }));
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
  });

  it("does not prompt when seeding is off", async () => {
    setConfig({ agentProvider: "ask" });
    const result = await openWorkspace(baseReq({ seedAgent: false }));
    expect(window.showQuickPick).not.toHaveBeenCalled();
    expect(result.provider).toBe("claude-code");
  });

  it("opens nothing when the picker is dismissed", async () => {
    setConfig({ agentProvider: "ask" });
    window.showQuickPick.mockResolvedValueOnce(undefined);
    const result = await openWorkspace(baseReq({ seedAgent: true }));
    expect(result.cancelled).toBe(true);
    expect(result.opened).toEqual([]);
    expect(mkdirSync).not.toHaveBeenCalled();     // no brief dir, no workspace dir, no plan dir
    expect(writeFileSync).not.toHaveBeenCalled(); // no brief, no .code-workspace, no plan, no run
    expect(appendFileSync).not.toHaveBeenCalled(); // no git-exclude entry
    expect(exec).not.toHaveBeenCalled();          // no `open -a`
    expect(commands.executeCommand).not.toHaveBeenCalledWith(
      "vscode.openFolder",
      expect.anything(),
      expect.anything(),
    );
  });

  it("drops Remote Control when ask resolves to a non-Claude agent", async () => {
    setConfig({ agentProvider: "ask" });
    env.uriScheme = "cursor";
    window.showQuickPick.mockResolvedValueOnce({ label: "Cursor", provider: "cursor" });
    const result = await openWorkspace(baseReq({ seedAgent: true, remoteControl: true }));
    expect(result.remoteControl).toBe(false);
    expect(planOf().remoteControl).toBe(false);
  });

  it("keeps Remote Control when ask resolves to Claude Code", async () => {
    setConfig({ agentProvider: "ask" });
    window.showQuickPick.mockResolvedValueOnce({ label: "Claude Code", provider: "claude-code" });
    const result = await openWorkspace(baseReq({ seedAgent: true, remoteControl: true }));
    expect(result.remoteControl).toBe(true);
    expect(planOf().remoteControl).toBe(true);
  });
});

describe("openWorkspace — this window", () => {
  const folderWindow = { identity: "/repos/account-service", kind: "folder" as const, roots: [{ name: "account-service", path: "/repos/account-service" }] };

  it("seeds this window without opening or reloading anything", async () => {
    const result = await openWorkspace(
      baseReq({ openIn: "current", currentWindow: folderWindow }),
    );

    // The whole point: no `open -a`, and no vscode.openFolder in either direction.
    expect(exec).not.toHaveBeenCalled();
    expect(commands.executeCommand).not.toHaveBeenCalledWith("vscode.openFolder", expect.anything(), expect.anything());

    expect(result.seededInPlace).toBe(true);
    expect(result.opened).toEqual(["/repos/account-service"]);
  });

  it("names this window's identity as the single plan match", async () => {
    await openWorkspace(baseReq({ openIn: "current", currentWindow: folderWindow }));
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches).toHaveLength(1);
    expect(plan.matches[0].matchPath).toBe("/repos/account-service");
  });

  // Two repos would normally be laid out as a multiroot workspace file. Here the window
  // already exists and is not being laid out, so nothing is written and nothing is opened.
  it("writes no .code-workspace even for a multi-repo take", async () => {
    const result = await openWorkspace(
      baseReq({ openIn: "current", currentWindow: folderWindow }),
    );
    expect(writeArg((p) => p.endsWith(".code-workspace"))).toBeUndefined();
    expect(result.workspaceFile).toBeUndefined();
  });

  it("takes the mode from the window's own shape, not the repo count", async () => {
    const wsWindow = { identity: "/ws/team.code-workspace", kind: "workspace" as const, roots: [{ name: "api", path: "/repos/api" }] };
    const folder = await openWorkspace(baseReq({ openIn: "current", currentWindow: folderWindow }));
    const ws = await openWorkspace(baseReq({ openIn: "current", currentWindow: wsWindow }));
    expect(folder.mode).toBe("per-window");
    expect(ws.mode).toBe("multiroot");
  });

  // One match means the single-window guard passes, so a multi-repo take can offer
  // Remote Control here — it couldn't when "current" produced one match per repo.
  it("keeps Remote Control available for a multi-repo take", async () => {
    const result = await openWorkspace(
      baseReq({ openIn: "current", currentWindow: folderWindow, remoteControl: true }),
    );
    expect(result.remoteControl).toBe(true);
  });

  it("uses an absolute brief path so {brief} resolves outside this window's roots", async () => {
    await openWorkspace(
      baseReq({
        openIn: "current",
        currentWindow: folderWindow,
        promptTemplate: "Brief: {brief}",
      }),
    );
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const plan = JSON.parse(String(planWrite![1]));
    expect(plan.matches[0].prompt).toContain("/repos/account-service/.pick-task/TASK.md");
  });

  it("mentions files under a root and drops files outside every root", async () => {
    execSync.mockReturnValue("src/export.py\n"); // git ls-files result
    await openWorkspace(
      baseReq({
        openIn: "current",
        currentWindow: folderWindow, // only account-service is a root; webapp is not
        descriptionText: "fix `src/export.py`",
        promptTemplate: "Go{files}",
      }),
    );
    const planWrite = writeArg((p) => p.includes(".agentflow") && p.includes("plans") && p.endsWith(".json"));
    const prompt = String(JSON.parse(String(planWrite![1])).matches[0].prompt);
    expect(prompt).toContain("@account-service/src/export.py");
    expect(prompt).not.toContain("@webapp/");
  });
});

describe("listWorkspaceFiles", () => {
  it("lists only .code-workspace files, newest first, with folder counts", () => {
    readdirSync.mockReturnValue(["b.code-workspace", "notes.txt", "a.code-workspace"] as never);
    statSync.mockImplementation((p) =>
      ({ isFile: () => true, mtimeMs: String(p).endsWith("a.code-workspace") ? 200 : 100 }) as unknown as fs.Stats,
    );
    readFileSync.mockImplementation((p) =>
      String(p).endsWith("a.code-workspace")
        ? '{ "folders": [{ "path": "x" }] }'
        : '{ /* c */ "folders": [{ "path": "y" }, { "path": "z" }] }',
    );

    const items = listWorkspaceFiles("/ws");

    expect(items.map((i) => i.file.split("/").pop())).toEqual(["a.code-workspace", "b.code-workspace"]);
    expect(items[0].folders).toBe(1);
    expect(items[1].folders).toBe(2);
  });

  it("returns [] when the directory can't be read", () => {
    readdirSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(listWorkspaceFiles("/nope")).toEqual([]);
  });

  it("tolerates an unparseable workspace file (folders = 0)", () => {
    readdirSync.mockReturnValue(["broken.code-workspace"] as never);
    statSync.mockReturnValue({ isFile: () => true, mtimeMs: 1 } as unknown as fs.Stats);
    readFileSync.mockReturnValue("{ not json");
    expect(listWorkspaceFiles("/ws")[0].folders).toBe(0);
  });

  it("excludes a directory entry named like a workspace file", () => {
    readdirSync.mockReturnValue(["dir.code-workspace"] as never);
    statSync.mockReturnValue({ isFile: () => false, mtimeMs: 5 } as unknown as fs.Stats);
    expect(listWorkspaceFiles("/ws")).toEqual([]);
  });
});

describe("workspaceFolders", () => {
  it("returns each folder's name and canonical path, resolved against the file's dir", () => {
    readFileSync.mockReturnValue(
      '{ "folders": [{ "name": "API", "path": "api" }, { "path": "/repos/webapp" }] }',
    );
    expect(workspaceFolders("/repos/team.code-workspace")).toEqual([
      { name: "API", path: "/repos/api" },
      { path: "/repos/webapp" },
    ]);
  });

  it("skips folders with no string path", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "name": "nameless" }, { "path": "/repos/webapp" }] }');
    expect(workspaceFolders("/ws/t.code-workspace")).toEqual([{ path: "/repos/webapp" }]);
  });

  it("distinguishes a valid empty folders array from a parse failure", () => {
    readFileSync.mockReturnValue('{ "folders": [] }');
    expect(workspaceFolders("/ws/empty.code-workspace")).toEqual([]);
  });

  it("treats an absent folders key as an empty workspace, not a parse failure", () => {
    readFileSync.mockReturnValue('{ "settings": {} }');
    expect(workspaceFolders("/ws/nofolders.code-workspace")).toEqual([]);
  });

  it("returns undefined when the file is unparseable", () => {
    readFileSync.mockReturnValue("{ this is : not json");
    expect(workspaceFolders("/ws/bad.code-workspace")).toBeUndefined();
  });

  it("returns undefined when the file can't be read", () => {
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(workspaceFolders("/ws/missing.code-workspace")).toBeUndefined();
  });

  it("returns undefined when folders is the wrong shape", () => {
    readFileSync.mockReturnValue('{ "folders": "nope" }');
    expect(workspaceFolders("/ws/bad-shape.code-workspace")).toBeUndefined();
  });
});

describe("planWorkspaceMerge", () => {
  const cand = (repoName: string, p: string, label = repoName): MergeCandidate => ({
    label,
    repoName,
    path: p,
  });

  it("buckets an already-declared path as present", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("webapp", "/repos/webapp")]);
    expect(plan.present.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.add).toEqual([]);
    expect(plan.duplicates).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  it("buckets a worktree of an already-declared repo as a duplicate, not an addition", () => {
    // The core case: same repo NAME, different path. A second root called `webapp`
    // is indistinguishable in the explorer and makes @webapp/… ambiguous.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("webapp", "/repos/webapp/.claude/worktrees/PROJ-1"),
    ]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.add).toEqual([]);
  });

  it("buckets a repo the workspace has by neither path nor name as an addition", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("infra", "/repos/infra")]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["infra"]);
    expect(plan.duplicates).toEqual([]);
  });

  it("dedups against a folder's custom name field", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "name": "webapp", "path": "/elsewhere/c" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("webapp", "/repos/webapp")]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["webapp"]);
  });

  it("dedups against a folder's path basename even when a custom name differs", () => {
    // servicesFromExistingDestination derives an unmatched folder's service name from
    // the BASENAME, so comparing only the `name` field would let a custom name defeat
    // the rule against the service derived from that very folder.
    readFileSync.mockReturnValue('{ "folders": [{ "name": "Custom Label", "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("webapp", "/repos/webapp/.claude/worktrees/PROJ-1"),
    ]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["webapp"]);
  });

  it("compares names case-insensitively", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "name": "API", "path": "/elsewhere/a" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("api", "/repos/api")]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["api"]);
  });

  it("dedups a key-qualified batch label against the bare repo name", () => {
    // The label written into the file is api-PROJ-1, but dedup must compare `api`.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/api" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("api", "/repos/api/.claude/worktrees/PROJ-1", "api-PROJ-1"),
    ]);
    expect(plan.duplicates.map((c) => c.label)).toEqual(["api-PROJ-1"]);
    expect(plan.add).toEqual([]);
  });

  it("offers everything when the workspace declares no folders", () => {
    readFileSync.mockReturnValue('{ "folders": [] }');
    const plan = planWorkspaceMerge("/ws/empty.code-workspace", [
      cand("api", "/repos/api"),
      cand("webapp", "/repos/webapp"),
    ]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["api", "webapp"]);
    expect(plan.ok).toBe(true);
  });

  it("offers everything when the folders key is absent entirely", () => {
    // A parseable file with no folders key is not a failure — mergeReposIntoWorkspace
    // has always accepted it. ok:false here would mean no prompt and no add at all.
    readFileSync.mockReturnValue('{ "settings": {} }');
    const plan = planWorkspaceMerge("/ws/nofolders.code-workspace", [cand("api", "/repos/api")]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["api"]);
    expect(plan.ok).toBe(true);
  });

  it("reports ok:false with empty buckets when the file is unparseable", () => {
    readFileSync.mockReturnValue("{ broken");
    const plan = planWorkspaceMerge("/ws/bad.code-workspace", [cand("api", "/repos/api")]);
    expect(plan).toEqual({ add: [], duplicates: [], redundant: [], present: [], ok: false });
  });

  it("never writes", () => {
    readFileSync.mockReturnValue('{ "folders": [] }');
    planWorkspaceMerge("/ws/t.code-workspace", [cand("api", "/repos/api")]);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it("skips a candidate nested inside a parent-directory root", () => {
    // The root is the repos parent, so no name matches — only containment can see this.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/Users/me/projects" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("webapp", "/Users/me/projects/webapp/.claude/worktrees/PROJ-1"),
    ]);
    expect(plan.redundant.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.add).toEqual([]);
    expect(plan.duplicates).toEqual([]);
  });

  it("skips a candidate nested inside a root the user renamed", () => {
    readFileSync.mockReturnValue(
      '{ "folders": [{ "name": "monorepo", "path": "/Users/me/projects" }] }',
    );
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("webapp", "/Users/me/projects/webapp"),
    ]);
    expect(plan.redundant.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.add).toEqual([]);
  });

  it("keeps name precedence: a worktree of a same-named root is still a duplicate", () => {
    // Regression guard on the precedence decision. This candidate satisfies BOTH rules;
    // moving it to `redundant` would change the launch toast's wording.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("webapp", "/repos/webapp/.claude/worktrees/PROJ-1"),
    ]);
    expect(plan.duplicates.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.redundant).toEqual([]);
  });

  it("keeps an exact root match in present, not redundant", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [cand("webapp", "/repos/webapp")]);
    expect(plan.present.map((c) => c.repoName)).toEqual(["webapp"]);
    expect(plan.redundant).toEqual([]);
  });

  it("still adds a repo that is inside no root and shares no name", () => {
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }] }');
    const plan = planWorkspaceMerge("/ws/t.code-workspace", [
      cand("infra", "/elsewhere/infra/.claude/worktrees/PROJ-1"),
    ]);
    expect(plan.add.map((c) => c.repoName)).toEqual(["infra"]);
    expect(plan.redundant).toEqual([]);
  });

  it("leaves redundant empty when the file cannot be parsed", () => {
    readFileSync.mockReturnValue("{ not json");
    const plan = planWorkspaceMerge("/ws/broken.code-workspace", [cand("api", "/repos/api")]);
    expect(plan.ok).toBe(false);
    expect(plan.redundant).toEqual([]);
    expect(plan.add).toEqual([]);
  });
});

describe("workspaceFolderPaths", () => {
  it("returns canonical folder paths, resolving relative paths against the file dir", () => {
    // realpathSync is mocked to identity in beforeEach, so canon() returns its input.
    readFileSync.mockReturnValue('{ "folders": [{ "path": "/repos/webapp" }, { "path": "account-service" }] }');
    const paths = workspaceFolderPaths("/repos/team.code-workspace");
    expect(paths).toEqual(["/repos/webapp", "/repos/account-service"]);
  });

  it("returns [] on unparseable input", () => {
    readFileSync.mockReturnValue("{ not json");
    expect(workspaceFolderPaths("/ws/bad.code-workspace")).toEqual([]);
  });

  it("returns [] when the file can't be read", () => {
    readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
    expect(workspaceFolderPaths("/ws/missing.code-workspace")).toEqual([]);
  });

  it("returns [] when folders is missing or not an array", () => {
    readFileSync.mockReturnValue('{ "settings": {} }');
    expect(workspaceFolderPaths("/ws/nofolders.code-workspace")).toEqual([]);
  });
});

describe("containingRoot", () => {
  const roots = (...paths: string[]) => paths.map((p) => ({ path: p }));

  it("matches a root exactly", () => {
    expect(containingRoot(roots("/repos/api"), "/repos/api")?.path).toBe("/repos/api");
  });

  it("matches a path nested one level under a root", () => {
    expect(containingRoot(roots("/repos/api"), "/repos/api/src")?.path).toBe("/repos/api");
  });

  it("matches a worktree several levels under a root", () => {
    expect(
      containingRoot(roots("/repos/api"), "/repos/api/.claude/worktrees/PROJ-1")?.path,
    ).toBe("/repos/api");
  });

  it("picks the deepest of two containing roots", () => {
    // VS Code resolves a path against its most specific root; so must we, or a mention
    // would name the outer root and point at the wrong tree.
    const found = containingRoot(roots("/repos", "/repos/api"), "/repos/api/src/x.ts");
    expect(found?.path).toBe("/repos/api");
  });

  it("does not let a root swallow a sibling that shares its prefix", () => {
    expect(containingRoot(roots("/repos/api"), "/repos/api-gateway")).toBeUndefined();
  });

  it("returns undefined for a path inside no root", () => {
    expect(containingRoot(roots("/repos/api"), "/elsewhere/web")).toBeUndefined();
  });

  it("returns undefined when there are no roots", () => {
    expect(containingRoot([], "/repos/api")).toBeUndefined();
  });
});

describe("mentionInWorkspace", () => {
  it("uses the root's own name when the repo IS a root", () => {
    const roots = [{ path: "/repos/webapp" }];
    expect(mentionInWorkspace(roots, "/repos/webapp", "src/x.ts")).toBe("@webapp/src/x.ts");
  });

  it("prefers a root's custom name field over its basename", () => {
    const roots = [{ name: "Webapp Service", path: "/repos/webapp" }];
    expect(mentionInWorkspace(roots, "/repos/webapp", "src/x.ts")).toBe("@Webapp Service/src/x.ts");
  });

  it("routes a worktree through its containing root", () => {
    // The whole point: the worktree is not a root, but it IS inside one, so the
    // mention can name it precisely instead of resolving to the main checkout.
    const roots = [{ path: "/repos/webapp" }];
    expect(mentionInWorkspace(roots, "/repos/webapp/.claude/worktrees/PROJ-1", "src/x.ts")).toBe(
      "@webapp/.claude/worktrees/PROJ-1/src/x.ts",
    );
  });

  it("picks the deepest containing root, matching VS Code's most-specific resolution", () => {
    const roots = [{ path: "/repos" }, { path: "/repos/webapp" }];
    expect(mentionInWorkspace(roots, "/repos/webapp/.claude/worktrees/PROJ-1", "src/x.ts")).toBe(
      "@webapp/.claude/worktrees/PROJ-1/src/x.ts",
    );
  });

  it("returns undefined when the repo is inside no root", () => {
    // Emitting @webapp/src/x.ts here would point the agent at a DIFFERENT checkout.
    const roots = [{ path: "/repos/webapp" }];
    expect(mentionInWorkspace(roots, "/repos/infra", "src/x.ts")).toBeUndefined();
  });

  it("returns undefined when there are no roots at all", () => {
    expect(mentionInWorkspace([], "/repos/webapp", "src/x.ts")).toBeUndefined();
  });

  it("does not treat a sibling with a shared prefix as containment", () => {
    const roots = [{ path: "/repos/api" }];
    expect(mentionInWorkspace(roots, "/repos/api-gateway", "src/x.ts")).toBeUndefined();
  });
});

describe("briefMarkdown — repo scope", () => {
  const ticket = { key: "PROJ-12", summary: "Isolate renew queue", url: "https://j/PROJ-12" };
  const services = [
    { name: "webapp", path: "/repos/webapp", isGit: true },
    { name: "infra", path: "/repos/infra", isGit: true },
  ];

  it("tells the agent the listed repos are the only scope", () => {
    // A ticket description naming a repo nobody checked out is the common case:
    // without this the agent goes hunting for `billing-svc` instead of working here.
    const plan = "## Ticket description\n\nMight also need changes in billing-svc.";
    const out = briefMarkdown(ticket, plan, services, "webapp", []);
    const scopeAt = out.indexOf("## Repos in scope");
    const ruleAt = out.indexOf("These are the only repos checked out for this task.");
    expect(scopeAt).toBeGreaterThan(-1);
    expect(ruleAt).toBeGreaterThan(scopeAt);
    expect(out).toContain("is a suggestion, not scope");
    expect(out).toContain("do not go looking");
  });

  it("still names every in-scope repo and marks the current one", () => {
    const out = briefMarkdown(ticket, "", services, "infra", []);
    expect(out).toContain("- `webapp` — /repos/webapp");
    expect(out).toContain("- `infra` — /repos/infra  ← you are here");
    expect(out).toContain("**Repos in scope:** webapp, infra");
  });
});

// ── writeBriefInto ─────────────────────────────────────────────────────────────
// A child worktree in orchestrator mode gets a brief but deliberately no window, so
// it cannot go through openWorkspace. Same two functions in the same order as the
// parent's brief: the caller renders `planMd` (engine/brief), this writes it.
describe("writeBriefInto", () => {
  const child: TicketRef = { key: "PROJ-2", summary: "first bit", url: "https://jira/PROJ-2" };
  const worktrees = mkRepos(["api", "web"], { root: "/repos/parent/.claude/worktrees/PROJ-2" });

  it("writes .pick-task/TASK.md into every worktree it is handed", () => {
    const written = writeBriefInto(worktrees, child, "## Plan\n\nsteps", () => {});
    expect(written).toEqual([
      "/repos/parent/.claude/worktrees/PROJ-2/api/.pick-task/TASK.md",
      "/repos/parent/.claude/worktrees/PROJ-2/web/.pick-task/TASK.md",
    ]);
    expect(mkdirSync).toHaveBeenCalledWith("/repos/parent/.claude/worktrees/PROJ-2/api/.pick-task", { recursive: true });
    expect(mkdirSync).toHaveBeenCalledWith("/repos/parent/.claude/worktrees/PROJ-2/web/.pick-task", { recursive: true });
  });

  it("names the child's own ticket and carries the rendered plan through", () => {
    writeBriefInto([worktrees[0]], child, "## PROJ-2: first bit\n\nthe child's own brief", () => {});
    const brief = writeArg((p) => p.endsWith(BRIEF_FILE));
    expect(String(brief![0])).toBe("/repos/parent/.claude/worktrees/PROJ-2/api/.pick-task/TASK.md");
    expect(String(brief![1])).toContain("# PROJ-2 — first bit");
    expect(String(brief![1])).toContain("the child's own brief");
    // The brief names the worktree it sits in — a subagent has to know where it is.
    expect(String(brief![1])).toContain("- `api` — /repos/parent/.claude/worktrees/PROJ-2/api  ← you are here");
  });

  it("still writes the other worktrees when one is unwritable, and says which", () => {
    // Best-effort per repo: one unwritable worktree must not cost the others theirs.
    writeFileSync.mockImplementation(((p: string) => {
      if (String(p).includes("/api/")) throw new Error("EACCES");
    }) as never);
    const logged: string[] = [];
    const written = writeBriefInto(worktrees, child, "plan", (m) => logged.push(m));
    expect(written).toEqual(["/repos/parent/.claude/worktrees/PROJ-2/web/.pick-task/TASK.md"]);
    expect(logged).toEqual([
      "brief api: could not write into /repos/parent/.claude/worktrees/PROJ-2/api (Error: EACCES)",
    ]);
  });
});
