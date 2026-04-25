/**
 * Standalone entry for the CDN `badge.js` embed: registers the custom element
 * and mounts a `<multicorn-badge>` from the hosting `<script data-agent-id=...>`.
 *
 * @module badge/badge-entrypoint
 */

import "./multicorn-badge.js";

function isSize(value: string | undefined): value is "compact" | "standard" {
  return value === "compact" || value === "standard";
}

function isTheme(value: string | undefined): value is "dark" | "light" {
  return value === "dark" || value === "light";
}

const currentScript: HTMLScriptElement | null =
  // document.currentScript is only set while the script runs
  (typeof document !== "undefined" && document.currentScript !== null
    ? (document.currentScript as HTMLScriptElement)
    : null) ?? null;

if (currentScript == null) {
  console.warn(
    "[Multicorn] badge.js must be loaded as a classic script (document.currentScript was null).",
  );
} else {
  const agentId = currentScript.dataset["agentId"]?.trim();
  if (agentId == null || agentId === "") {
    console.warn(
      "[Multicorn] Skipping trust badge: missing data-agent-id on the badge script tag.",
    );
  } else {
    const badge = document.createElement("multicorn-badge");
    badge.setAttribute("agent-id", agentId);

    const size = currentScript.dataset["size"];
    if (isSize(size)) {
      badge.setAttribute("size", size);
    }

    const theme = currentScript.dataset["theme"];
    if (isTheme(theme)) {
      badge.setAttribute("theme", theme);
    }

    const actionCountRaw = currentScript.dataset["actionCount"];
    if (actionCountRaw != null && actionCountRaw !== "") {
      badge.setAttribute("action-count", actionCountRaw);
    }

    currentScript.parentNode?.insertBefore(badge, currentScript.nextSibling);
  }
}
