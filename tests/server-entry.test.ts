import { describe, expect, it } from "vitest"
import serverModule from "../src/server.js"

describe("OpenCode server entry", () => {
  it("exports the v1 plugin module shape expected by the OpenCode loader", () => {
    expect(serverModule.id).toBe("agentic-remem")
    expect(typeof serverModule.server).toBe("function")
  })
})
