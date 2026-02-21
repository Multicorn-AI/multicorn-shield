import { defineConfig } from "tsup";

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
    banner: { js: "#!/usr/bin/env node" },
    noExternal: [],
  },
]);
