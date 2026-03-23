/**
 * @vitest-environment node
 */

import { describe, it, expect, afterEach } from "vitest";
import { ChildManager } from "../child-manager.js";
import { createLogger } from "../../proxy/logger.js";
import { startMockMcpServer } from "../../proxy/__fixtures__/mockMcpServer.js";

describe("child-manager", () => {
  let manager: ChildManager | undefined;

  afterEach(() => {
    if (manager !== undefined) {
      manager.stopAll();
    }
  });

  it("starts a mock MCP child and returns tools from tools/list", async () => {
    const mockServer = startMockMcpServer();
    const command = mockServer.command;
    const args = [...mockServer.args];
    await mockServer.stop();

    manager = new ChildManager({ logger: createLogger("error") });
    await manager.startAll({
      mock: { command, args },
    });

    const map = await manager.listToolsForAll();
    const tools = map.get("mock");
    expect(tools).toBeDefined();
    expect(tools?.map((t) => t.name).sort()).toEqual(
      ["calendar_create_event", "gmail_send_email", "payments_charge"].sort(),
    );
  });
});
