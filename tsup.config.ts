import { defineConfig } from "tsup";
import { copyFileSync, mkdirSync } from "node:fs";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    splitting: true,
    sourcemap: false,
    clean: true,
    treeshake: true,
    minify: false,
    outDir: "dist",
  },
  {
    entry: { "multicorn-proxy": "bin/multicorn-proxy.ts" },
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "dist",
    noExternal: [],
  },
  {
    entry: { "openclaw-hook/handler": "src/openclaw/hook/handler.ts" },
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "dist",
    banner: {
      js: "// Multicorn Shield hook for OpenClaw (DEPRECATED - use the plugin instead) - https://multicorn.ai",
    },
    onSuccess: async () => {
      mkdirSync("dist/openclaw-hook", { recursive: true });
      copyFileSync("src/openclaw/hook/HOOK.md", "dist/openclaw-hook/HOOK.md");
    },
  },
  {
    entry: { "openclaw-plugin/multicorn-shield": "src/openclaw/plugin/index.ts" },
    format: ["esm"],
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    treeshake: true,
    minify: false,
    outDir: "dist",
    banner: {
      js: "// Multicorn Shield plugin for OpenClaw - https://multicorn.ai",
    },
    onSuccess: async () => {
      mkdirSync("dist/openclaw-plugin", { recursive: true });
      copyFileSync(
        "src/openclaw/plugin/openclaw.plugin.json",
        "dist/openclaw-plugin/openclaw.plugin.json",
      );
    },
  },
]);
