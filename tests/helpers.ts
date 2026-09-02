import { fileURLToPath } from "node:url"
import { parseConfig, type RememConfig } from "../src/config.js"
import type { MemoryContext } from "../src/types.js"

export const fixtureDirectory = fileURLToPath(new URL("./fixtures/memory", import.meta.url))

export const memoryContext: MemoryContext = {
  directory: fixtureDirectory,
  worktree: fixtureDirectory,
  projectId: "project-test",
  sessionId: "session-test",
}

export function testConfig(overrides: Partial<RememConfig> = {}): RememConfig {
  const base = parseConfig({ providers: [] }).config
  return {
    ...base,
    ...overrides,
    budgets: { ...base.budgets, ...overrides.budgets },
    planner: { ...base.planner, ...overrides.planner },
    capture: { ...base.capture, ...overrides.capture },
  }
}
