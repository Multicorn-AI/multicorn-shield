import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    // Required for Lit decorators (@property, @state, @customElement)
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    passWithNoTests: true,
    include: ["src/**/*.{test,spec}.ts"],
    setupFiles: [],
    maxWorkers: 2,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.{test,spec}.ts",
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/extension/server.ts",
        "src/extension/child-manager.ts",
        "src/extension/json-rpc-child.ts",
        "src/extension/tool-router.ts",
        "src/proxy/__fixtures__/**",
        "src/extension/config-reader.ts",
        "src/badge/badge-entrypoint.ts",
        "src/extension/runtime.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 65,
        lines: 80,
      },
    },
  },
});
