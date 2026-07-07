/**
 * Validates OpenClaw plugin config shape against the manifest configSchema.
 *
 * OpenClaw validates `plugins.entries.<id>.config` against each plugin's
 * configSchema (not the full entry wrapper; `enabled` lives on the entry).
 *
 * @module openclaw/__tests__/openclaw-plugin-config.test
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { describe, it, expect } from "vitest";
import {
  buildOpenClawShieldPluginConfig,
  OPENCLAW_SHIELD_API_KEY_ENV_REF,
} from "../../proxy/config.js";

const manifestPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../plugin/openclaw.plugin.json",
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  configSchema: Record<string, unknown>;
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validatePluginConfig = ajv.compile(manifest.configSchema);

describe("OpenClaw multicorn-shield plugin configSchema", () => {
  it("accepts config written by buildOpenClawShieldPluginConfig", () => {
    const config = buildOpenClawShieldPluginConfig({
      baseUrl: "http://localhost:8080",
      agentName: "openclaw-native",
    });

    expect(validatePluginConfig(config)).toBe(true);
    expect(config["apiKey"]).toBe(OPENCLAW_SHIELD_API_KEY_ENV_REF);
    expect(config["failMode"]).toBe("closed");
  });

  it("rejects legacy env-wrapper shape inside config (additionalProperties: false)", () => {
    const legacy = {
      enabled: true,
      env: {
        MULTICORN_API_KEY: "mcs_test_key_12345678",
        MULTICORN_BASE_URL: "http://localhost:8080",
      },
      agentName: "openclaw-native",
    };

    expect(validatePluginConfig(legacy)).toBe(false);
  });

  it("rejects flat manifest keys on entry wrapper when validated as inner config", () => {
    // Documents that configSchema applies to .config, not siblings like enabled.
    const entryWrapperMistake = {
      enabled: true,
      apiKey: "mcs_test_key_12345678",
      baseUrl: "http://localhost:8080",
      agentName: "openclaw-native",
      failMode: "closed",
    };

    expect(validatePluginConfig(entryWrapperMistake)).toBe(false);
  });
});
