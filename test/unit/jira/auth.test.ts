import { describe, it, expect, vi } from "vitest";
import { ApiTokenAuth } from "../../../src/jira/auth";
import { window } from "../../_mocks/vscode";
import { fakeSecrets } from "../../_helpers/factories";

const EMAIL_KEY = "agentFlow.jira.email";
const TOKEN_KEY = "agentFlow.jira.token";

// ApiTokenAuth takes a vscode.SecretStorage; our in-memory fake is structurally
// compatible, so cast at the constructor boundary.
const auth = (secrets = fakeSecrets()) => ({
  auth: new ApiTokenAuth(secrets as never),
  secrets,
});

describe("getAuthHeader / isAuthenticated", () => {
  it("builds Basic auth from base64(email:token)", async () => {
    const { auth: a } = auth(fakeSecrets({ [EMAIL_KEY]: "me@example.com", [TOKEN_KEY]: "tok123" }));
    const expected = "Basic " + Buffer.from("me@example.com:tok123").toString("base64");
    expect(await a.getAuthHeader()).toBe(expected);
  });

  it("returns undefined when the email is missing", async () => {
    const { auth: a } = auth(fakeSecrets({ [TOKEN_KEY]: "tok123" }));
    expect(await a.getAuthHeader()).toBeUndefined();
  });

  it("returns undefined when the token is missing", async () => {
    const { auth: a } = auth(fakeSecrets({ [EMAIL_KEY]: "me@example.com" }));
    expect(await a.getAuthHeader()).toBeUndefined();
  });

  it("isAuthenticated reflects whether a header can be built", async () => {
    const signed = auth(fakeSecrets({ [EMAIL_KEY]: "me@example.com", [TOKEN_KEY]: "t" }));
    const empty = auth();
    expect(await signed.auth.isAuthenticated()).toBe(true);
    expect(await empty.auth.isAuthenticated()).toBe(false);
  });
});

describe("signIn", () => {
  it("stores trimmed credentials and returns true on success", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("  me@example.com  ")
      .mockResolvedValueOnce("  tok123  ");
    const { auth: a, secrets } = auth();
    expect(await a.signIn()).toBe(true);
    expect(secrets.__store.get(EMAIL_KEY)).toBe("me@example.com");
    expect(secrets.__store.get(TOKEN_KEY)).toBe("tok123");
  });

  it("returns false and stores nothing when the email prompt is cancelled", async () => {
    vi.mocked(window.showInputBox).mockResolvedValueOnce(undefined);
    const { auth: a, secrets } = auth();
    expect(await a.signIn()).toBe(false);
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it("returns false when the token prompt is cancelled", async () => {
    vi.mocked(window.showInputBox)
      .mockResolvedValueOnce("me@example.com")
      .mockResolvedValueOnce(undefined);
    const { auth: a, secrets } = auth();
    expect(await a.signIn()).toBe(false);
    expect(secrets.store).not.toHaveBeenCalled();
  });

  it("validates the email input (requires an @)", async () => {
    vi.mocked(window.showInputBox).mockResolvedValueOnce("me@example.com").mockResolvedValueOnce("tok");
    const { auth: a } = auth();
    await a.signIn();
    const opts = vi.mocked(window.showInputBox).mock.calls[0][0] as {
      validateInput: (v: string) => string | undefined;
    };
    expect(opts.validateInput("not-an-email")).toBe("Enter a valid email");
    expect(opts.validateInput("has@at")).toBeUndefined();
  });
});

describe("signOut", () => {
  it("deletes both stored secrets", async () => {
    const { auth: a, secrets } = auth(fakeSecrets({ [EMAIL_KEY]: "e", [TOKEN_KEY]: "t" }));
    await a.signOut();
    expect(secrets.__store.has(EMAIL_KEY)).toBe(false);
    expect(secrets.__store.has(TOKEN_KEY)).toBe(false);
  });
});
