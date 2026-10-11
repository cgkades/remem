import { describe, expect, it } from "vitest"
import { DeterministicRetrievalPlanner } from "../src/planner.js"
import type { CatalogEntry } from "../src/types.js"
const planner = new DeterministicRetrievalPlanner({ minimumConfidence: 0.42, maxTopics: 3 })
const entry = (title: string): CatalogEntry => ({
  id: title,
  title,
  aliases: [],
  summary: "",
  tags: [],
  providerIds: ["p"],
  scope: { kind: "global" },
  importance: 0.5,
  unresolved: false,
})
describe("explicit catalog recognition", () => {
  it("recognizes complete structured identifiers without relying on generic word overlap", () => {
    const plan = planner.plan(
      "resolved-test",
      [entry("Flaky timezone test [resolved-test]")],
      ["p"],
    )
    expect(plan.shouldRetrieve).toBe(true)
    expect(plan.matches[0]?.reasons).toContain("catalog structured identifier")
  })
  it("does not promote prefixes, suffixes, summaries or generic words to identifier evidence", () => {
    for (const prompt of ["INC-4102", "INC-410-extra", "test", "unknown-file"]) {
      const item = entry("Clock regression [INC-410]")
      item.summary = "unknown-file"
      expect(
        planner
          .plan(prompt, [item], ["p"])
          .matches.every((match) => !match.reasons.includes("catalog structured identifier")),
      ).toBe(true)
    }
  })
  it("retains both explicitly named topics while omitting incidental partial matches", () => {
    const items = [entry("Orchid billing"), entry("Orchid search"), entry("Orchid email")]
    expect(planner.plan("Orchid billing and Orchid search", items, ["p"]).topics).toEqual([
      "Orchid billing",
      "Orchid search",
    ])
  })
})
