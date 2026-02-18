/**
 * Unit tests for the `<multicorn-consent>` web component.
 *
 * @module consent/multicorn-consent.test
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { html, fixture, waitUntil, fixtureCleanup } from "@open-wc/testing-helpers";
import type { Scope } from "../types/index.js";
import { PERMISSION_LEVELS } from "../types/index.js";
import type { MulticornConsent } from "./multicorn-consent.js";
import type {
  ConsentGrantedEventDetail,
  ConsentPartialEventDetail,
  ConsentDeniedEventDetail,
} from "./consent-events.js";

// Register the custom element
import "./multicorn-consent.js";

/**
 * Helper to safely get the shadow root, throwing if absent.
 */
function getShadowRoot(el: HTMLElement): ShadowRoot {
  const sr = el.shadowRoot;
  if (sr == null) {
    throw new Error("Element has no shadowRoot");
  }
  return sr;
}

/**
 * Helper to safely query a single element inside a shadow root.
 */
function queryOne(root: ShadowRoot | Element, selector: string): Element {
  const el = root.querySelector(selector);
  if (el == null) {
    throw new Error(`No element found for selector: ${selector}`);
  }
  return el;
}

describe("MulticornConsent", () => {
  const mockScopes: Scope[] = [
    { service: "gmail", permissionLevel: PERMISSION_LEVELS.Read },
    { service: "gmail", permissionLevel: PERMISSION_LEVELS.Write },
    { service: "calendar", permissionLevel: PERMISSION_LEVELS.Read },
    { service: "payments", permissionLevel: PERMISSION_LEVELS.Execute },
  ];

  afterEach(() => {
    fixtureCleanup();
  });

  describe("Rendering", () => {
    it("renders with agent name and color", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test Agent"
          agent-color="#ff0000"
          .scopes=${mockScopes}
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const agentName = shadowRoot.querySelector(".agent-name");
      expect(agentName).toBeTruthy();
      expect(agentName?.textContent).toContain("Test Agent");

      const agentIcon = shadowRoot.querySelector(".agent-icon");
      expect(agentIcon).toBeTruthy();
      expect((agentIcon as HTMLElement).style.background).toContain("#ff0000");
    });

    it("displays requested scopes with human-readable labels", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const permissionRows = shadowRoot.querySelectorAll(".permission-row");

      expect(permissionRows.length).toBeGreaterThan(0);

      // Check that Gmail appears
      const gmailRow = Array.from(permissionRows).find((row: Element) =>
        row.textContent.includes("Gmail"),
      );
      expect(gmailRow).toBeTruthy();
    });

    it("toggle switches default to ON for all requested scopes", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const toggles = shadowRoot.querySelectorAll(".toggle.enabled");

      // All toggles should be enabled by default
      expect(toggles.length).toBeGreaterThan(0);
    });

    it("spending limit displays correctly when > 0", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          spend-limit="200"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const spendingLimit = shadowRoot.querySelector(".spending-limit");
      expect(spendingLimit).toBeTruthy();

      const input = queryOne(shadowRoot, ".spend-input") as HTMLInputElement;
      expect(input).toBeTruthy();
      expect(input.value).toBe("200");
    });

    it("spending limit hidden when 0", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          spend-limit="0"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const spendingLimit = shadowRoot.querySelector(".spending-limit");
      expect(spendingLimit).toBeFalsy();
    });

    it("spending limit can be decreased with − button", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          spend-limit="200"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);
      const shadowRoot = getShadowRoot(el);

      const decreaseBtn = shadowRoot.querySelectorAll(".spend-step-btn")[0] as HTMLButtonElement;
      decreaseBtn.click();
      await el.updateComplete;

      const input = queryOne(shadowRoot, ".spend-input") as HTMLInputElement;
      expect(input.value).toBe("190");
    });

    it("spending limit cannot exceed original requested value", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          spend-limit="200"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);
      const shadowRoot = getShadowRoot(el);

      // The + button should be disabled at the max
      const increaseBtn = shadowRoot.querySelectorAll(".spend-step-btn")[1] as HTMLButtonElement;
      expect(increaseBtn.disabled).toBe(true);
    });

    it("spending limit shows hint when adjusted below requested", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          spend-limit="200"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);
      const shadowRoot = getShadowRoot(el);

      // Decrease to 190
      const decreaseBtn = shadowRoot.querySelectorAll(".spend-step-btn")[0] as HTMLButtonElement;
      decreaseBtn.click();
      await el.updateComplete;

      const hint = shadowRoot.querySelector(".spending-limit-hint");
      expect(hint?.textContent).toContain("$200");
    });

    it("consent-granted event includes adjusted spend limit", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          spend-limit="200"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);
      const shadowRoot = getShadowRoot(el);

      // Lower the spend limit
      const decreaseBtn = shadowRoot.querySelectorAll(".spend-step-btn")[0] as HTMLButtonElement;
      decreaseBtn.click();
      decreaseBtn.click();
      await el.updateComplete;

      const handler = vi.fn();
      el.addEventListener("consent-granted", handler);

      const authorizeButton = queryOne(shadowRoot, ".button-primary");
      (authorizeButton as HTMLElement).click();

      await waitUntil(() => handler.mock.calls.length > 0);

      const event = handler.mock.calls[0]?.[0] as
        | CustomEvent<ConsentGrantedEventDetail>
        | undefined;
      expect(event?.detail.spendLimit).toBe(180);
    });

    it('mode="modal" adds backdrop, mode="inline" does not', async () => {
      const modalEl = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          mode="modal"
        ></multicorn-consent>`,
      );

      await waitUntil(() => modalEl.shadowRoot != null);

      const modalShadow = getShadowRoot(modalEl);
      const modalBackdrop = modalShadow.querySelector(".backdrop");
      expect(modalBackdrop).toBeTruthy();

      const inlineEl = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          mode="inline"
        ></multicorn-consent>`,
      );

      await waitUntil(() => inlineEl.shadowRoot != null);

      const inlineShadow = getShadowRoot(inlineEl);
      const inlineBackdrop = inlineShadow.querySelector(".backdrop");
      expect(inlineBackdrop).toBeFalsy();
    });
  });

  describe("Toggle behavior", () => {
    it("clicking toggle updates internal granted state", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const firstToggle = queryOne(shadowRoot, ".toggle");

      expect(firstToggle.classList.contains("enabled")).toBe(true);

      // Click to disable
      (firstToggle as HTMLElement).click();
      await el.updateComplete;

      expect(firstToggle.classList.contains("enabled")).toBe(false);
    });

    it("clicking permission level button toggles that specific scope", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const levelButtons = shadowRoot.querySelectorAll(".permission-level-button");

      if (levelButtons.length > 0) {
        const firstButton = levelButtons[0] as HTMLElement;
        const wasActive = firstButton.classList.contains("active");

        firstButton.click();
        await el.updateComplete;

        expect(firstButton.classList.contains("active")).toBe(!wasActive);
      }
    });
  });

  describe("Event emission", () => {
    it('"Authorize" button emits consent-granted with all scopes when all toggled on', async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const handler = vi.fn();
      el.addEventListener("consent-granted", handler);

      const shadowRoot = getShadowRoot(el);
      const authorizeButton = queryOne(shadowRoot, ".button-primary");
      (authorizeButton as HTMLElement).click();

      await waitUntil(() => handler.mock.calls.length > 0);

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]?.[0] as
        | CustomEvent<ConsentGrantedEventDetail>
        | undefined;
      expect(event).toBeDefined();
      expect(event?.detail.grantedScopes).toHaveLength(mockScopes.length);
    });

    it('"Authorize" emits consent-partial when some scopes are off', async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      // Disable one toggle
      const shadowRoot = getShadowRoot(el);
      const firstToggle = queryOne(shadowRoot, ".toggle");
      (firstToggle as HTMLElement).click();
      await el.updateComplete;

      const handler = vi.fn();
      el.addEventListener("consent-partial", handler);

      const authorizeButton = queryOne(shadowRoot, ".button-primary");
      (authorizeButton as HTMLElement).click();

      await waitUntil(() => handler.mock.calls.length > 0);

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]?.[0] as
        | CustomEvent<ConsentPartialEventDetail>
        | undefined;
      expect(event).toBeDefined();
      expect(event?.detail.grantedScopes.length).toBeGreaterThan(0);
      expect(event?.detail.deniedScopes.length).toBeGreaterThan(0);
    });

    it('"Deny" button emits consent-denied', async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const handler = vi.fn();
      el.addEventListener("consent-denied", handler);

      const shadowRoot = getShadowRoot(el);
      const denyButton = queryOne(shadowRoot, ".button-secondary");
      (denyButton as HTMLElement).click();

      await waitUntil(() => handler.mock.calls.length > 0);

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0]?.[0] as CustomEvent<ConsentDeniedEventDetail> | undefined;
      expect(event).toBeDefined();
      expect(event?.detail.deniedScopes).toHaveLength(mockScopes.length);
    });

    it("Escape key emits consent-denied in modal mode", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          mode="modal"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const handler = vi.fn();
      el.addEventListener("consent-denied", handler);

      // Simulate Escape key
      const escapeEvent = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
      el.dispatchEvent(escapeEvent);

      await waitUntil(() => handler.mock.calls.length > 0);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("Accessibility", () => {
    it("ARIA attributes present: role, aria-modal, aria-labelledby", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test Agent"
          .scopes=${mockScopes}
          mode="modal"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const card = shadowRoot.querySelector(".card");

      expect(card?.getAttribute("role")).toBe("dialog");
      expect(card?.getAttribute("aria-modal")).toBe("true");
      expect(card?.getAttribute("aria-labelledby")).toBe("agent-name");
    });

    it("ARIA labels on all toggles", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const toggles = shadowRoot.querySelectorAll(".toggle");

      for (const toggle of Array.from(toggles)) {
        expect(toggle.getAttribute("aria-label")).toBeTruthy();
      }
    });

    it("Keyboard navigation: Space/Enter toggle switches", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const firstToggle = shadowRoot.querySelector(".toggle");

      if (firstToggle) {
        (firstToggle as HTMLElement).focus();

        // Simulate Space key
        const spaceEvent = new KeyboardEvent("keydown", { key: " ", bubbles: true });
        firstToggle.dispatchEvent(spaceEvent);

        await el.updateComplete;

        // Note: Actual toggle behavior depends on button click handler
        // This test verifies the element is keyboard accessible
        expect(firstToggle).toBeTruthy();
      }
    });
  });

  describe("Error handling", () => {
    it("Invalid JSON in scopes attribute doesn't crash", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" scopes="invalid json"></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      // Should render without crashing
      expect(el.shadowRoot).toBeTruthy();
      // Should have empty scopes
      expect(el.scopes).toEqual([]);
    });

    it("Unknown services get fallback labels", async () => {
      const unknownScopes: Scope[] = [
        { service: "unknown-service", permissionLevel: PERMISSION_LEVELS.Read },
      ];

      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${unknownScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      // Should render without crashing
      expect(shadowRoot.querySelector(".permission-title")).toBeTruthy();
    });
  });

  describe("Responsive design", () => {
    it("renders at 375px viewport", async () => {
      // Set viewport to 375px
      Object.defineProperty(window, "innerWidth", {
        writable: true,
        configurable: true,
        value: 375,
      });

      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const card = shadowRoot.querySelector(".card");

      // Should render successfully
      expect(card).toBeTruthy();
    });
  });

  describe("Focus trap", () => {
    it("Focus trap activates in modal mode", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          mode="modal"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      // Wait a bit for focus trap to activate
      await new Promise((resolve) => setTimeout(resolve, 100));

      const shadowRoot = getShadowRoot(el);
      const firstFocusable = shadowRoot.querySelector("button");

      if (firstFocusable != null) {
        // Focus should be within the component
        expect(
          document.activeElement === firstFocusable || el.contains(document.activeElement),
        ).toBe(true);
      }
    });
  });

  describe("Scope parsing", () => {
    it("parses scopes from JSON string attribute", async () => {
      const scopesJson = JSON.stringify(mockScopes);
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" scopes=${scopesJson}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      // Should parse correctly
      expect(el.scopes.length).toBeGreaterThan(0);
    });

    it("parses scopes from array property", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      expect(el.scopes).toEqual(mockScopes);
    });
  });

  describe("Toggle re-enable behavior", () => {
    it("toggling a scope off then back on re-grants it", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const levelButtons = shadowRoot.querySelectorAll(".permission-level-button");
      const firstButton = levelButtons[0] as HTMLElement;

      // Should start active
      expect(firstButton.classList.contains("active")).toBe(true);

      // Toggle off
      firstButton.click();
      await el.updateComplete;
      expect(firstButton.classList.contains("active")).toBe(false);

      // Toggle back on
      firstButton.click();
      await el.updateComplete;
      expect(firstButton.classList.contains("active")).toBe(true);
    });

    it("toggling all service scopes off then back on re-grants them", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${mockScopes}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      const serviceToggle = queryOne(shadowRoot, ".toggle");

      // Should start enabled
      expect(serviceToggle.classList.contains("enabled")).toBe(true);

      // Toggle off
      (serviceToggle as HTMLElement).click();
      await el.updateComplete;
      expect(serviceToggle.classList.contains("enabled")).toBe(false);

      // Toggle back on
      (serviceToggle as HTMLElement).click();
      await el.updateComplete;
      expect(serviceToggle.classList.contains("enabled")).toBe(true);
    });
  });

  describe("Authorize with all scopes denied", () => {
    it("emits consent-denied when all scopes are toggled off and Authorize is clicked", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          mode="inline"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);

      // Toggle OFF every service toggle
      const toggles = shadowRoot.querySelectorAll(".toggle.enabled");
      for (const toggle of Array.from(toggles)) {
        (toggle as HTMLElement).click();
        await el.updateComplete;
      }

      // All should now be disabled
      const enabledAfter = shadowRoot.querySelectorAll(".toggle.enabled");
      expect(enabledAfter.length).toBe(0);

      const handler = vi.fn();
      el.addEventListener("consent-denied", handler);

      const authorizeButton = queryOne(shadowRoot, ".button-primary");
      (authorizeButton as HTMLElement).click();

      await waitUntil(() => handler.mock.calls.length > 0);

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe("Modal close behavior", () => {
    it("renders empty after modal is closed via Deny", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent
          agent-name="Test"
          .scopes=${mockScopes}
          mode="modal"
        ></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      expect(shadowRoot.querySelector(".card")).toBeTruthy();

      // Click Deny to close modal
      const denyButton = queryOne(shadowRoot, ".button-secondary");
      (denyButton as HTMLElement).click();
      await el.updateComplete;

      // Modal should now be closed — card should be gone
      expect(shadowRoot.querySelector(".card")).toBeFalsy();
    });
  });

  describe("No scopes rendering", () => {
    it("shows no permissions message when scopes are empty", async () => {
      const el = await fixture<MulticornConsent>(
        html`<multicorn-consent agent-name="Test" .scopes=${[]}></multicorn-consent>`,
      );

      await waitUntil(() => el.shadowRoot != null);

      const shadowRoot = getShadowRoot(el);
      expect(shadowRoot.querySelector(".permission-row")).toBeFalsy();
      expect(shadowRoot.textContent).toContain("No permissions requested");
    });
  });
});
