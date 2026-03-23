/**
 * @vitest-environment node
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { ShieldExtensionRuntime } from "../runtime.js";
import { createLogger } from "../../proxy/logger.js";
import { deriveDashboardUrl } from "../../proxy/consent.js";
import {
  startMockMulticornService,
  type MockMulticornService,
} from "../../proxy/__fixtures__/mockMulticornService.js";

const readFileMock = vi.hoisted(() => vi.fn());
const writeFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mkdirMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("node:fs/promises", () => {
  const exports = {
    readFile: readFileMock,
    writeFile: writeFileMock,
    mkdir: mkdirMock,
  };
  return { default: exports, ...exports };
});

describe("Shield extension runtime (integration)", () => {
  let mockService: MockMulticornService | undefined;
  let runtime: ShieldExtensionRuntime | undefined;

  afterEach(async () => {
    readFileMock.mockReset();
    writeFileMock.mockReset();
    mkdirMock.mockReset();
    const rt = runtime;
    const svc = mockService;
    runtime = undefined;
    mockService = undefined;
    if (rt !== undefined) {
      await rt.stop();
    }
    if (svc !== undefined) {
      await svc.stop();
    }
  });

  it("allows a tool call when scopes permit execute on the service", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));

    mockService = await startMockMulticornService({
      scopes: [{ service: "gmail", permissionLevel: "write" }],
    });
    const baseUrl = mockService.baseUrl.replace("127.0.0.1", "localhost");

    runtime = new ShieldExtensionRuntime({
      apiKey: "test-key",
      agentName: "test-agent",
      baseUrl,
      dashboardUrl: deriveDashboardUrl(baseUrl),
      logger: createLogger("error"),
    });

    await runtime.start();

    const decision = await runtime.evaluateToolCall("gmail_send_email");

    expect(decision.allow).toBe(true);
  });

  it("denies when Shield cannot reach the API (offline agent id)", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));

    runtime = new ShieldExtensionRuntime({
      apiKey: "test-key",
      agentName: "test-agent",
      baseUrl: "http://127.0.0.1:1",
      dashboardUrl: "https://app.multicorn.ai",
      logger: createLogger("error"),
    });

    await runtime.start();

    const decision = await runtime.evaluateToolCall("gmail_send_email");

    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.result.isError).toBe(true);
      const text = decision.result.content[0];
      expect(text?.type).toBe("text");
      expect((text as { text: string }).text).toContain("unreachable");
    }
  });
});
