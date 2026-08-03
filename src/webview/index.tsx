import * as React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CSS } from "./styles";
import { BASE_CSS, TOKENS_CSS } from "./tokens";
import { send } from "./vscodeApi";

// Tokens first, then the reset, then the surface sheet: later sheets must win
// specificity ties against the reset, not the other way round.
for (const css of [TOKENS_CSS, BASE_CSS, CSS]) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

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
