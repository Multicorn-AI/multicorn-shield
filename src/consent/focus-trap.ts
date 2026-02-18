/**
 * Focus trap utility for modal dialogs.
 *
 * Traps keyboard focus within a container element, preventing users from
 * tabbing outside the modal. Essential for accessibility in modal dialogs.
 *
 * @module consent/focus-trap
 */

/**
 * Selector for focusable elements within the container.
 *
 * Includes buttons, links, inputs, and elements with tabindex >= 0.
 */
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Interface for focus trap control.
 */
export interface FocusTrap {
  /** Activate the focus trap. */
  activate(): void;
  /** Deactivate the focus trap and restore focus. */
  deactivate(): void;
}

/**
 * Create a focus trap for the given container element.
 *
 * When activated, Tab and Shift+Tab will cycle through focusable elements
 * within the container, preventing focus from escaping.
 *
 * @param container - The container element to trap focus within.
 * @param initialFocus - Optional element to focus when trap activates. Defaults to first focusable element.
 * @returns An object with `activate()` and `deactivate()` methods.
 *
 * @example
 * ```ts
 * const trap = createFocusTrap(modalElement);
 * trap.activate(); // Focus is now trapped
 * // ... later
 * trap.deactivate(); // Focus restored to previous element
 * ```
 */
export function createFocusTrap(
  container: HTMLElement,
  initialFocus?: HTMLElement | null,
): FocusTrap {
  let previousActiveElement: HTMLElement | null = null;
  let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  /**
   * Get all focusable elements within the container.
   *
   * Queries both the container itself and its Shadow DOM if present.
   */
  function getFocusableElements(): HTMLElement[] {
    const elements: HTMLElement[] = [];

    // Query in the container's own DOM
    const directElements = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    elements.push(...directElements);

    // Query in Shadow DOM if present
    if (container.shadowRoot) {
      const shadowElements = Array.from(
        container.shadowRoot.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      elements.push(...shadowElements);
    }

    // Filter out elements that are not actually visible or focusable
    return elements.filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    });
  }

  /**
   * Handle Tab key presses to cycle focus within the container.
   */
  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Tab") {
      return;
    }

    const focusableElements = getFocusableElements();
    if (focusableElements.length === 0) {
      e.preventDefault();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (!firstElement || !lastElement) {
      return;
    }

    const currentElement = document.activeElement as HTMLElement;

    // If Shift+Tab on first element, wrap to last
    if (e.shiftKey && currentElement === firstElement) {
      e.preventDefault();
      lastElement.focus();
      return;
    }

    // If Tab on last element, wrap to first
    if (!e.shiftKey && currentElement === lastElement) {
      e.preventDefault();
      firstElement.focus();
      return;
    }

    // If current focus is outside container, focus first element
    if (!focusableElements.includes(currentElement)) {
      e.preventDefault();
      firstElement.focus();
    }
  }

  return {
    activate(): void {
      // Store the previously focused element
      previousActiveElement = document.activeElement as HTMLElement | null;

      // Set up keyboard handler
      keydownHandler = handleKeyDown;
      container.addEventListener("keydown", keydownHandler, true);

      // Focus initial element
      const focusableElements = getFocusableElements();
      if (focusableElements.length > 0) {
        const firstElement = focusableElements[0];
        if (firstElement == null) {
          return;
        }
        const target = initialFocus ?? firstElement;
        if (focusableElements.includes(target)) {
          target.focus();
        } else {
          firstElement.focus();
        }
      }
    },

    deactivate(): void {
      // Remove keyboard handler
      if (keydownHandler) {
        container.removeEventListener("keydown", keydownHandler, true);
        keydownHandler = null;
      }

      // Restore focus to previous element if it still exists
      if (previousActiveElement && document.body.contains(previousActiveElement)) {
        previousActiveElement.focus();
      }
      previousActiveElement = null;
    },
  };
}
