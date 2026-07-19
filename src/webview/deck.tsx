import * as React from "react";
import { createRoot } from "react-dom/client";
import { DeckApp } from "./DeckApp";
import { DECK_CSS } from "./deckStyles";
import { send } from "./vscodeApi";

const style = document.createElement("style");
style.textContent = DECK_CSS;
document.head.appendChild(style);

// Same defense-in-depth as the Tasks webview: any external link click goes to the
// host to open in the real browser, never navigating the panel iframe away.
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
root.render(<DeckApp />);
