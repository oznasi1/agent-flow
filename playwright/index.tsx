import { beforeMount } from "@playwright/experimental-ct-react/hooks";
import { CSS } from "../src/webview/styles";
import { DECK_CSS } from "../src/webview/deckStyles";
import { ORCH_CSS } from "../src/webview/orchestratorStyles";
import { TOKENS_CSS } from "../src/webview/tokens";

// All four sheets, because these tests exist to exercise *measured* layout:
// a component styled by only part of its CSS is measured at the wrong size,
// which is the same blindness jsdom has. TOKENS_CSS carries every `--c-*`
// custom property (deckStyles.ts and orchestratorStyles.ts only ever READ
// them) — without it every `var(--c-attn)`/`var(--c-progress)`/etc. reference
// is a guaranteed-invalid value, so every hue in the app would compute to
// plain inherited text colour and a hue-swap mutation would be invisible even
// to a real-Chromium test.
beforeMount(async () => {
  const style = document.createElement("style");
  style.textContent = [TOKENS_CSS, CSS, DECK_CSS, ORCH_CSS].join("\n");
  document.head.appendChild(style);
});
