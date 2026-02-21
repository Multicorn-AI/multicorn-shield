import { describe, it, expect, vi } from "vitest";
import { createLogger, isValidLogLevel } from "./logger.js";
import { Writable } from "node:stream";

function captureOutput(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines: () => chunks.flatMap((c) => c.split("\n").filter((l) => l.length > 0)) };
}

function parseLogLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("createLogger", () => {
  it("writes a structured JSON entry for each log call", () => {
    const { stream, lines } = captureOutput();
    const logger = createLogger("info", stream);

    logger.info("something happened");

    const entries = lines();
    expect(entries).toHaveLength(1);
    const entry = parseLogLine(entries[0] ?? "{}");
    expect(entry["level"]).toBe("info");
    expect(entry["msg"]).toBe("something happened");
    expect(typeof entry["time"]).toBe("string");
  });

  it("includes extra data fields in the log entry", () => {
    const { stream, lines } = captureOutput();
    const logger = createLogger("info", stream);

    logger.info("tool blocked", { tool: "gmail_send", agentId: "my-agent" });

    const entry = parseLogLine(lines()[0] ?? "{}");
    expect(entry["tool"]).toBe("gmail_send");
    expect(entry["agentId"]).toBe("my-agent");
  });

  it("suppresses messages below the configured level", () => {
    const { stream, lines } = captureOutput();
    const logger = createLogger("warn", stream);

    logger.debug("this is debug");
    logger.info("this is info");
    logger.warn("this is warn");

    expect(lines()).toHaveLength(1);
    expect(parseLogLine(lines()[0] ?? "{}")["level"]).toBe("warn");
  });

  it("passes through all levels when set to debug", () => {
    const { stream, lines } = captureOutput();
    const logger = createLogger("debug", stream);

    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(lines()).toHaveLength(4);
  });

  it("writes warn level correctly", () => {
    const { stream, lines } = captureOutput();
    const logger = createLogger("info", stream);

    logger.warn("something concerning");

    expect(parseLogLine(lines()[0] ?? "{}")["level"]).toBe("warn");
  });

  it("writes error level correctly", () => {
    const { stream, lines } = captureOutput();
    const logger = createLogger("info", stream);

    logger.error("something broke");

    expect(parseLogLine(lines()[0] ?? "{}")["level"]).toBe("error");
  });

  it("does not write when all messages are below the level", () => {
    const writeSpy = vi.fn();
    const stream = new Writable({ write: writeSpy });
    const logger = createLogger("error", stream);

    logger.debug("d");
    logger.info("i");
    logger.warn("w");

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("isValidLogLevel", () => {
  it("returns true for valid log levels", () => {
    expect(isValidLogLevel("debug")).toBe(true);
    expect(isValidLogLevel("info")).toBe(true);
    expect(isValidLogLevel("warn")).toBe(true);
    expect(isValidLogLevel("error")).toBe(true);
  });

  it("returns false for unknown strings", () => {
    expect(isValidLogLevel("verbose")).toBe(false);
    expect(isValidLogLevel("trace")).toBe(false);
    expect(isValidLogLevel("")).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isValidLogLevel(42)).toBe(false);
    expect(isValidLogLevel(null)).toBe(false);
    expect(isValidLogLevel(undefined)).toBe(false);
  });
});
