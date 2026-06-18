import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type * as FilesModule from "./files.js";

// A PID that cannot be alive (above the platform max), so isProcessAlive() reports dead.
const DEAD_PID = 2_000_000;

let home: string;
let mod: typeof FilesModule;
const LOCK_PATH = (): string => join(home, ".resources.lock");

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "shield-home-"));
  // Point all registry/lock state at a throwaway dir, never the real ~/.multicorn.
  process.env["MULTICORN_HOME"] = home;
  mod = await import("./files.js");
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env["MULTICORN_HOME"];
});

// ---------------------------------------------------------------------------
// Folder identity (security: realpath dedup, siblings never collide)
// ---------------------------------------------------------------------------

describe("canonicalFolder", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "shield-folders-"));
    mkdirSync(join(root, "repo"), { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves './repo' and 'repo/' to the same identity", () => {
    const a = mod.canonicalFolder(join(root, "repo"));
    const b = mod.canonicalFolder(join(root, "repo", "."));
    expect(a).toBe(b);
  });

  it("resolves a symlink to the same identity as its target", () => {
    const target = join(root, "repo");
    const link = join(root, "repo-link");
    try {
      symlinkSync(target, link);
    } catch {
      return; // symlink not permitted in this environment; skip
    }
    expect(mod.canonicalFolder(link)).toBe(mod.canonicalFolder(target));
  });

  it("never collides two different folders (no cross-folder dedup)", () => {
    expect(mod.canonicalFolder(join(root, "repo"))).not.toBe(
      mod.canonicalFolder(join(root, "other")),
    );
  });
});

// ---------------------------------------------------------------------------
// Auto-port allocation
// ---------------------------------------------------------------------------

describe("nextFreePort", () => {
  const neverBusy = (): Promise<boolean> => Promise.resolve(false);

  it("returns the start port when free and unclaimed", async () => {
    const port = await mod.nextFreePort(3005, new Set(), neverBusy);
    expect(port).toBe(3005);
  });

  it("skips claimed ports", async () => {
    const port = await mod.nextFreePort(3005, new Set([3005, 3006]), neverBusy);
    expect(port).toBe(3007);
  });

  it("skips ports that are currently listening", async () => {
    const busy = new Set([3005, 3006]);
    const isBusy = (p: number): Promise<boolean> => Promise.resolve(busy.has(p));
    const port = await mod.nextFreePort(3005, new Set(), isBusy);
    expect(port).toBe(3007);
  });

  it("throws when no free port is found in range", async () => {
    await expect(mod.nextFreePort(3005, new Set(), () => Promise.resolve(true), 3)).rejects.toThrow(
      /No free port/,
    );
  });
});

// ---------------------------------------------------------------------------
// Refcount predicates (race-safe teardown decision)
// ---------------------------------------------------------------------------

const agent = (
  name: string,
  dir: string,
  proxyPort: number,
  supervisorPid: number,
): { agent: string; dir: string; supervisorPid: number; fsPort: number; proxyPort: number } => ({
  agent: name,
  dir,
  supervisorPid,
  fsPort: 3005,
  proxyPort,
});

describe("agentsReferencingProxy", () => {
  it("excludes the stopping agent and reports remaining users", () => {
    const agents = [agent("a", "/x", 3001, process.pid), agent("b", "/y", 3001, process.pid)];
    expect(mod.agentsReferencingProxy(3001, agents, "a")).toHaveLength(1);
  });

  it("reports zero when the stopping agent is the last user", () => {
    const agents = [agent("a", "/x", 3001, process.pid)];
    expect(mod.agentsReferencingProxy(3001, agents, "a")).toHaveLength(0);
  });
});

describe("agentsReferencingFolder", () => {
  it("two agents on the same folder keep it referenced after one stops", () => {
    const agents = [
      agent("a", "/shared", 3001, process.pid),
      agent("b", "/shared", 3001, process.pid),
    ];
    expect(mod.agentsReferencingFolder("/shared", agents, "a")).toHaveLength(1);
  });

  it("a folder used by only the stopping agent has no remaining users", () => {
    const agents = [
      agent("a", "/solo", 3001, process.pid),
      agent("b", "/other", 3001, process.pid),
    ];
    expect(mod.agentsReferencingFolder("/solo", agents, "a")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Lock staleness + reclaim (watch-point: a crashed start must not wedge forever)
// ---------------------------------------------------------------------------

describe("isLockStale", () => {
  it("treats a missing holder as stale", () => {
    expect(mod.isLockStale(null)).toBe(true);
  });

  it("treats a dead holder as stale", () => {
    expect(mod.isLockStale({ pid: DEAD_PID, ts: Date.now() })).toBe(true);
  });

  it("treats a live recent holder as held", () => {
    expect(mod.isLockStale({ pid: process.pid, ts: Date.now() })).toBe(false);
  });

  it("treats a live but very old holder as stale (PID-reuse backstop)", () => {
    expect(mod.isLockStale({ pid: process.pid, ts: Date.now() - 10 * 60_000 })).toBe(true);
  });
});

describe("acquireResourceLock", () => {
  it("reclaims a lock held by a crashed (dead-pid) process", async () => {
    // Simulate a process that crashed mid-start, leaving its lock behind.
    mkdirSync(home, { recursive: true });
    writeFileSync(LOCK_PATH(), JSON.stringify({ pid: DEAD_PID, ts: Date.now() }), "utf8");
    expect(existsSync(LOCK_PATH())).toBe(true);

    // A fresh run must reclaim it rather than wedge waiting forever.
    await mod.acquireResourceLock();

    const held = JSON.parse(readFileSync(LOCK_PATH(), "utf8")) as { pid: number };
    expect(held.pid).toBe(process.pid);

    mod.releaseResourceLock();
    expect(existsSync(LOCK_PATH())).toBe(false);
  });

  it("releaseResourceLock only removes a lock we hold", async () => {
    await mod.acquireResourceLock();
    expect(existsSync(LOCK_PATH())).toBe(true);
    // A lock owned by someone else (different pid) must not be deleted by us.
    writeFileSync(LOCK_PATH(), JSON.stringify({ pid: DEAD_PID, ts: Date.now() }), "utf8");
    mod.releaseResourceLock();
    expect(existsSync(LOCK_PATH())).toBe(true);
    // cleanup
    rmSync(LOCK_PATH(), { force: true });
  });
});
