import { describe, it, expect, vi } from "vitest";
import { BbReviewProvider } from "../../../../../src/engine/review/bb/provider";
import type { Runner } from "../../../../../src/engine/pr/provider";

const BB = "/opt/homebrew/bin/atlassian-cli";
const REPO = "acme/api-service";
const BODY = "This looks good, but see line 12.";

const ok: Runner = async () => "";
const provider = (run: Runner, apiMode: boolean) => new BbReviewProvider(run, () => BB, async () => apiMode);

describe("BbReviewProvider.search", () => {
  it("is null, because Bitbucket Cloud has no cross-repo reviewer query", async () => {
    // Never called today: `caps.reviewSearch` is false, so `reviewsEnabled()`
    // hides the strip and nothing populates the cache this provider serves.
    await expect(provider(ok, true).search()).resolves.toBeNull();
  });
});

describe("BbReviewProvider.submit — projected mode", () => {
  it("approves and comments through the CLI's own subcommands", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "";
    };
    await expect(provider(run, false).submit(REPO, 42, "approve", "")).resolves.toEqual({ ok: true });
    expect(calls[0]).toEqual(["--workspace", "acme", "bb", "pr", "approve", "api-service", "42", "--format", "json"]);

    await expect(provider(run, false).submit(REPO, 42, "comment", BODY)).resolves.toEqual({ ok: true });
    expect(calls[1]).toEqual([
      "--workspace", "acme", "bb", "pr", "comment", "api-service", "42",
      "--text", BODY, "--format", "json",
    ]);
  });

  // An approval carrying a review body used to take the `approve` branch and drop
  // the text on the floor, returning `ok: true` — so the Deck toasted success over
  // words the user wrote and Bitbucket never saw. The comment goes first here for
  // the same reason the passthrough path posts it first: a note with no state
  // change beats a state change with no explanation.
  it("posts an approval's body as a comment rather than discarding it", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "";
    };
    await expect(provider(run, false).submit(REPO, 42, "approve", BODY)).resolves.toEqual({ ok: true });
    expect(calls).toEqual([
      ["--workspace", "acme", "bb", "pr", "comment", "api-service", "42", "--text", BODY, "--format", "json"],
      ["--workspace", "acme", "bb", "pr", "approve", "api-service", "42", "--format", "json"],
    ]);
  });

  it("still approves with no extra call when there is no body", async () => {
    // The empty-body approval must not gain a pointless empty comment.
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "";
    };
    await expect(provider(run, false).submit(REPO, 42, "approve", "   ")).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("approve");
  });

  it("refuses request-changes without spawning anything", async () => {
    const run = vi.fn<Runner>(async () => "");
    const res = await provider(run, false).submit(REPO, 42, "request-changes", BODY);
    expect(res).toEqual({ ok: false, message: expect.stringContaining("request changes") });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("BbReviewProvider.submit — passthrough mode", () => {
  it("posts request-changes to the endpoint the API does have, with the comment body attached", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "";
    };
    await expect(provider(run, true).submit(REPO, 42, "request-changes", BODY)).resolves.toEqual({ ok: true });
    // The comment carrying the reviewer's reasoning goes first: if the second
    // call fails, a posted note with no state change is a better outcome than a
    // blocking state with no explanation.
    expect(calls[0][2]).toContain("/2.0/repositories/acme/api-service/pullrequests/42/comments");
    // RULING D: the request body is the whole point of this call. Asserting only
    // the path would pass against a POST that posts nothing, silently sending an
    // empty comment while the reviewer's text vanishes.
    expect(calls[0]).toContain("-d");
    expect(calls[0][calls[0].indexOf("-d") + 1]).toBe(JSON.stringify({ content: { raw: BODY } }));

    expect(calls[1][2]).toContain("/2.0/repositories/acme/api-service/pullrequests/42/request-changes");
    expect(calls[1]).toContain("-X");
    expect(calls[1]).toContain("POST");
  });

  it("posts an approval with no body at all", async () => {
    const calls: string[][] = [];
    const run: Runner = async (_f, args) => {
      calls.push(args);
      return "";
    };
    await expect(provider(run, true).submit(REPO, 42, "approve", "")).resolves.toEqual({ ok: true });
    // No text means no comment call — just the approve endpoint, no `-d` at all.
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toContain("/2.0/repositories/acme/api-service/pullrequests/42/approve");
    expect(calls[0]).not.toContain("-d");
  });
});

