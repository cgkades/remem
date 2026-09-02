import { describe, expect, it } from "vitest"
import { parseConfig } from "../src/config.js"

describe("parseConfig", () => {
  it("uses an inert workspace-local Markdown provider by default", () => {
    const parsed = parseConfig(undefined)

    expect(parsed.config.providers).toHaveLength(1)
    expect(parsed.config.providers[0]).toMatchObject({
      id: "workspace-memory",
      paths: [".remem/memory"],
      type: "markdown",
    })
    expect(parsed.config.debug).toBe(false)
    expect(parsed.config.capture.enabled).toBe(false)
  })

  it("disables unsupported providers without rejecting the plugin configuration", () => {
    const parsed = parseConfig({ providers: [{ type: "mem0", id: "remote" }] })

    expect(parsed.config.providers).toEqual([])
    expect(parsed.diagnostics[0]?.message).toContain("unsupported type")
  })

  it("accepts a PostgreSQL provider without exposing its connection in diagnostics", () => {
    const parsed = parseConfig({
      providers: [
        {
          type: "postgres",
          id: "remem-local",
          connectionString: "postgres://user:secret@127.0.0.1/remem",
          primary: true,
        },
      ],
    })

    expect(parsed.config.providers[0]).toMatchObject({
      type: "postgres",
      id: "remem-local",
      primary: true,
    })
    expect(JSON.stringify(parsed.diagnostics)).not.toContain("secret")
  })

  it("bounds unsafe budget and timeout values", () => {
    const parsed = parseConfig({
      providers: [],
      budgets: { catalogTokens: -1, recallTokens: 999_999 },
      providerTimeoutMs: 1,
    })

    expect(parsed.config.budgets.catalogTokens).toBe(200)
    expect(parsed.config.budgets.recallTokens).toBe(50_000)
    expect(parsed.config.providerTimeoutMs).toBe(50)
  })

  it("requires explicit capture enablement and bounds its queue and input limits", () => {
    const parsed = parseConfig({
      providers: [],
      capture: { enabled: true, queueLimit: 0, maxInputCharacters: 999_999 },
    })

    expect(parsed.config.capture).toMatchObject({
      enabled: true,
      queueLimit: 1,
      maxInputCharacters: 20_000,
    })
  })

  it("disables duplicate provider IDs deterministically", () => {
    const provider = { type: "markdown", id: "notes", paths: ["notes"] }
    const parsed = parseConfig({ providers: [provider, provider] })

    expect(parsed.config.providers).toHaveLength(1)
    expect(parsed.diagnostics[0]?.message).toContain("duplicate id")
  })

  it("fails closed for malformed provider lists and scopes", () => {
    const malformedList = parseConfig({ providers: "notes" })
    const malformedScope = parseConfig({
      providers: [{ type: "markdown", id: "notes", paths: ["notes"], scope: "everyone" }],
    })

    expect(malformedList.config.providers).toEqual([])
    expect(malformedList.diagnostics[0]?.message).toContain("must be an array")
    expect(malformedScope.config.providers).toEqual([])
    expect(malformedScope.diagnostics[0]?.message).toContain("invalid scope")
  })
})
