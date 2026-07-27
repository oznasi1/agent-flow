import { describe, it, expect } from "vitest";
import { JiraApiError, parseJiraError, describeJiraError } from "../../../src/jira/errors";

const envelope = (messages: string[], errors: Record<string, string> = {}) =>
  JSON.stringify({ errorMessages: messages, errors });

describe("parseJiraError", () => {
  it("reads a validator message out of errorMessages", () => {
    const e = parseJiraError(400, envelope(["Ticket cannot be closed unless Resolution will be provided"]));
    expect(e).toBeInstanceOf(JiraApiError);
    expect(e.status).toBe(400);
    expect(e.messages).toEqual(["Ticket cannot be closed unless Resolution will be provided"]);
    expect(e.fieldErrors).toEqual({});
    expect(e.message).toBe("Ticket cannot be closed unless Resolution will be provided.");
  });

  it("keeps existing punctuation instead of doubling it", () => {
    expect(parseJiraError(400, envelope(["Field is required."])).message).toBe("Field is required.");
    expect(parseJiraError(400, envelope(["Really?"])).message).toBe("Really?");
  });

  it("renders field errors keyed by field id when no name map is given", () => {
    const e = parseJiraError(400, envelope([], { resolution: "Field 'resolution' is required" }));
    expect(e.fieldErrors).toEqual({ resolution: "Field 'resolution' is required" });
    expect(e.message).toBe("resolution: Field 'resolution' is required.");
  });

  it("joins messages and field errors into one string", () => {
    const e = parseJiraError(400, envelope(["Transition failed"], { customfield_10042: "Required" }));
    expect(e.message).toBe("Transition failed. customfield_10042: Required.");
  });

  it("ignores blank and non-string entries", () => {
    const body = JSON.stringify({ errorMessages: ["", "  ", 7, "Real problem"], errors: { a: "", b: 3, c: "Nope" } });
    const e = parseJiraError(400, body);
    expect(e.messages).toEqual(["Real problem"]);
    expect(e.fieldErrors).toEqual({ c: "Nope" });
  });

  it("falls back to a status sentence for an empty envelope", () => {
    expect(parseJiraError(400, envelope([])).message).toBe("Jira rejected the request (400).");
  });

  it("falls back to a status sentence for non-JSON, HTML and empty bodies", () => {
    expect(parseJiraError(500, "server boom").message).toBe("Jira is having trouble (500) — try again shortly.");
    expect(parseJiraError(502, "<html><body>Bad Gateway</body></html>").message)
      .toBe("Jira is having trouble (502) — try again shortly.");
    expect(parseJiraError(404, "").message).toBe("Jira couldn't find that issue (404).");
    expect(parseJiraError(429, "").message).toBe("Jira is rate-limiting requests (429) — try again shortly.");
    expect(parseJiraError(302, "").message).toBe("Jira returned an error (302).");
  });

  it("never leaks the raw body into the message", () => {
    const e = parseJiraError(400, "<html>stack trace with secrets</html>");
    expect(e.message).not.toContain("secrets");
  });
});

describe("describeJiraError", () => {
  it("maps field ids to display names", () => {
    const e = parseJiraError(400, envelope([], { customfield_10042: "Field is required" }));
    expect(describeJiraError(e, { customfield_10042: "Root Cause" })).toBe("Root Cause: Field is required.");
  });

  it("keeps the id when the name map has no entry", () => {
    const e = parseJiraError(400, envelope([], { customfield_10042: "Field is required" }));
    expect(describeJiraError(e, { other: "Other" })).toBe("customfield_10042: Field is required.");
  });

  it("falls back to the status sentence when there is nothing to describe", () => {
    expect(describeJiraError(parseJiraError(503, ""))).toBe("Jira is having trouble (503) — try again shortly.");
  });
});
