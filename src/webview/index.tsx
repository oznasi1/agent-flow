import * as React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CSS } from "./styles";
import { send } from "./vscodeApi";

const style = document.createElement("style");
style.textContent = CSS;
document.head.appendChild(style);

// Defense-in-depth: intercept EVERY external link click so an anchor can never
// navigate the webview iframe away (which would blank the panel). The host opens
// it in the real browser instead. Capture phase → runs before any React handler.
document.addEventListener(
  "click",
  (e) => {
    const anchor = (e.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
    if (anchor && /^https?:/i.test(anchor.getAttribute("href") || "")) {
      e.preventDefault();
      send({ type: "openExternal", url: anchor.href });
    }
  },
  true,
);

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
