import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:module", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vitest importOriginal generic
  const actual = await importOriginal<typeof import("node:module")>();
  return {
    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- partial mock of node built-in
    ...actual,
    createRequire: () => ({
      resolve: (specifier: string) => {
        throw new Error(`not found: ${specifier}`);
      },
    }),
  };
});

const { resolveLocalProxyServerEntry } = await import("./local-proxy-start.js");

function writeShieldPackage(root: string): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "multicorn-shield" }), "utf8");
}

function writeServerEntry(packageRoot: string): string {
  writeShieldPackage(packageRoot);
  const serverPath = join(packageRoot, "dist", "server.js");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(serverPath, "// local proxy server entry\n", "utf8");
  return serverPath;
}

describe("resolveLocalProxyServerEntry package root", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function makeTempRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "shield-entry-"));
    tempDirs.push(dir);
    return dir;
  }

  it("resolves dist/server.js when the module sits in bundled dist layout", () => {
    const packageRoot = makeTempRoot();
    const expected = writeServerEntry(packageRoot);
    const moduleDir = join(packageRoot, "dist");

    expect(resolveLocalProxyServerEntry({ moduleDir })).toBe(expected);
  });

  it("resolves dist/server.js when the module sits in src/commands layout", () => {
    const packageRoot = makeTempRoot();
    const expected = writeServerEntry(packageRoot);
    const moduleDir = join(packageRoot, "src", "commands");
    mkdirSync(moduleDir, { recursive: true });

    expect(resolveLocalProxyServerEntry({ moduleDir })).toBe(expected);
  });

  it("throws when dist/server.js is missing under the located package root", () => {
    const packageRoot = makeTempRoot();
    writeShieldPackage(packageRoot);
    const moduleDir = join(packageRoot, "dist");
    mkdirSync(moduleDir, { recursive: true });

    expect(() => resolveLocalProxyServerEntry({ moduleDir })).toThrow(
      /Local proxy server entry \(dist\/server\.js\) not found/,
    );
  });
});
