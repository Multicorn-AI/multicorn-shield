/**
 * @module badge/__tests__/multicorn-badge.test
 */

import { describe, it, expect, afterEach } from "vitest";
import { MulticornBadge } from "../multicorn-badge.js";

function getShadowRoot(el: HTMLElement): ShadowRoot {
  const sr = el.shadowRoot;
  if (sr == null) {
    throw new Error("Element has no shadowRoot");
  }
  return sr;
}

function queryRequired(parent: ParentNode, selector: string): Element {
  const found = parent.querySelector(selector);
  if (found == null) {
    throw new Error(`Missing ${selector} under parent`);
  }
  return found;
}

function mountBadge(attrs: Record<string, string>): MulticornBadge {
  const el = document.createElement("multicorn-badge");
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, value);
  }
  document.body.appendChild(el);
  if (el instanceof MulticornBadge) {
    return el;
  }
  throw new Error("expected multicorn-badge to upgrade to MulticornBadge");
}

describe("MulticornBadge", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("renders with required agent-id attribute", () => {
    const el = mountBadge({ "agent-id": "ag_test_1" });
    const root = getShadowRoot(el);
    const link = root.querySelector("a.badge");
    expect(link).toBeTruthy();
  });

  it("renders nothing when agent-id is empty (no link, no verify/- URL)", () => {
    const el = mountBadge({ "agent-id": "" });
    const root = getShadowRoot(el);
    expect(root.querySelector("a.badge")).toBeNull();
  });

  it("removes the anchor when agent-id is cleared", () => {
    const el = mountBadge({ "agent-id": "ag_1" });
    expect(getShadowRoot(el).querySelector("a.badge")).toBeTruthy();
    el.setAttribute("agent-id", "");
    expect(getShadowRoot(el).querySelector("a.badge")).toBeNull();
  });

  it("link href contains verify URL and agent id", () => {
    const el = mountBadge({ "agent-id": "ag_test_1" });
    const link = queryRequired(getShadowRoot(el), "a.badge");
    expect(link.getAttribute("href")).toBe("https://multicorn.ai/verify/ag_test_1");
  });

  it("link has rel and target for safe external navigation", () => {
    const el = mountBadge({ "agent-id": "ag_x" });
    const link = queryRequired(getShadowRoot(el), "a.badge");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("standard size shows Secured by Multicorn", () => {
    const el = mountBadge({ "agent-id": "ag_1", size: "standard" });
    const text = queryRequired(getShadowRoot(el), ".text");
    expect(text.textContent).toContain("Secured by Multicorn");
  });

  it("compact size sets size on host (text hidden via shadow CSS)", () => {
    const el = mountBadge({ "agent-id": "ag_1", size: "compact" });
    expect(el.getAttribute("size")).toBe("compact");
    const text = queryRequired(getShadowRoot(el), ".text");
    expect(text.textContent).toContain("Secured by Multicorn");
  });

  it("action-count shows actions suffix when set", () => {
    const el = mountBadge({ "agent-id": "ag_1", "action-count": "42" });
    const text = queryRequired(getShadowRoot(el), ".text");
    expect(text.textContent).toContain("42");
    expect(text.textContent).toContain("actions secured");
  });

  it("action-count suffix is absent when not set", () => {
    const el = mountBadge({ "agent-id": "ag_1" });
    const text = queryRequired(getShadowRoot(el), ".text");
    expect(text.textContent).not.toContain("actions secured");
  });

  it("aria-label includes action count when set", () => {
    const el = mountBadge({ "agent-id": "ag_1", "action-count": "7" });
    const link = queryRequired(getShadowRoot(el), "a.badge");
    expect(link.getAttribute("aria-label")).toBe(
      "Secured by Multicorn · 7 actions secured, verify this agent",
    );
  });

  it("aria-label does not include count when action-count is absent", () => {
    const el = mountBadge({ "agent-id": "ag_1" });
    const link = queryRequired(getShadowRoot(el), "a.badge");
    expect(link.getAttribute("aria-label")).toBe("Secured by Multicorn, verify this agent");
  });

  it("dark theme sets theme on host", () => {
    const el = mountBadge({ "agent-id": "ag_1", theme: "dark" });
    expect(el.getAttribute("theme")).toBe("dark");
    expect(queryRequired(getShadowRoot(el), ".badge").getAttribute("href")).toContain("/verify/");
  });

  it("light theme sets theme on host", () => {
    const el = mountBadge({ "agent-id": "ag_1", theme: "light" });
    expect(el.getAttribute("theme")).toBe("light");
    expect(queryRequired(getShadowRoot(el), ".badge").getAttribute("href")).toContain("/verify/");
  });

  it("renders a shield path inside svg in shadow root", () => {
    const el = mountBadge({ "agent-id": "ag_1" });
    const root = getShadowRoot(el);
    const svg = queryRequired(root, "svg.icon");
    const path = queryRequired(svg, "path");
    const d = path.getAttribute("d") ?? "";
    expect(d.length).toBeGreaterThan(10);
  });

  it("ignores non-numeric action-count", () => {
    const el = mountBadge({ "agent-id": "ag_1", "action-count": "abc" });
    const text = queryRequired(getShadowRoot(el), ".text");
    expect(text.textContent).toBe("Secured by Multicorn");
    expect(text.textContent).not.toContain("actions secured");
  });

  it("re-renders when agent-id changes to a new value", () => {
    const el = mountBadge({ "agent-id": "ag_1" });
    const root = getShadowRoot(el);
    expect(queryRequired(root, "a.badge").getAttribute("href")).toContain("ag_1");
    el.setAttribute("agent-id", "ag_2");
    expect(queryRequired(root, "a.badge").getAttribute("href")).toContain("ag_2");
  });

  it("style tag is injected only once across re-renders", () => {
    const el = mountBadge({ "agent-id": "ag_1" });
    const root = getShadowRoot(el);
    el.setAttribute("action-count", "10");
    el.setAttribute("action-count", "20");
    const styles = root.querySelectorAll("style");
    expect(styles.length).toBe(1);
  });
});
