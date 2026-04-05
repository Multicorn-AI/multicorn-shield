/**
 * JSON-RPC 2.0 over newline-delimited stdio for a spawned MCP child process.
 *
 * @module extension/json-rpc-child
 */

import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";

export interface JsonRpcChildSessionOptions {
  readonly child: ChildProcess;
  readonly label: string;
  readonly requestTimeoutMs?: number;
  readonly logStderr?: (line: string) => void;
}

export class JsonRpcChildSession {
  private readonly child: ChildProcess;
  private readonly label: string;
  private readonly requestTimeoutMs: number;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void; timer: NodeJS.Timeout }
  >();

  constructor(options: JsonRpcChildSessionOptions) {
    this.child = options.child;
    this.label = options.label;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    const logStderr = options.logStderr;

    const stdout = this.child.stdout;
    if (stdout === null) {
      throw new Error(`Child "${this.label}" has no stdout pipe.`);
    }

    const rl = createInterface({ input: stdout, terminal: false });
    rl.on("line", (line) => {
      this.handleLine(line);
    });

    const stderr = this.child.stderr;
    if (stderr !== null) {
      stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text.length > 0 && logStderr !== undefined) {
          for (const part of text.split("\n")) {
            logStderr(part);
          }
        }
      });
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const stdin = this.child.stdin;
    if (stdin === null) {
      throw new Error(`Child "${this.label}" has no stdin pipe.`);
    }

    const id = this.nextId;
    this.nextId += 1;

    const payload: Record<string, unknown> = {
      jsonrpc: "2.0",
      id,
      method,
    };
    if (params !== undefined) {
      payload["params"] = params;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request "${method}" timed out for child "${this.label}".`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    const stdin = this.child.stdin;
    if (stdin === null) {
      return;
    }
    const payload: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (params !== undefined) {
      payload["params"] = params;
    }
    stdin.write(JSON.stringify(payload) + "\n");
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (typeof parsed !== "object" || parsed === null) return;
    const obj = parsed as Record<string, unknown>;

    if (!("id" in obj) || obj["id"] === null || obj["id"] === undefined) {
      return;
    }

    const id = obj["id"];
    const numericId =
      typeof id === "number" ? id : typeof id === "string" ? Number(id) : Number.NaN;
    if (Number.isNaN(numericId)) return;

    const entry = this.pending.get(numericId);
    if (entry === undefined) return;

    clearTimeout(entry.timer);
    this.pending.delete(numericId);

    if (obj["error"] !== undefined) {
      const err = obj["error"] as Record<string, unknown>;
      const message = typeof err["message"] === "string" ? err["message"] : "Child JSON-RPC error";
      entry.reject(new Error(`${this.label}: ${message}`));
      return;
    }

    entry.resolve(obj["result"]);
  }
}