describe("BbReviewProvider.submit — refusals and failures", () => {
  it("fails closed on a verb outside the union, prototype keys included", async () => {
    const run = vi.fn<Runner>(async () => "");
    // `!VERB[verb]` would sail through on "constructor". The one command that
    // writes to someone else's pull request does not get to guess.
    const res = await provider(run, true).submit(REPO, 42, "constructor" as never, BODY);
    expect(res).toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("requires a message for anything but an approval", async () => {
    const run = vi.fn<Runner>(async () => "");
    await expect(provider(run, true).submit(REPO, 42, "comment", "   ")).resolves.toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });

  it("never returns the review body in an error message", async () => {
    // execFile's `.message` is `Command failed: <file> <argv joined>`, which for
    // a comment embeds the entire body verbatim. This is the last line of
    // defense against returning it to the webview.
    const leaky = Object.assign(new Error(`Command failed: ${BB} bb pr comment api-service 42 --text ${BODY}`), {});
    const run: Runner = async () => {
      throw leaky;
    };
    const res = await provider(run, false).submit(REPO, 42, "comment", BODY);
    expect(res.ok).toBe(false);
    expect((res as { message: string }).message).not.toContain(BODY);
  });

  it("prefers the CLI's own stderr over the reconstructed argv", async () => {
    const run: Runner = async () => {
      throw Object.assign(new Error(`Command failed: ${BB} bb pr comment ... ${BODY}`), {
        stderr: "403 Forbidden: you are not a reviewer on this pull request",
      });
    };
    const res = await provider(run, false).submit(REPO, 42, "comment", BODY);
    expect((res as { message: string }).message).toBe("403 Forbidden: you are not a reviewer on this pull request");
  });

  it("keeps the timeout branch's distinct wording", async () => {
    // A killed process may already have reached Bitbucket, so "Bitbucket
    // refused" would be a flat lie about a write that could have succeeded.
    const run: Runner = async () => {
      throw Object.assign(new Error("killed"), { killed: true });
    };
    const res = await provider(run, false).submit(REPO, 42, "approve", "");
    expect((res as { message: string }).message).toMatch(/may already have gone through/);
  });

  it("fails rather than guessing when the repo is not workspace/slug", async () => {
    const run = vi.fn<Runner>(async () => "");
    await expect(provider(run, false).submit("api-service", 42, "approve", "")).resolves.toMatchObject({ ok: false });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("BbReviewProvider.detail", () => {
  it("fills failing checks from the statuses call, and nothing else, in passthrough mode", async () => {
    const run: Runner = async () =>
      JSON.stringify({ values: [{ state: "FAILED", name: "Tests", url: "https://ci/3" }] });
    // `toEqual` against the complete `ReviewDetail`, not `toMatchObject`: this
    // call never requests `/diffstat` and returns no `size`/`ci` at all, only
    // `failing` and a fixed `unresolved: null` — a future task wiring up
    // diffstat must find this test red, not green while asserting nothing about
    // the fields it's supposed to add.
    await expect(provider(run, true).detail(REPO, 42)).resolves.toEqual({
      failing: [{ name: "Tests", url: "https://ci/3" }],
      unresolved: null,
    });
  });

  it("is null in projected mode, where `bb pr diff` is a stub", async () => {
    await expect(provider(ok, false).detail(REPO, 42)).resolves.toBeNull();
  });
});
