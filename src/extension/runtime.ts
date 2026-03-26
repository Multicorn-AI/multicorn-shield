/**
 * Lightweight desktop extension runtime: agent resolution and consent UX.
 * Permission checks and action logging run on the hosted proxy.
 *
 * @module extension/runtime
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function debugLog(msg: string): void {
  try {
    const dir = join(homedir(), ".multicorn");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "extension-debug.log"), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}
import { buildConsentUrl, openBrowser, resolveAgentRecord } from "../proxy/consent.js";
import type { ProxyLogger } from "../proxy/logger.js";

export interface ShieldExtensionRuntimeConfig {
  readonly apiKey: string;
  readonly agentName: string;
  readonly baseUrl: string;
  readonly dashboardUrl: string;
  readonly logger: ProxyLogger;
}

export class ShieldExtensionRuntime {
  private readonly config: ShieldExtensionRuntimeConfig;
  private agentId = "";
  private authInvalid = false;
  private consentBrowserOpened = false;

  constructor(config: ShieldExtensionRuntimeConfig) {
    this.config = config;
  }

  /** Agent id from Shield after {@link start}; may be empty while offline. */
  getAgentId(): string {
    return this.agentId;
  }

  isAuthInvalid(): boolean {
    return this.authInvalid;
  }

  async start(): Promise<void> {
    const cfg = this.config;
    if (
      !cfg.baseUrl.startsWith("https://") &&
      !cfg.baseUrl.startsWith("http://localhost") &&
      !cfg.baseUrl.startsWith("http://127.0.0.1")
    ) {
      throw new Error(
        `[multicorn-shield-extension] Base URL must use HTTPS. Received: "${cfg.baseUrl}".`,
      );
    }

    debugLog(`[SHIELD] Resolving agent record for name=${cfg.agentName} baseUrl=${cfg.baseUrl}`);
    const agentRecord = await resolveAgentRecord(
      cfg.agentName,
      cfg.apiKey,
      cfg.baseUrl,
      cfg.logger,
    );
    debugLog(
      `[SHIELD] Agent record resolved: id=${agentRecord.id.length > 0 ? agentRecord.id : "(empty)"} authInvalid=${String(agentRecord.authInvalid === true)}`,
    );

    this.agentId = agentRecord.id;
    this.authInvalid = agentRecord.authInvalid === true;
  }

  async stop(): Promise<void> {
    /* No timers or loggers in hosted-proxy mode. */
  }

  /**
   * Opens the consent URL once (first permission-style block). Skipped if API key is invalid.
   */
  openConsentBrowserOnce(): void {
    if (this.consentBrowserOpened || this.authInvalid) {
      return;
    }
    const name = this.config.agentName.trim();
    if (name.length === 0) {
      return;
    }

    this.consentBrowserOpened = true;
    const consentUrl = buildConsentUrl(name, [], this.config.dashboardUrl);
    this.config.logger.info("Opening consent page in your browser.", { url: consentUrl });
    process.stderr.write(
      `\nPermission may be required. Opening consent page...\n${consentUrl}\n\n`,
    );
    openBrowser(consentUrl);
  }
}
