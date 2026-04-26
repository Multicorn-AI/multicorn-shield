/**
 * Consent flow for the OpenClaw hook.
 *
 * On first use (no scopes granted), opens the Shield consent page in the
 * user's browser and polls the API until permissions are granted or a
 * timeout is reached.
 *
 * Falls back to printing the consent URL to stderr if the browser can't
 * be opened (e.g. headless server).
 *
 * @module openclaw/consent
 */

import { spawn } from "node:child_process";
import { fetchGrantedScopes } from "./shield-client.js";
import type { Scope } from "../types/index.js";
import type { PluginLogger } from "./plugin-sdk.types.js";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Derive the dashboard URL from the API base URL.
 *
 * - `http://localhost:8080` becomes `http://localhost:5173`
 * - `https://api.multicorn.ai` becomes `https://app.multicorn.ai`
 */
export function deriveDashboardUrl(baseUrl: string): string {
  try {
    // Normalize: URLs like "localhost:8080" without protocol throw in URL constructor
    if (
      !/^https?:\/\//i.test(baseUrl) &&
      (baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1"))
    ) {
      baseUrl = `http://${baseUrl}`;
    }

    const url = new URL(baseUrl);

    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.port = "5173";
      url.protocol = "http:";
      return url.toString();
    }

    if (url.hostname === "api.multicorn.ai") {
      url.hostname = "app.multicorn.ai";
      return url.toString();
    }

    if (url.hostname.includes("api")) {
      url.hostname = url.hostname.replace("api", "app");
      return url.toString();
    }

    return "https://app.multicorn.ai";
  } catch {
    return "https://app.multicorn.ai";
  }
}

/**
 * Build the consent URL that the user visits to grant permissions.
 *
 * @param agentName - The agent name
 * @param dashboardUrl - The dashboard base URL
 * @param scope - Optional scope to include in the URL (e.g., { service: "terminal", permissionLevel: "execute" })
 */
export function buildConsentUrl(
  agentName: string,
  dashboardUrl: string,
  scope?: { service: string; permissionLevel: string },
): string {
  const base = dashboardUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ agent: agentName });
  if (scope) {
    params.set("scopes", `${scope.service}:${scope.permissionLevel}`);
  }
  return `${base}/consent?${params.toString()}`;
}

/**
 * Open a URL in the user's default browser.
 *
 * Uses platform-specific commands. If the browser can't be opened,
 * the error is caught and the URL is printed to stderr instead.
 * In test environments, spawn is typically mocked to prevent actual browser opening.
 */
export function openBrowser(url: string): void {
  if (process.env["NODE_ENV"] === "test" || process.env["VITEST"] === "true") {
    return;
  }
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";

  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    process.stderr.write(
      `[multicorn-shield] Could not open browser. Visit this URL to grant permissions:\n${url}\n`,
    );
  }
}

/**
 * Run the consent flow: open the consent page and poll until scopes are granted.
 *
 * @param agentId - The registered agent ID.
 * @param agentName - The human-readable agent name.
 * @param apiKey - The Multicorn API key.
 * @param baseUrl - The Shield API base URL.
 * @param scope - Optional scope to include in the consent URL (e.g., { service: "terminal", permissionLevel: "execute" })
 * @param logger - Optional logger for error messages.
 * @returns The granted scopes once the user completes consent.
 * @throws {Error} If consent is not granted within the timeout period.
 */
export async function waitForConsent(
  agentId: string,
  agentName: string,
  apiKey: string,
  baseUrl: string,
  scope?: { service: string; permissionLevel: string },
  logger?: PluginLogger,
): Promise<readonly Scope[]> {
  const dashboardUrl = deriveDashboardUrl(baseUrl);
  const consentUrl = buildConsentUrl(agentName, dashboardUrl, scope);

  process.stderr.write(
    `[multicorn-shield] Opening consent page...\n${consentUrl}\n` +
      "Waiting for you to grant access in the Multicorn dashboard...\n",
  );

  openBrowser(consentUrl);

  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const scopes = await fetchGrantedScopes(agentId, apiKey, baseUrl, logger);
    if (scopes.length > 0) {
      process.stderr.write("[multicorn-shield] Permissions granted.\n");
      return scopes;
    }
  }

  throw new Error(
    `Consent not granted within ${String(POLL_TIMEOUT_MS / 60_000)} minutes. ` +
      `Grant access at ${dashboardUrl} and restart the gateway.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
