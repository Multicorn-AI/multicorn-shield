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
      exclude: ["src/**/*.{test,spec}.ts", "src/**/*.d.ts", "src/**/index.ts"],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
      // Higher threshold for consent module (≥90%)
      perFile: true,
    },
  },
});
