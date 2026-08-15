import { beforeMount } from "@playwright/experimental-ct-react/hooks";
import { CSS } from "../src/webview/styles";
import { DECK_CSS } from "../src/webview/deckStyles";
import { ORCH_CSS } from "../src/webview/orchestratorStyles";

// All three sheets, because these tests exist to exercise *measured* layout:
// a component styled by only part of its CSS is measured at the wrong size,
// which is the same blindness jsdom has.
beforeMount(async () => {
  const style = document.createElement("style");
  style.textContent = [CSS, DECK_CSS, ORCH_CSS].join("\n");
  document.head.appendChild(style);
});
