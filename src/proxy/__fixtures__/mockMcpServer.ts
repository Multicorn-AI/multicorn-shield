/**
 * Mock MCP server fixture for proxy integration tests.
 *
 * Spawns a child process that speaks stdio JSON-RPC 2.0, exposing three
 * tools: gmail_send_email, calendar_create_event, and payments_charge.
 * Tests can configure individual tools to fail or hang for error path coverage.
 *
 * @module proxy/__fixtures__/mockMcpServer
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface MockMcpServerConfig {
  readonly failingTools?: readonly string[];
  readonly hangingTools?: readonly string[];
}

export interface MockMcpServer {
  readonly process: ChildProcess;
  readonly command: string;
  readonly args: readonly string[];
  stop(): Promise<void>;
}

const TOOL_MANIFEST = [
  {
    name: "gmail_send_email",
    description: "Send an email via Gmail",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a calendar event",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        date: { type: "string" },
      },
      required: ["title", "date"],
    },
  },
  {
    name: "payments_charge",
    description: "Charge a payment",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        currency: { type: "string" },
      },
      required: ["amount", "currency"],
    },
  },
];

/**
 * Builds the inline JS source for the child process. The script reads
 * newline-delimited JSON-RPC from stdin and writes responses to stdout.
 */
function buildServerScript(config?: MockMcpServerConfig): string {
  const manifest = JSON.stringify(TOOL_MANIFEST);
  const failing = JSON.stringify(config?.failingTools ?? []);
  const hanging = JSON.stringify(config?.hangingTools ?? []);

  return `
    import { createInterface } from "node:readline";

    const tools = ${manifest};
    const failingTools = new Set(${failing});
    const hangingTools = new Set(${hanging});

    function respond(id, result) {
      const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
      process.stdout.write(msg + "\\n");
    }

    function respondError(id, code, message) {
      const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
      process.stdout.write(msg + "\\n");
    }

    function buildToolResult(name, args) {
      if (name === "gmail_send_email") {
        return "Email sent to " + (args.to || "unknown");
      }
      if (name === "calendar_create_event") {
        return "Event created: " + (args.title || "untitled");
      }
      if (name === "payments_charge") {
        return "Charged " + (args.amount ?? 0) + " " + (args.currency || "USD");
      }
      return "Unknown tool: " + name;
    }

    function handleRequest(line) {
      let request;
      try {
        request = JSON.parse(line);
      } catch {
        return;
      }

      if (request.jsonrpc !== "2.0") return;

      const id = request.id ?? null;
      const method = request.method;

      if (method === "initialize") {
        respond(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-mcp-server", version: "1.0.0" },
        });
        return;
      }

      if (method === "notifications/initialized") {
        return;
      }

      if (method === "tools/list") {
        respond(id, { tools });
        return;
      }

      if (method === "tools/call") {
        const params = request.params || {};
        const toolName = params.name || "";
        const toolArgs = params.arguments || {};

        if (hangingTools.has(toolName)) {
          return;
        }

        if (failingTools.has(toolName)) {
          respondError(id, -32603, "Tool execution failed: " + toolName);
          return;
        }

        const text = buildToolResult(toolName, toolArgs);
        respond(id, { content: [{ type: "text", text }] });
        return;
      }

      respondError(id, -32601, "Method not found: " + method);
    }

    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => handleRequest(line));
    rl.on("close", () => process.exit(0));
  `;
}

export function startMockMcpServer(config?: MockMcpServerConfig): MockMcpServer {
  const script = buildServerScript(config);
  const args = ["--input-type=module", "-e", script];

  const child = spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }

      child.once("exit", () => {
        resolve();
      });

      child.kill("SIGTERM");
    });
  }

  return {
    process: child,
    command: process.execPath,
    args,
    stop,
  };
}
