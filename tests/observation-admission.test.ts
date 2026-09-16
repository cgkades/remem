import { describe, expect, it } from "vitest"
import {
  DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  admitEvidence,
  summarizeRejections,
  type AdmissionAuthority,
  type EvidenceAdmissionConfig,
  type RawEvidenceCandidate,
} from "../src/observation-admission.js"
import type { MemoryContext } from "../src/types.js"

const context: MemoryContext = {
  directory: "/workspace/phoenix",
  worktree: "/workspace/phoenix",
  projectId: "project-test",
  sessionId: "session-test",
}

const authority: AdmissionAuthority = {
  providerId: "postgres-a",
  host: "opencode-v2",
  projectId: "project-test",
}

const enabledConfig: EvidenceAdmissionConfig = {
  ...DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  enabled: true,
}

type CandidateOverrides = Partial<Omit<RawEvidenceCandidate, "turnId" | "messageId">> & {
  turnId?: string | undefined
  messageId?: string | undefined
}

function baseCandidate(overrides: CandidateOverrides = {}): RawEvidenceCandidate {
  const merged: Record<string, unknown> = {
    providerId: "postgres-a",
    host: "opencode-v2",
    context,
    turnId: "turn-1",
    messageId: "message-1",
    role: "user",
    origin: "direct-user",
    kind: "turn-completed",
    occurredAt: "2026-09-16T00:00:00.000Z",
    payload: { text: "We decided to use logical replication for Orion." },
    ...overrides,
  }
  // exactOptionalPropertyTypes distinguishes "key omitted" from "key present
  // with value undefined"; tests intentionally use the latter (e.g.
  // `{ turnId: undefined }`) to mean "no turnId at all", so normalize that
  // here for just those two fields rather than fighting the type checker at
  // every call site, without loosening the rest of the candidate's typing.
  if (merged.turnId === undefined) delete merged.turnId
  if (merged.messageId === undefined) delete merged.messageId
  return merged as unknown as RawEvidenceCandidate
}

