/**
 * Mock multicorn-service HTTP server for proxy integration tests.
 *
 * Lightweight server (Node built-in `http`, no Express) that stubs the
 * multicorn-service API endpoints used by the proxy. Records every request
 * for test assertions and accepts configurable scope/agent data.
 *
 * @module proxy/__fixtures__/mockMulticornService
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Scope } from "../../types/index.js";

export interface MockServiceConfig {
  readonly scopes?: readonly Scope[];
  readonly agents?: readonly MockAgent[];
}

export interface MockAgent {
  readonly id: string;
  readonly name: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

export interface MockMulticornService {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  stop(): Promise<void>;
}

const DEFAULT_AGENTS: readonly MockAgent[] = [{ id: "agent-1", name: "test-agent" }];

const DEFAULT_SCOPES: readonly Scope[] = [{ service: "gmail", permissionLevel: "execute" }];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function parseBody(raw: string): unknown {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Converts the flat scope list into the permission shape the proxy expects.
 * Groups scopes by service and produces one permission entry per service.
 */
function scopesToPermissions(scopes: readonly Scope[]): readonly Record<string, unknown>[] {
  const grouped = new Map<string, { read: boolean; write: boolean; execute: boolean }>();

  for (const scope of scopes) {
    let entry = grouped.get(scope.service);
    if (entry === undefined) {
      entry = { read: false, write: false, execute: false };
      grouped.set(scope.service, entry);
    }
    if (scope.permissionLevel === "read") entry.read = true;
    if (scope.permissionLevel === "write") entry.write = true;
    if (scope.permissionLevel === "execute") entry.execute = true;
  }

  const permissions: Record<string, unknown>[] = [];
  for (const [service, levels] of grouped) {
    permissions.push({
      service,
      read: levels.read,
      write: levels.write,
      execute: levels.execute,
      revokedAt: null,
    });
  }

  return permissions;
}

let agentCounter = 1000;

function generateAgentId(): string {
  agentCounter += 1;
  return `agent-${String(agentCounter)}`;
}

/**
 * Match paths like `/api/v1/agents/:id/scopes` and `/api/v1/agents/:id`.
 * Returns the agent ID segment, or null if the path doesn't match.
 */
function matchAgentScopesPath(path: string): string | null {
  const match = /^\/api\/v1\/agents\/([^/]+)\/scopes$/.exec(path);
  return match?.[1] ?? null;
}

function matchAgentDetailPath(path: string): string | null {
  const match = /^\/api\/v1\/agents\/([^/]+)$/.exec(path);
  if (match?.[1] === undefined) return null;
  if (match[1] === "") return null;
  return match[1];
}

export async function startMockMulticornService(
  config?: MockServiceConfig,
): Promise<MockMulticornService> {
  const agents = [...(config?.agents ?? DEFAULT_AGENTS)];
  const scopes = config?.scopes ?? DEFAULT_SCOPES;
  const requests: RecordedRequest[] = [];
  const permissions = scopesToPermissions(scopes);

  const server: Server = createServer();

  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res);
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";
    const raw = await readBody(req);
    const body = parseBody(raw);

    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }

    requests.push({ method, path, headers, body });

    if (path === "/api/v1/agents" && method === "GET") {
      json(res, 200, { success: true, data: agents });
      return;
    }

    if (path === "/api/v1/agents" && method === "POST") {
      const name =
        typeof body === "object" && body !== null
          ? (body as Record<string, unknown>)["name"]
          : undefined;
      const agentName = typeof name === "string" ? name : "unnamed";
      const newAgent = { id: generateAgentId(), name: agentName };
      agents.push(newAgent);
      json(res, 201, { success: true, data: newAgent });
      return;
    }

    const scopeAgentId = matchAgentScopesPath(path);
    if (scopeAgentId !== null && method === "GET") {
      json(res, 200, { success: true, data: { permissions } });
      return;
    }

    const detailAgentId = matchAgentDetailPath(path);
    if (detailAgentId !== null && method === "GET") {
      json(res, 200, { success: true, data: { permissions } });
      return;
    }

    if (path === "/api/v1/actions" && method === "POST") {
      json(res, 201, { success: true });
      return;
    }

    json(res, 404, { success: false, error: "Not found" });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);

    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind mock server to a port."));
        return;
      }

      const baseUrl = `http://127.0.0.1:${String(addr.port)}`;

      function stop(): Promise<void> {
        return new Promise((resolveStop, rejectStop) => {
          server.close((err) => {
            if (err) {
              rejectStop(err);
            } else {
              resolveStop();
            }
          });
        });
      }

      resolve({ baseUrl, requests, stop });
    });
  });
}
