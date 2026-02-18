/**
 * Unit tests for the focus trap utility.
 *
 * @module consent/focus-trap.test
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { createFocusTrap, type FocusTrap } from "./focus-trap.js";

/**
 * Helper: create a container div with N visible buttons inside it.
 */
function createContainerWithButtons(count: number): HTMLDivElement {
  const container = document.createElement("div");
  for (let i = 0; i < count; i++) {
    const btn = document.createElement("button");
    btn.textContent = `Button ${String(i)}`;
    btn.setAttribute("data-index", String(i));
    container.appendChild(btn);
  }
  document.body.appendChild(container);
  return container;
}

describe("createFocusTrap", () => {
  let container: HTMLDivElement;
  let trap: FocusTrap;

  afterEach(() => {
    trap.deactivate();
    container.remove();
  });

  describe("activate", () => {
    it("focuses the first focusable element on activation", () => {
      container = createContainerWithButtons(3);
      trap = createFocusTrap(container);
      trap.activate();

      const buttons = container.querySelectorAll("button");
      expect(document.activeElement).toBe(buttons[0]);
    });

    it("focuses the provided initialFocus element", () => {
      container = createContainerWithButtons(3);
      const buttons = container.querySelectorAll("button");
      trap = createFocusTrap(container, buttons[1] as HTMLElement);
      trap.activate();

      expect(document.activeElement).toBe(buttons[1]);
    });

    it("falls back to first element if initialFocus is not in the container", () => {
      container = createContainerWithButtons(3);
      const outsideButton = document.createElement("button");
      outsideButton.textContent = "Outside";
      document.body.appendChild(outsideButton);

      trap = createFocusTrap(container, outsideButton);
      trap.activate();

      const buttons = container.querySelectorAll("button");
      expect(document.activeElement).toBe(buttons[0]);

      outsideButton.remove();
    });

    it("does nothing when container has no focusable elements", () => {
      container = document.createElement("div");
      container.innerHTML = "<span>Not focusable</span>";
      document.body.appendChild(container);

      const previousActive = document.activeElement;
      trap = createFocusTrap(container);
      trap.activate();

      // Should not have changed focus to anything inside container
      expect(
        document.activeElement === previousActive || document.activeElement === document.body,
      ).toBe(true);
    });
  });

  describe("deactivate", () => {
    it("restores focus to the previously focused element", () => {
      const outsideButton = document.createElement("button");
      outsideButton.textContent = "Outside";
      document.body.appendChild(outsideButton);
      outsideButton.focus();
      expect(document.activeElement).toBe(outsideButton);

      container = createContainerWithButtons(2);
      trap = createFocusTrap(container);
      trap.activate();

      // Focus should now be inside the container
      const buttons = container.querySelectorAll("button");
      expect(document.activeElement).toBe(buttons[0]);

      trap.deactivate();

      // Focus should be restored to the outside button
      expect(document.activeElement).toBe(outsideButton);

      outsideButton.remove();
    });

    it("does not crash if previously focused element was removed", () => {
      const tempButton = document.createElement("button");
      document.body.appendChild(tempButton);
      tempButton.focus();

      container = createContainerWithButtons(2);
      trap = createFocusTrap(container);
      trap.activate();

      // Remove the previously focused element
      tempButton.remove();

      // Should not throw
      expect(() => {
        trap.deactivate();
      }).not.toThrow();
    });

    it("calling deactivate twice does not throw", () => {
      container = createContainerWithButtons(2);
      trap = createFocusTrap(container);
      trap.activate();
      trap.deactivate();

      expect(() => {
        trap.deactivate();
      }).not.toThrow();
    });
  });

  describe("Tab key handling", () => {
    it("wraps focus from last element to first on Tab", () => {
      container = createContainerWithButtons(3);
      trap = createFocusTrap(container);
      trap.activate();

      const buttons = container.querySelectorAll("button");
      const lastButton = buttons[buttons.length - 1] as HTMLElement;

      // Focus the last button
      lastButton.focus();
      expect(document.activeElement).toBe(lastButton);

      // Simulate Tab key
      const tabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(tabEvent);

      expect(document.activeElement).toBe(buttons[0]);
    });

    it("wraps focus from first element to last on Shift+Tab", () => {
      container = createContainerWithButtons(3);
      trap = createFocusTrap(container);
      trap.activate();

      const buttons = container.querySelectorAll("button");
      const firstButton = buttons[0] as HTMLElement;
      const lastButton = buttons[buttons.length - 1] as HTMLElement;

      // Focus the first button
      firstButton.focus();
      expect(document.activeElement).toBe(firstButton);

      // Simulate Shift+Tab
      const shiftTabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(shiftTabEvent);

      expect(document.activeElement).toBe(lastButton);
    });

    it("redirects focus to first element if current focus is outside container", () => {
      container = createContainerWithButtons(3);
      trap = createFocusTrap(container);
      trap.activate();

      const buttons = container.querySelectorAll("button");

      // Focus something outside the container
      const outsideButton = document.createElement("button");
      document.body.appendChild(outsideButton);
      outsideButton.focus();

      // Simulate Tab key on the container
      const tabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(tabEvent);

      expect(document.activeElement).toBe(buttons[0]);

      outsideButton.remove();
    });

    it("prevents default on Tab when no focusable elements exist", () => {
      container = document.createElement("div");
      container.innerHTML = "<span>No buttons</span>";
      document.body.appendChild(container);

      trap = createFocusTrap(container);
      trap.activate();

      const tabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      const preventSpy = vi.spyOn(tabEvent, "preventDefault");
      container.dispatchEvent(tabEvent);

      expect(preventSpy).toHaveBeenCalled();
    });

    it("ignores non-Tab key presses", () => {
      container = createContainerWithButtons(2);
      trap = createFocusTrap(container);
      trap.activate();

      const buttons = container.querySelectorAll("button");
      (buttons[0] as HTMLElement).focus();

      // Simulate Enter key (should be ignored)
      const enterEvent = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      container.dispatchEvent(enterEvent);

      // Focus should not change
      expect(document.activeElement).toBe(buttons[0]);
    });

    it("allows normal Tab flow between middle elements", () => {
      container = createContainerWithButtons(3);
      trap = createFocusTrap(container);
      trap.activate();

      const buttons = container.querySelectorAll("button");
      // Focus the middle button
      (buttons[1] as HTMLElement).focus();

      // Simulate Tab — should NOT wrap (middle element, not last)
      const tabEvent = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      const preventSpy = vi.spyOn(tabEvent, "preventDefault");
      container.dispatchEvent(tabEvent);

      // preventDefault should NOT have been called for middle-element tab
      expect(preventSpy).not.toHaveBeenCalled();
    });
  });

  describe("Shadow DOM support", () => {
    it("finds focusable elements in shadow DOM", () => {
      container = document.createElement("div");
      document.body.appendChild(container);

      // Attach shadow root with a button
      const shadow = container.attachShadow({ mode: "open" });
      const shadowButton = document.createElement("button");
      shadowButton.textContent = "Shadow Button";
      shadow.appendChild(shadowButton);

      trap = createFocusTrap(container);
      trap.activate();

      // Should find and focus the shadow DOM button
      expect(document.activeElement).toBe(container);
    });
  });
});
