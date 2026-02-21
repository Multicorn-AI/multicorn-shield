/**
 * Structured JSON logger for the MCP proxy.
 *
 * Writes to stderr only — stdout is reserved for the MCP JSON-RPC transport.
 * Log output is newline-delimited JSON so it can be parsed by log aggregators.
 *
 * @module proxy/logger
 */

import { type Writable } from "node:stream";

export const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

export type LogLevel = keyof typeof LOG_LEVELS;

export interface ProxyLogger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel, output: Writable = process.stderr): ProxyLogger {
  const minLevel = LOG_LEVELS[level];

  function write(logLevel: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[logLevel] < minLevel) return;
    const entry: Record<string, unknown> = {
      level: logLevel,
      time: new Date().toISOString(),
      msg,
      ...data,
    };
    output.write(JSON.stringify(entry) + "\n");
  }

  return {
    debug: (msg, data) => {
      write("debug", msg, data);
    },
    info: (msg, data) => {
      write("info", msg, data);
    },
    warn: (msg, data) => {
      write("warn", msg, data);
    },
    error: (msg, data) => {
      write("error", msg, data);
    },
  };
}

export function isValidLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && Object.hasOwn(LOG_LEVELS, value);
}
