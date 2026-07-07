import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INIT_WIZARD_PLATFORM_REGISTRY } from "../config.js";

const REPO_ROOT = process.cwd();

const NATIVE_PLUGIN_IMPLEMENTATIONS: Readonly<Record<string, readonly string[]>> = {
  openclaw: ["src/openclaw/plugin/index.ts"],
  "claude-code": [
    "plugins/multicorn-shield/hooks/scripts/pre-tool-use.cjs",
    "plugins/multicorn-shield/hooks/scripts/post-tool-use.cjs",
  ],
  windsurf: [
    "plugins/windsurf/hooks/scripts/pre-action.cjs",
    "plugins/windsurf/hooks/scripts/post-action.cjs",
  ],
  cline: [
    "plugins/cline/hooks/scripts/pre-tool-use.cjs",
    "plugins/cline/hooks/scripts/post-tool-use.cjs",
  ],
  "gemini-cli": [
    "plugins/gemini-cli/hooks/scripts/before-tool.cjs",
    "plugins/gemini-cli/hooks/scripts/after-tool.cjs",
  ],
  opencode: ["plugins/opencode/multicorn-shield.ts"],
  "codex-cli": [
    "plugins/codex-cli/hooks/scripts/pre-tool-use.cjs",
    "plugins/codex-cli/hooks/scripts/post-tool-use.cjs",
  ],
};

const EXPECTED_NATIVE_SLUGS = [
  "openclaw",
  "claude-code",
  "windsurf",
  "cline",
  "gemini-cli",
  "opencode",
  "codex-cli",
] as const;

const HOSTED_ONLY_SLUGS = [
  "cursor",
  "claude-desktop",
  "github-copilot",
  "kilo-code",
  "continue-dev",
  "goose",
  "other-mcp",
] as const;

describe("INIT_WIZARD init picker", () => {
  it("lists exactly seven native platforms in the picker", async () => {
    const { INIT_WIZARD_PICKER_NATIVE_SLUGS, INIT_WIZARD_PICKER_SELECTION_MAX } =
      await import("../config.js");
    expect(INIT_WIZARD_PICKER_NATIVE_SLUGS).toEqual([...EXPECTED_NATIVE_SLUGS]);
    expect(INIT_WIZARD_PICKER_SELECTION_MAX).toBe(EXPECTED_NATIVE_SLUGS.length);
  });

  it("defaults hybrid init to native and accepts explicit hosted via flag", async () => {
    const { resolveInitHybridIntegrationMode } = await import("../config.js");
    expect(resolveInitHybridIntegrationMode(undefined)).toBe("native");
    expect(resolveInitHybridIntegrationMode("native")).toBe("native");
    expect(resolveInitHybridIntegrationMode("hosted")).toBe("hosted");
  });

  it("keeps hosted platforms in the full registry for programmatic handlers", () => {
    for (const slug of HOSTED_ONLY_SLUGS) {
      expect(INIT_WIZARD_PLATFORM_REGISTRY.some((e) => e.slug === slug)).toBe(true);
    }
  });

  it("maps native slugs to picker indices separate from registry indices for hosted slugs", async () => {
    const { initWizardPickerSelectionNumberForSlug, initWizardSelectionNumberForSlug } =
      await import("../config.js");
    expect(initWizardPickerSelectionNumberForSlug("openclaw")).toBe(1);
    expect(initWizardSelectionNumberForSlug("openclaw")).toBe(1);
    expect(initWizardSelectionNumberForSlug("cursor")).toBe(8);
    expect(() => initWizardPickerSelectionNumberForSlug("cursor")).toThrow(
      /not in the init picker/,
    );
  });
});
describe("INIT_WIZARD_PLATFORM_REGISTRY native section", () => {
  it("lists exactly the seven native-capable platforms", () => {
    const nativeSlugs = INIT_WIZARD_PLATFORM_REGISTRY.filter((e) => e.section === "native").map(
      (e) => e.slug,
    );
    expect(nativeSlugs).toEqual([...EXPECTED_NATIVE_SLUGS]);
  });

  it("keeps hosted-only slugs out of the native section", () => {
    const nativeSlugs = new Set(
      INIT_WIZARD_PLATFORM_REGISTRY.filter((e) => e.section === "native").map((e) => e.slug),
    );
    for (const slug of HOSTED_ONLY_SLUGS) {
      expect(nativeSlugs.has(slug)).toBe(false);
    }
  });

  it("maps every native-section slug to an on-disk plugin implementation", () => {
    for (const slug of EXPECTED_NATIVE_SLUGS) {
      const paths = NATIVE_PLUGIN_IMPLEMENTATIONS[slug];
      expect(paths, `missing plugin map for ${slug}`).toBeDefined();
      for (const rel of paths ?? []) {
        expect(existsSync(join(REPO_ROOT, rel)), `${slug} plugin missing at ${rel}`).toBe(true);
      }
    }
  });
});
