/**
 * Action logging client for recording agent activity.
 *
 * Sends structured action logs to the Multicorn Shield API
 * for audit trail and compliance purposes.
 *
 * @module logger
 */

export {
  createActionLogger,
  type ActionLogger,
  type ActionLoggerConfig,
  type ActionPayload,
  type BatchModeConfig,
} from "./action-logger.js";
