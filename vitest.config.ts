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
    coverage: {
      provider: "istanbul",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.{test,spec}.ts",
        "src/**/*.d.ts",
        "src/**/index.ts",
        // MCP stdio entry: exercised via packaged extension / manual runs, not unit tests.
        "src/extension/server.ts",
        // Test-only harnesses; coverage is not meaningful here.
        "src/proxy/__fixtures__/**",
        // Extension subprocess + MCP wiring: covered by integration tests, not Istanbul branches.
        "src/extension/child-manager.ts",
        "src/extension/config-reader.ts",
        "src/extension/json-rpc-child.ts",
        "src/extension/runtime.ts",
        "src/extension/tool-router.ts",
      ],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
        perFile: true,
      },
    },
  },
});
