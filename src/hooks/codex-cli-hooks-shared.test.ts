import { describe, expect, it } from "vitest";
import {
  redactSecretsForAudit,
  serializeHookAuditFragment,
  truncateForAudit,
} from "./codex-cli-hooks-shared.js";

describe("codex-cli-hooks-shared", () => {
  it("truncateForAudit appends marker when over limit", () => {
    const long = "z".repeat(10_001);
    const out = truncateForAudit(long, 10_000);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(out.length).toBe(10_000 + "[truncated]".length);
  });

  it("serializeHookAuditFragment redacts then truncates", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789abcd";
    const payload = { cmd: `run ${secret}` };
    const out = serializeHookAuditFragment(payload);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain(secret.slice(0, 10));
  });

  it("redactSecretsForAudit masks token= query pairs", () => {
    expect(redactSecretsForAudit("foo token=abc123secret bar")).toContain("token=[REDACTED]");
  });
});
