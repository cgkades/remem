import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
    include: ["tests/**/*.test.ts"],
    exclude: ["**/*.eval.test.ts"],
    // Multiple *.integration.test.ts files share one external PostgreSQL
    // instance and each resets the `remem` schema in its own beforeAll;
    // running test files in parallel workers races those resets against
    // each other. The suite is small enough that sequential file execution
    // costs nothing meaningful.
    fileParallelism: false,
  },
})
