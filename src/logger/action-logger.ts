/**
 * Action logging client for Multicorn Shield.
 *
 * Sends structured action events to the Multicorn hosted API, providing the
 * observability backbone for Shield. Every agent action is logged with
 * metadata, cost information, and status tracking.
 *
 * **Design principles:**
 * - **Fire-and-forget**: Logging failures MUST NOT block the agent's action.
 * - **Security (Jordan persona)**: API keys never logged, HTTPS enforced.
 * - **Clear errors (Yuki persona)**: Descriptive messages for all failure modes.
 * - **Clean async (The Team persona)**: Proper promise handling, no hanging requests.
 *
 * @module logger/action-logger
 */

import { type ActionStatus } from "../types/index.js";

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Configuration options for the action logger client.
 *
 * @example
 * ```ts
 * const config: ActionLoggerConfig = {
 *   apiKey: process.env.MULTICORN_API_KEY,
 *   baseUrl: "https://api.multicorn.ai",
 *   timeout: 5000,
 *   batchMode: {
 *     enabled: true,
 *     maxSize: 10,
 *     flushIntervalMs: 5000,
 *   },
 * };
 * ```
 */
export interface ActionLoggerConfig {
  /**
   * Multicorn API key for authentication.
   * Passed as `X-Multicorn-Key` header. Never logged.
   */
  readonly apiKey: string;

  /**
   * Base URL for the Multicorn API.
   * @default "https://api.multicorn.ai"
   */
  readonly baseUrl?: string;

  /**
   * Request timeout in milliseconds.
   * @default 5000
   */
  readonly timeout?: number;

  /**
   * Optional batch mode configuration.
   * When enabled, actions are queued and flushed periodically.
   */
  readonly batchMode?: BatchModeConfig;

  /**
   * Optional error handler for logging failures.
   * Called asynchronously. Does not block the main action flow.
   */
  readonly onError?: (error: Error) => void;
}

/**
 * Batch mode configuration.
 *
 * Actions are flushed when **either** condition is met:
 * - The queue reaches `maxSize` actions, OR
 * - `flushIntervalMs` milliseconds have elapsed since the last flush.
 */
export interface BatchModeConfig {
  /** Whether batch mode is enabled. */
  readonly enabled: boolean;

  /**
   * Maximum number of actions to queue before forcing a flush.
   * @default 10
   */
  readonly maxSize?: number;

  /**
   * Maximum time (ms) between flushes.
   * @default 5000
   */
  readonly flushIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Action payload types
// ---------------------------------------------------------------------------

/**
 * A single action event to be logged.
 *
 * @example
 * ```ts
 * const action: ActionPayload = {
 *   agent: "inbox-assistant",
 *   service: "gmail",
 *   actionType: "send_email",
 *   status: "approved",
 *   cost: 0.002,
 *   metadata: {
 *     recipient: "user@example.com",
 *     subject: "Weekly report",
 *   },
 * };
 * ```
 */
export interface ActionPayload {
  /** Agent identifier (e.g. "inbox-assistant"). */
  readonly agent: string;

  /** Service being accessed (e.g. "gmail", "slack"). */
  readonly service: string;

  /** Type of action performed (e.g. "send_email", "read_message"). */
  readonly actionType: string;

  /** Lifecycle status of the action. */
  readonly status: ActionStatus;

  /**
   * Optional cost in USD incurred by this action.
   * Present only for actions with usage-based pricing.
   */
  readonly cost?: number;

