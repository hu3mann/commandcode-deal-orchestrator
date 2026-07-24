import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/live/**", "node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: [
        "src/router/**/*.ts",
        "src/pricing/**/*.ts",
        "src/config/**/*.ts",
        "src/security/**/*.ts",
        "src/classifier/**/*.ts",
      ],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 85,
        statements: 90,
      },
    },
  },
});
