import { defineConfig } from "vitest/config"

// Separate config for the opt-in eval tier (tests/**/*.eval.test.ts). These
// tests may download a real ~30MB neural embedding model and hit the
// network, so they are excluded from the default `vitest.config.ts`
// (and therefore from `npm test` / `npm run check`) and only run via
// `npm run test:eval`.
export default defineConfig({
  test: {
    include: ["tests/**/*.eval.test.ts"],
  },
})