  /**
   * Optional structured metadata for additional context.
   * Keys and values must be serializable to JSON.
   */
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

// ---------------------------------------------------------------------------
// Internal queue item
// ---------------------------------------------------------------------------

interface QueuedAction {
  readonly payload: ActionPayload;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Action Logger Client
// ---------------------------------------------------------------------------

/**
 * HTTP client for logging agent actions to the Multicorn Shield API.
 *
 * Supports both immediate and batched delivery modes. All network failures
 * are handled gracefully to ensure logging never blocks the agent's execution.
 *
 * @example Basic usage (immediate mode)
 * ```ts
 * const logger = createActionLogger({
 *   apiKey: process.env.MULTICORN_API_KEY!,
 * });
 *
 * await logger.logAction({
 *   agent: "email-assistant",
 *   service: "gmail",
 *   actionType: "send_email",
 *   status: "approved",
 *   cost: 0.002,
 * });
 * ```
 *
 * @example Batch mode with error handling
 * ```ts
 * const logger = createActionLogger({
 *   apiKey: process.env.MULTICORN_API_KEY!,
 *   batchMode: { enabled: true, maxSize: 10, flushIntervalMs: 5000 },
 *   onError: (err) => console.error("[ActionLogger]", err.message),
 * });
 *
 * // Actions are queued and flushed automatically
 * logger.logAction({
 *   agent: "inbox-assistant",
 *   service: "gmail",
 *   actionType: "read_message",
 *   status: "approved",
 * });
 *
 * // Force immediate flush
 * await logger.flush();
 *
 * // Clean up resources
 * logger.shutdown();
 * ```
 */
export interface ActionLogger {
  /**
   * Log a single action event.
   *
   * In immediate mode, sends the action to the API right away (non-blocking).
   * In batch mode, queues the action and flushes when thresholds are met.
   *
   * @param action - The action event to log.
   * @returns A promise that resolves when the action is sent (immediate mode)
   *          or queued (batch mode). Rejects only on validation errors, not
   *          network failures (those are passed to `onError`).
   */
  logAction(action: ActionPayload): Promise<void>;

  /**
   * Flush all queued actions immediately (batch mode only).
   *
   * In immediate mode, this is a no-op.
   *
   * @returns A promise that resolves when all queued actions have been sent.
   */
  flush(): Promise<void>;

  /**
   * Shut down the logger and clean up resources.
   *
   * Stops the flush timer (if in batch mode) and flushes any remaining actions.
   * After calling `shutdown()`, the logger should not be used.
   */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new action logger client.
 *
 * @param config - Configuration options.
 * @returns An {@link ActionLogger} instance.
 * @throws {Error} If the API key is missing or the base URL is not HTTPS.
 *
 * @example
 * ```ts
 * const logger = createActionLogger({
 *   apiKey: process.env.MULTICORN_API_KEY!,
 *   baseUrl: "https://api.multicorn.ai",
 *   timeout: 3000,
 * });
 * ```
 */
export function createActionLogger(config: ActionLoggerConfig): ActionLogger {
  // Validate configuration
  if (!config.apiKey || config.apiKey.trim().length === 0) {
    throw new Error(
      "[ActionLogger] API key is required. Provide it via the 'apiKey' config option.",
    );
  }

  const baseUrl = config.baseUrl ?? "https://api.multicorn.ai";
  const timeout = config.timeout ?? 5000;

  // Enforce HTTPS (Jordan persona: security first)
  if (!baseUrl.startsWith("https://") && !baseUrl.startsWith("http://localhost")) {
    throw new Error(
      `[ActionLogger] Base URL must use HTTPS for security. Received: "${baseUrl}". ` +
        "Use https:// or http://localhost for local development.",
    );
  }

  const endpoint = `${baseUrl}/api/v1/actions`;

  // Batch mode setup
  const batchEnabled = config.batchMode?.enabled ?? false;
  const maxBatchSize = config.batchMode?.maxSize ?? 10;
  const flushInterval = config.batchMode?.flushIntervalMs ?? 5000;
  const queue: QueuedAction[] = [];
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let isShutdown = false;

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Send actions to the API with retry logic.
   *
   * - Retries once on 5xx errors with exponential backoff (100ms → 200ms).
   * - Does NOT retry on 4xx errors (client errors, no point retrying).
   * - Respects the configured timeout.
   */
  async function sendActions(actions: readonly ActionPayload[]): Promise<void> {
    if (actions.length === 0) return;

    // Convert ActionPayload to backend's expected format
    const convertAction = (
      action: ActionPayload,
    ): {
      agent: string;
      service: string;
      actionType: string;
      status: ActionStatus;
      cost?: number;
      metadata?: Readonly<Record<string, string | number | boolean>>;
    } => ({
      agent: action.agent,
      service: action.service,
      actionType: action.actionType,
      status: action.status,
      ...(action.cost !== undefined ? { cost: action.cost } : {}),
      ...(action.metadata !== undefined ? { metadata: action.metadata } : {}),
    });

    const convertedActions = actions.map(convertAction);
    const payload = batchEnabled ? { actions: convertedActions } : convertedActions[0];

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, timeout);

        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Multicorn-Key": config.apiKey,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Success
        if (response.ok) {
          return;
        }

        // 4xx: Client error, don't retry
        if (response.status >= 400 && response.status < 500) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `[ActionLogger] Client error (${String(response.status)}): ${response.statusText}. ` +
              `Response: ${body}. Check your API key and payload format.`,
          );
        }