describe("admitEvidence", () => {
  it("admits a well-formed candidate with the enabled default config", () => {
    const result = admitEvidence(baseCandidate(), authority, enabledConfig)

    expect(result.outcome).toBe("admitted")
    if (result.outcome !== "admitted") return
    expect(result.envelope).toMatchObject({
      schemaVersion: 1,
      providerId: "postgres-a",
      host: "opencode-v2",
      role: "user",
      origin: "direct-user",
      kind: "turn-completed",
    })
    expect(result.envelope.id).toEqual(expect.any(String))
    expect(result.envelope.contentHash).toEqual(expect.any(String))
    // Safe evidence must be admissible even if it yields no semantic
    // candidates: admission never inspects/requires a classifier result.
  })

  it("rejects everything when the feature is disabled, regardless of shape validity", () => {
    const result = admitEvidence(baseCandidate(), authority, DEFAULT_EVIDENCE_ADMISSION_CONFIG)

    expect(result).toMatchObject({ outcome: "rejected", reason: "disabled" })
  })

  describe("malformed identity fields", () => {
    it("rejects a NUL-containing identity field", () => {
      const result = admitEvidence(
        baseCandidate({ turnId: "turn-\u0000-1" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "invalid-identity-field" })
    })

    it("rejects an identity field longer than 256 UTF-16 code units", () => {
      const result = admitEvidence(
        baseCandidate({ turnId: "t".repeat(257) }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "invalid-identity-field" })
    })

    it("accepts an identity field at exactly the 256 code unit bound", () => {
      const result = admitEvidence(
        baseCandidate({ turnId: "t".repeat(256) }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
    })

    it("rejects an empty providerId", () => {
      const result = admitEvidence(baseCandidate({ providerId: "" }), authority, enabledConfig)

      expect(result).toMatchObject({ outcome: "rejected", reason: "invalid-identity-field" })
    })

    it("rejects a NUL-containing evidenceRefs entry", () => {
      const result = admitEvidence(
        baseCandidate({
          evidenceRefs: [{ providerId: "postgres-a", eventId: "evt-\u0000-1" }],
        }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "invalid-identity-field" })
    })

    it("rejects an evidenceRefs entry with an invalid (empty) providerId, not just an invalid eventId", () => {
      const result = admitEvidence(
        baseCandidate({
          evidenceRefs: [{ providerId: "", eventId: "evt-1" }],
        }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "invalid-identity-field" })
    })
  })

  describe("unsupported identity", () => {
    it("rejects a non-lifecycle event with neither turnId nor messageId", () => {
      const result = admitEvidence(
        baseCandidate({ turnId: undefined, messageId: undefined }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "unsupported-identity" })
    })

    it("admits a lifecycle event with neither turnId nor messageId", () => {
      const result = admitEvidence(
        baseCandidate({
          kind: "lifecycle",
          turnId: undefined,
          messageId: undefined,
          payload: {},
        }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
    })

    it("admits a non-lifecycle event with only turnId (no messageId)", () => {
      const result = admitEvidence(
        baseCandidate({ messageId: undefined }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
    })
  })

  describe("foreign scope", () => {
    it("rejects a candidate claiming a foreign project", () => {
      const result = admitEvidence(
        baseCandidate({ context: { ...context, projectId: "other-project" } }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "foreign-scope" })
    })

    it("rejects a candidate claiming a foreign provider", () => {
      const result = admitEvidence(
        baseCandidate({ providerId: "postgres-b" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "foreign-scope" })
    })

    it("rejects a candidate claiming a foreign host", () => {
      const result = admitEvidence(baseCandidate({ host: "pi" }), authority, enabledConfig)

      expect(result).toMatchObject({ outcome: "rejected", reason: "foreign-scope" })
    })

    it("rejects an evidenceRefs entry pointing at a foreign provider", () => {
      const result = admitEvidence(
        baseCandidate({
          evidenceRefs: [{ providerId: "postgres-b", eventId: "evt-1" }],
        }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "foreign-scope" })
    })

    it("admits an evidenceRefs entry pointing at the same (authorized) provider", () => {
      const result = admitEvidence(
        baseCandidate({
          evidenceRefs: [{ providerId: "postgres-a", eventId: "evt-1" }],
        }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
    })
  })

  describe("origin enablement", () => {
    it("rejects an unknown origin by default", () => {
      const result = admitEvidence(
        baseCandidate({ role: "system", origin: "unknown" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "origin-not-enabled" })
    })

    it("rejects a retrieved origin by default", () => {
      const result = admitEvidence(
        baseCandidate({ role: "system", origin: "retrieved" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "origin-not-enabled" })
    })

    it("rejects an extension origin by default", () => {
      const result = admitEvidence(
        baseCandidate({ role: "system", origin: "extension" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "origin-not-enabled" })
    })

    it("admits a host-observed assistant event by default (approved 2026-09-10: captured together with direct-user)", () => {
      const result = admitEvidence(
        baseCandidate({ role: "assistant", origin: "host-observed" }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
    })

    it("admits a host-observed tool event by default", () => {
      const result = admitEvidence(
        baseCandidate({
          role: "tool",
          origin: "host-observed",
          kind: "tool-result",
          payload: { metadata: { exitCode: 0 } },
        }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
    })

    it("respects a narrower configured enabledOrigins list (disabled sources)", () => {
      const userOnlyConfig: EvidenceAdmissionConfig = {
        ...enabledConfig,
        enabledOrigins: ["direct-user"],
      }
      const result = admitEvidence(
        baseCandidate({ role: "assistant", origin: "host-observed" }),
        authority,
        userOnlyConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "origin-not-enabled" })
    })

    it("does not grant retrieved/repeated text elevated trust just because an assistant repeats it (no implicit trust elevation)", () => {
      // A retrieved-looking snippet that an assistant repeats verbatim is
      // still just an ordinary host-observed assistant event: admission
      // does not detect or special-case content overlap with anything
      // else, and must not silently upgrade its origin/role.
      const result = admitEvidence(
        baseCandidate({
          role: "assistant",
          origin: "host-observed",
          payload: { text: "As retrieved earlier: Orion uses PostgreSQL for durable memory." },
        }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
      if (result.outcome !== "admitted") return
      expect(result.envelope.role).toBe("assistant")
      expect(result.envelope.origin).toBe("host-observed")
    })
  })

  describe("nested credentials", () => {
    it("rejects a credential in payload.text", () => {
      const result = admitEvidence(
        baseCandidate({ payload: { text: "the api_key=1234567890abcdef1234567890abcdef value" } }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "unscreenable-content" })
    })

    it("rejects a credential nested inside payload.metadata", () => {
      const result = admitEvidence(
        baseCandidate({
          payload: {
            metadata: {
              tool: "deploy",
              output: { logs: ["connecting...", "api_key=1234567890abcdef1234567890abcdef"] },
            },
          },
        }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "unscreenable-content" })
    })

    it("rejects a credential nested inside a metadata array", () => {
      const result = admitEvidence(
        baseCandidate({
          payload: {
            metadata: {
              entries: [{ note: "fine" }, { note: "Bearer abcdefghijklmnopqrstuvwxyz123456" }],
            },
          },
        }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "unscreenable-content" })
    })

    it("admits payload metadata with no credential-shaped content", () => {
      const result = admitEvidence(
        baseCandidate({
          payload: { metadata: { exitCode: 0, files: ["src/foo.ts", "src/bar.ts"] } },
        }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
    })
  })

  describe("recursive/oversized payloads", () => {
    it("rejects a payload exceeding maxPayloadBytes", () => {
      const result = admitEvidence(
        baseCandidate({ payload: { text: "x".repeat(9_000) } }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "payload-too-large" })
    })

    it("rejects a pathologically deep metadata object before scanning stalls", () => {
      let deep: Record<string, unknown> = { leaf: "fine" }
      for (let level = 0; level < 50; level++) deep = { nested: deep }
      // Symmetry with the "wide" test below: confirm this exercises the
      // depth bound specifically, not the byte-size check.
      expect(Buffer.byteLength(JSON.stringify({ metadata: deep }), "utf8")).toBeLessThan(
        enabledConfig.maxPayloadBytes,
      )

      const result = admitEvidence(
        baseCandidate({ payload: { metadata: deep } }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "payload-too-complex" })
    })

    it("rejects a pathologically wide metadata object before scanning stalls", () => {
      // Stays well under maxPayloadBytes (8 KiB) so this specifically
      // exercises the scan-value-count bound, not the byte-size check.
      const wide: Record<string, string> = {}
      for (let index = 0; index < 600; index++) wide[`k${index}`] = "y"
      expect(Buffer.byteLength(JSON.stringify({ metadata: wide }), "utf8")).toBeLessThan(
        enabledConfig.maxPayloadBytes,
      )

      const result = admitEvidence(
        baseCandidate({ payload: { metadata: wide } }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "payload-too-complex" })
    })

    it("admits a reasonably small/shallow metadata object", () => {
      const result = admitEvidence(
        baseCandidate({
          payload: { metadata: { exitCode: 1, output: { stderr: "not found" } } },
        }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
    })
  })

  describe("malformed envelope shape", () => {
    it("rejects an unrecognized role", () => {
      const result = admitEvidence(
        // @ts-expect-error -- intentionally malformed input for the test
        baseCandidate({ role: "narrator" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "malformed-envelope" })
    })

    it("rejects an unrecognized kind", () => {
      const result = admitEvidence(
        // @ts-expect-error -- intentionally malformed input for the test
        baseCandidate({ kind: "semantic-fact" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "malformed-envelope" })
    })

    it("rejects an unparseable occurredAt", () => {
      const result = admitEvidence(
        baseCandidate({ occurredAt: "not-a-date" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "malformed-envelope" })
    })
  })

  describe("evidenceRefs bounds", () => {
    it("rejects more evidenceRefs than the configured limit", () => {
      const tooMany = Array.from({ length: 17 }, (_, index) => ({
        providerId: "postgres-a",
        eventId: `evt-${index}`,
      }))
      const result = admitEvidence(
        baseCandidate({ evidenceRefs: tooMany }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "too-many-evidence-refs" })
    })

    it("admits exactly the configured limit of evidenceRefs", () => {
      const exactly16 = Array.from({ length: 16 }, (_, index) => ({
        providerId: "postgres-a",
        eventId: `evt-${index}`,
      }))
      const result = admitEvidence(
        baseCandidate({ evidenceRefs: exactly16 }),
        authority,
        enabledConfig,
      )

      expect(result.outcome).toBe("admitted")
    })
  })

  describe("identity collisions", () => {
    it("treats the exact same identity and content as an idempotent duplicate, not a fresh admission", () => {
      const candidate = baseCandidate()
      const first = admitEvidence(candidate, authority, enabledConfig)
      expect(first.outcome).toBe("admitted")
      if (first.outcome !== "admitted") return

      const replay = admitEvidence(candidate, authority, enabledConfig, {
        contentHash: first.envelope.contentHash,
      })

      expect(replay).toMatchObject({ outcome: "duplicate", id: first.envelope.id })
    })

    it("rejects the same identity with different content as a collision, not an upsert", () => {
      const candidate = baseCandidate()
      const first = admitEvidence(candidate, authority, enabledConfig)
      expect(first.outcome).toBe("admitted")
      if (first.outcome !== "admitted") return

      const changed = admitEvidence(
        baseCandidate({ payload: { text: "A completely different statement." } }),
        authority,
        enabledConfig,
        { contentHash: first.envelope.contentHash },
      )

      expect(changed).toMatchObject({ outcome: "rejected", reason: "identity-collision" })
    })

    it("does not deduplicate by prompt/text content -- two different turns with the same text are distinct identities", () => {
      const first = admitEvidence(baseCandidate({ turnId: "turn-1" }), authority, enabledConfig)
      const second = admitEvidence(baseCandidate({ turnId: "turn-2" }), authority, enabledConfig)

      expect(first.outcome).toBe("admitted")
      expect(second.outcome).toBe("admitted")
      if (first.outcome !== "admitted" || second.outcome !== "admitted") return
      expect(first.envelope.id).not.toBe(second.envelope.id)
    })
  })

  describe("adversarial/malformed shapes never throw", () => {
    // RawEvidenceCandidate crosses a genuine trust boundary: at runtime a
    // host-adapter bug or adversarial input can produce a shape TypeScript's
    // compile-time type does not guarantee. Every case here uses `as
    // RawEvidenceCandidate` to intentionally bypass the type checker, the
    // same way a real untrusted caller would arrive at this function with
    // no compile-time enforcement at all.

    it("rejects rather than throws on a null identity field", () => {
      const malformed = { ...baseCandidate(), providerId: null } as unknown as RawEvidenceCandidate
      expect(() => admitEvidence(malformed, authority, enabledConfig)).not.toThrow()
      expect(admitEvidence(malformed, authority, enabledConfig).outcome).toBe("rejected")
    })

    it("rejects rather than throws on a numeric identity field", () => {
      const malformed = { ...baseCandidate(), host: 12345 } as unknown as RawEvidenceCandidate
      expect(() => admitEvidence(malformed, authority, enabledConfig)).not.toThrow()
      expect(admitEvidence(malformed, authority, enabledConfig).outcome).toBe("rejected")
    })

    it("rejects rather than throws on a null context", () => {
      const malformed = { ...baseCandidate(), context: null } as unknown as RawEvidenceCandidate
      expect(() => admitEvidence(malformed, authority, enabledConfig)).not.toThrow()
      expect(admitEvidence(malformed, authority, enabledConfig).outcome).toBe("rejected")
    })

    it("rejects rather than throws on an undefined context", () => {
      const malformed = {
        ...baseCandidate(),
        context: undefined,
      } as unknown as RawEvidenceCandidate
      expect(() => admitEvidence(malformed, authority, enabledConfig)).not.toThrow()
      expect(admitEvidence(malformed, authority, enabledConfig).outcome).toBe("rejected")
    })

    it("rejects rather than throws on a null payload", () => {
      const malformed = { ...baseCandidate(), payload: null } as unknown as RawEvidenceCandidate
      expect(() => admitEvidence(malformed, authority, enabledConfig)).not.toThrow()
      expect(admitEvidence(malformed, authority, enabledConfig).outcome).toBe("rejected")
    })

    it("rejects rather than throws on a non-array evidenceRefs", () => {
      const malformed = {
        ...baseCandidate(),
        evidenceRefs: { not: "an array" },
      } as unknown as RawEvidenceCandidate
      expect(() => admitEvidence(malformed, authority, enabledConfig)).not.toThrow()
      expect(admitEvidence(malformed, authority, enabledConfig)).toMatchObject({
        outcome: "rejected",
        reason: "malformed-envelope",
      })
    })

    it("rejects rather than throws on a null entry inside evidenceRefs", () => {
      const malformed = {
        ...baseCandidate(),
        evidenceRefs: [null],
      } as unknown as RawEvidenceCandidate
      expect(() => admitEvidence(malformed, authority, enabledConfig)).not.toThrow()
      expect(admitEvidence(malformed, authority, enabledConfig)).toMatchObject({
        outcome: "rejected",
        reason: "invalid-identity-field",
      })
    })

    it("rejects rather than throws on a circular payload.metadata object", () => {
      const cyclic: Record<string, unknown> = { note: "fine" }
      cyclic.self = cyclic
      const malformed = baseCandidate({ payload: { metadata: cyclic } })
      expect(() => admitEvidence(malformed, authority, enabledConfig)).not.toThrow()
      expect(admitEvidence(malformed, authority, enabledConfig)).toMatchObject({
        outcome: "rejected",
        reason: "malformed-envelope",
      })
    })

    it("does not persist a Map value silently past credential screening -- it is dropped by canonicalization, not smuggled through", () => {
      // payload.metadata is typed Record<string, unknown>, but nothing at
      // runtime prevents a host adapter from populating it with a live Map
      // instance. Canonicalization (a JSON round-trip) empties it uniformly
      // for both the credential scan and the persisted envelope, so the
      // same content that was scanned is also what is stored -- no bypass,
      // even though the Map's original entries are lost rather than
      // screened individually.
      const withMap = baseCandidate({
        payload: {
          metadata: { wrapped: new Map([["token", "api_key=1234567890abcdef1234567890abcdef"]]) },
        },
      })
      const result = admitEvidence(withMap, authority, enabledConfig)
      expect(result.outcome).toBe("admitted")
      if (result.outcome !== "admitted") return
      expect(JSON.stringify(result.envelope.payload)).not.toContain("sk_live")
    })
  })

  describe("credentials in identity-like fields (not just payload)", () => {
    it("rejects a credential-shaped context.sessionId", () => {
      const result = admitEvidence(
        baseCandidate({
          context: { ...context, sessionId: "api_key=1234567890abcdef1234567890abcdef" },
        }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "unscreenable-content" })
    })

    it("rejects a credential-shaped turnId", () => {
      const result = admitEvidence(
        baseCandidate({ turnId: "Bearer abcdefghijklmnopqrstuvwxyz123456" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "unscreenable-content" })
    })

    it("rejects a credential-shaped messageId", () => {
      const result = admitEvidence(
        baseCandidate({ messageId: "api_key=1234567890abcdef1234567890abcdef" }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "unscreenable-content" })
    })

    it("rejects a credential-shaped evidenceRefs eventId", () => {
      const result = admitEvidence(
        baseCandidate({
          evidenceRefs: [
            { providerId: "postgres-a", eventId: "api_key=1234567890abcdef1234567890abcdef" },
          ],
        }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "unscreenable-content" })
    })
  })

  describe("rejection detail never leaks content", () => {
    it("does not include the injected secret in the unscreenable-content detail", () => {
      const secret = "api_key=1234567890abcdef1234567890abcdef"
      const result = admitEvidence(
        baseCandidate({ payload: { text: `leaked: ${secret}` } }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "unscreenable-content" })
      if (result.outcome !== "rejected") return
      expect(result.detail).not.toContain(secret)
    })

    it("does not include the oversized payload text in the payload-too-large detail", () => {
      const hugeText = "x".repeat(9_000)
      const result = admitEvidence(
        baseCandidate({ payload: { text: hugeText } }),
        authority,
        enabledConfig,
      )

      expect(result).toMatchObject({ outcome: "rejected", reason: "payload-too-large" })
      if (result.outcome !== "rejected") return
      expect(result.detail).not.toContain(hugeText)
      expect(result.detail.length).toBeLessThan(200)
    })
  })

  describe("storage-safety of derived id/contentHash", () => {
    it("never embeds a NUL byte in the derived id or contentHash, despite NUL being used as an internal namespace separator", () => {
      const result = admitEvidence(baseCandidate(), authority, enabledConfig)
      expect(result.outcome).toBe("admitted")
      if (result.outcome !== "admitted") return

      expect(result.envelope.id).not.toContain("\u0000")
      expect(result.envelope.contentHash).not.toContain("\u0000")
      // A hex digest: safe for a future PostgreSQL text column (Phase 3).
      expect(result.envelope.id).toMatch(/^[0-9a-f]+$/u)
      expect(result.envelope.contentHash).toMatch(/^[0-9a-f]+$/u)
    })
  })

  describe("enabledOrigins widening (positive direction)", () => {
    it("admits a retrieved-origin event once explicitly widened into enabledOrigins", () => {
      const widenedConfig: EvidenceAdmissionConfig = {
        ...enabledConfig,
        enabledOrigins: [...enabledConfig.enabledOrigins, "retrieved"],
      }
      const result = admitEvidence(
        baseCandidate({ role: "system", origin: "retrieved" }),
        authority,
        widenedConfig,
      )

      expect(result.outcome).toBe("admitted")
    })
  })

  describe("hash determinism regardless of metadata key insertion order", () => {
    it("produces the same contentHash for logically-identical metadata built with different key order", () => {
      const first = admitEvidence(
        baseCandidate({ payload: { metadata: { a: 1, b: 2 } } }),
        authority,
        enabledConfig,
      )
      const second = admitEvidence(
        baseCandidate({ payload: { metadata: { b: 2, a: 1 } } }),
        authority,
        enabledConfig,
      )

      expect(first.outcome).toBe("admitted")
      expect(second.outcome).toBe("admitted")
      if (first.outcome !== "admitted" || second.outcome !== "admitted") return
      expect(first.envelope.contentHash).toBe(second.envelope.contentHash)
    })
  })
})

describe("summarizeRejections", () => {
  it("aggregates rejection reasons into bounded reason-code/count diagnostics, never content", () => {
    const results = [
      admitEvidence(
        baseCandidate({ turnId: undefined, messageId: undefined }),
        authority,
        enabledConfig,
      ),
      admitEvidence(
        baseCandidate({ turnId: undefined, messageId: undefined }),
        authority,
        enabledConfig,
      ),
      admitEvidence(
        baseCandidate({ payload: { text: "api_key=abcdefghijklmnopqrstuvwxyz123456" } }),
        authority,
        enabledConfig,
      ),
      admitEvidence(baseCandidate(), authority, enabledConfig),
    ]

    const summary = summarizeRejections(results)

    expect(summary).toEqual({ "unsupported-identity": 2, "unscreenable-content": 1 })
    // Never the rejected content itself.
    expect(JSON.stringify(summary)).not.toContain("api_key")
  })

  it("returns an empty summary when nothing was rejected", () => {
    const results = [admitEvidence(baseCandidate(), authority, enabledConfig)]

    expect(summarizeRejections(results)).toEqual({})
  })
})
