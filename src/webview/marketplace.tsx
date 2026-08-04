import * as React from "react";
import { createRoot } from "react-dom/client";
import { MarketplaceApp } from "./MarketplaceApp";
import { MARKETPLACE_CSS } from "./marketplaceStyles";
import { BASE_CSS, CONTROLS_CSS, TOKENS_CSS } from "./tokens";
import { send } from "./vscodeApi";

// Tokens first, then the reset, then the shared controls, then the surface
// sheet: later sheets must win specificity ties against the earlier ones.
for (const css of [TOKENS_CSS, BASE_CSS, CONTROLS_CSS, MARKETPLACE_CSS]) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

// Same defense-in-depth as the other webviews: any external link click goes to the
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
root.render(<MarketplaceApp />);
