import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    exclude: ["tests/live/**", "node_modules", "dist"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      thresholds: {
        lines: 90,
        // Defensive install/refresh custody paths leave residual branch gap on CI;
        // line coverage remains the hard §35 bar at 90%.
        branches: 84,
        functions: 85,
        statements: 90,
      },
    },
  },
});
