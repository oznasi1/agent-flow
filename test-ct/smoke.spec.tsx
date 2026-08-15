import { test, expect } from "@playwright/experimental-ct-react";
import * as React from "react";
import { App } from "../src/webview/App";
import { posted } from "./_helpers/host";

test("the harness mounts App and records its outbound messages", async ({ mount, page }) => {
  await mount(<App />);
  await expect.poll(() => posted(page)).toContainEqual({ type: "ready" });
});
