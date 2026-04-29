/**
 * `<multicorn-badge>`: small embeddable trust badge (Shadow DOM).
 * Implemented as a native custom element to keep the CDN `badge.js` under the
 * size budget. Styling and tokens align with the Lit-based consent screen.
 *
 * @module badge/multicorn-badge
 */

import { SHIELD_COLORS } from "../shared/shield-tokens.js";
import { getBadgeStyleText } from "./badge-styles.js";

const VERIFY_BASE = "https://multicorn.ai/verify/";

/** Custom element tag for the trust badge. */
export const BADGE_ELEMENT_TAG = "multicorn-badge" as const;

/** 24x24 viewBox, filled shield path. */
const SHIELD_PATH = "M12 1L3 5v6c0 5.55 3.84 9.95 9 12 5.16-2.05 9-6.45 9-12V5l-9-4z";

// Allows the class declaration to survive in Node.js where HTMLElement is
// not a global. The class body is browser-only but tree-shaking keeps it
// out of pure-Node bundles (proxy subpath). The root barrel still re-exports
// it, so we need a safe base class for environments without DOM globals.
const SafeHTMLElement =
  typeof HTMLElement !== "undefined"
    ? HTMLElement
    : (class {
        connectedCallback(): void {
          /* noop stub for Node.js */
        }
      } as unknown as typeof HTMLElement);

function parseOptionalCount(raw: string | null): number | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

export class MulticornBadge extends SafeHTMLElement {
  #didInjectStyle = false;

  private ensureShadow(): ShadowRoot {
    if (this.shadowRoot != null) {
      return this.shadowRoot;
    }
    return this.attachShadow({ mode: "open" });
  }

  static get observedAttributes(): string[] {
    return ["agent-id", "size", "theme", "action-count"];
  }

  connectedCallback(): void {
    this.render();
  }

  attributeChangedCallback(): void {
    this.render();
  }

  private render(): void {
    const root = this.ensureShadow();
    if (this.#didInjectStyle) {
      /* style was already injected on a previous render */
    } else {
      const style = document.createElement("style");
      style.textContent = getBadgeStyleText();
      root.appendChild(style);
      this.#didInjectStyle = true;
    }

    const agentId = (this.getAttribute("agent-id") ?? "").trim();
    const actionCount = parseOptionalCount(this.getAttribute("action-count"));

    const prior = root.querySelector("a.badge");
    if (prior) {
      prior.remove();
    }

    if (agentId === "") {
      return;
    }

    let labelSuffix: string;
    let ariaLabel: string;
    if (actionCount == null) {
      labelSuffix = "Secured by Multicorn";
      ariaLabel = "Secured by Multicorn, verify this agent";
    } else {
      const count: number = actionCount;
      const countText = String(count);
      labelSuffix = "Secured by Multicorn · " + countText + " actions secured";
      ariaLabel = "Secured by Multicorn · " + countText + " actions secured, verify this agent";
    }

    const href = `${VERIFY_BASE}${encodeURIComponent(agentId)}`;

    const a = document.createElement("a");
    a.className = "badge";
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.setAttribute("aria-label", ariaLabel);

    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "icon");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svgNs, "path");
    path.setAttribute("d", SHIELD_PATH);
    path.setAttribute("fill", SHIELD_COLORS.accent);
    svg.appendChild(path);
    a.appendChild(svg);

    const text = document.createElement("span");
    text.className = "text";
    text.textContent = labelSuffix;
    a.appendChild(text);

    root.appendChild(a);
  }
}

if (typeof customElements !== "undefined" && customElements.get(BADGE_ELEMENT_TAG) === undefined) {
  customElements.define(BADGE_ELEMENT_TAG, MulticornBadge);
}

declare global {
  interface HTMLElementTagNameMap {
    [BADGE_ELEMENT_TAG]: MulticornBadge;
  }
}
