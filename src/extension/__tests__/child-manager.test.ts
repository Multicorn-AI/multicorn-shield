/**
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecFileSyncOptions, SpawnOptions } from "node:child_process";
import { createLogger } from "../../proxy/logger.js";

const execFileSyncMock = vi.hoisted(() =>
  vi.fn((file: string, args?: readonly string[], options?: ExecFileSyncOptions) => {
    void file;
    void args;
    void options;
    throw new Error("not found");
  }),
);

const spawnMock = vi.hoisted(() =>
  vi.fn(
    (
      command: string,
      args: readonly string[],
      options?: SpawnOptions,
    ): {
      pid: number;
      stdout: { on: ReturnType<typeof vi.fn> };
      stderr: { on: ReturnType<typeof vi.fn> };
      stdin: { write: ReturnType<typeof vi.fn> };
      on: ReturnType<typeof vi.fn>;
      kill: ReturnType<typeof vi.fn>;
    } => {
      void command;
      void args;
      void options;
      return {
        pid: 99_999,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        stdin: { write: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };
    },
  ),
);

vi.mock("node:child_process", async (importOriginal) => {
  // Vitest needs the full `node:child_process` module type; `import type` cannot name it for generics.
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- see above
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    execFileSync: (...args: Parameters<typeof mod.execFileSync>) =>
      execFileSyncMock(...args) as ReturnType<typeof mod.execFileSync>,
    spawn: (...args: Parameters<typeof mod.spawn>) => spawnMock(...args),
  };
});

vi.mock("../json-rpc-child.js", () => ({
  JsonRpcChildSession: class {
    request(): Promise<Record<string, unknown>> {
      return Promise.resolve({});
    }
    notify(): void {
      return;
    }
  },
}));

describe("ChildManager", () => {
  beforeEach(() => {
    execFileSyncMock.mockClear();
    execFileSyncMock.mockImplementation(() => {
      throw new Error("not found");
    });
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves which via execFileSync with argv, not a shell string", async () => {
    const { ChildManager } = await import("../child-manager.js");
    const malicious = "node; echo pwned";
    const manager = new ChildManager({ logger: createLogger("error") });
    await manager.startAll({
      t: { command: malicious, args: [] as readonly string[], env: {} },
    });

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "which",
      [malicious],
      expect.objectContaining({ encoding: "utf8" }),
    );
    expect(spawnMock).toHaveBeenCalledWith(
      malicious,
      [],
      expect.objectContaining({
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  });
});