        // 5xx: Server error, retry once
        if (response.status >= 500 && attempt === 0) {
          lastError = new Error(
            `[ActionLogger] Server error (${String(response.status)}): ${response.statusText}. ` +
              "Retrying once...",
          );
          await sleep(100 * Math.pow(2, attempt)); // 100ms, then 200ms
          continue;
        }

        // 5xx on second attempt: give up
        throw new Error(
          `[ActionLogger] Server error (${String(response.status)}) after retry: ${response.statusText}. ` +
            "Multicorn API may be experiencing issues.",
        );
      } catch (error) {
        // Network error or abort
        if (error instanceof Error) {
          if (error.name === "AbortError") {
            lastError = new Error(
              `[ActionLogger] Request timeout after ${String(timeout)}ms. ` +
                "Increase the 'timeout' config option or check your network connection.",
            );
          } else if (
            error.message.includes("Client error") ||
            error.message.includes("Server error")
          ) {
            lastError = error;
          } else {
            lastError = new Error(
              `[ActionLogger] Network error: ${error.message}. ` +
                "Check your network connection and API endpoint.",
            );
          }
        } else {
          lastError = new Error(`[ActionLogger] Unknown error: ${String(error)}`);
        }

        // Retry on network errors (attempt 0 only)
        if (attempt === 0 && !lastError.message.includes("Client error")) {
          await sleep(100 * Math.pow(2, attempt));
          continue;
        }

        break;
      }
    }

    // If we got here, all attempts failed
    if (lastError) {
      if (config.onError) {
        config.onError(lastError);
      }
      // Fire-and-forget: don't throw, just log the error
    }
  }

  /**
   * Flush the batch queue.
   */
  async function flushQueue(): Promise<void> {
    if (queue.length === 0) return;

    const actions = queue.map((item) => item.payload);
    queue.length = 0; // Clear the queue

    await sendActions(actions);
  }

  /**
   * Start the flush timer (batch mode only).
   */
  function startFlushTimer(): void {
    if (flushTimer !== undefined) return;

    flushTimer = setInterval(() => {
      // Fire-and-forget
      flushQueue().catch(() => {
        // Errors already handled by onError callback
      });
    }, flushInterval);

    // Prevent the timer from keeping the process alive (Node.js only)
    const timer = flushTimer as unknown as { unref?: () => void };
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  }

  /**
   * Stop the flush timer.
   */
  function stopFlushTimer(): void {
    if (flushTimer) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
  }

  // Start the timer if batch mode is enabled
  if (batchEnabled) {
    startFlushTimer();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    logAction(action: ActionPayload): Promise<void> {
      if (isShutdown) {
        throw new Error(
          "[ActionLogger] Cannot log action after shutdown. Create a new logger instance.",
        );
      }

      // Validate action
      if (action.agent.trim().length === 0) {
        throw new Error("[ActionLogger] Action must have a non-empty 'agent' field.");
      }
      if (action.service.trim().length === 0) {
        throw new Error("[ActionLogger] Action must have a non-empty 'service' field.");
      }
      if (action.actionType.trim().length === 0) {
        throw new Error("[ActionLogger] Action must have a non-empty 'actionType' field.");
      }
      if (action.status.trim().length === 0) {
        throw new Error("[ActionLogger] Action must have a non-empty 'status' field.");
      }

      if (batchEnabled) {
        // Queue the action
        queue.push({ payload: action, timestamp: Date.now() });

        // Flush if we hit the batch size limit
        if (queue.length >= maxBatchSize) {
          // Fire-and-forget
          flushQueue().catch(() => {
            // Errors already handled by onError callback
          });
        }
      } else {
        // Immediate mode: send right away (fire-and-forget)
        sendActions([action]).catch(() => {
          // Errors already handled by onError callback
        });
      }

      return Promise.resolve();
    },

    async flush(): Promise<void> {
      if (!batchEnabled) return;
      await flushQueue();
    },

    async shutdown(): Promise<void> {
      if (isShutdown) return;

      isShutdown = true;
      stopFlushTimer();

      // Flush any remaining actions
      if (batchEnabled) {
        await flushQueue();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Sleep for a given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
