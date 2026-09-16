/**
 * Phase 2 (TASK-007/008/009) of `plan/feature-memory-recovery-1.md`: a
 * host-neutral, normalized evidence envelope and pure admission function,
 * additive to the legacy `SessionObservation`/`CaptureCoordinator` path in
 * `observation.ts`/`capture.ts` -- not a replacement. This module holds pure
 * validation/redaction only: no host SDK, no database, and no wall-clock
 * (`Date.now()`) calls, so every result here is a deterministic function of
 * its inputs and independently testable without a live host or store.
 * `node:crypto`'s `createHash` is used for deterministic hashing (the same
 * established pattern as `capture.ts`'s `stableId`); it performs no I/O.
 *
 * Scope boundary: this module decides whether one candidate event may be
 * *admitted* as raw evidence at all. It does not decide whether admitted
 * evidence becomes a trusted semantic fact -- that is Phase 6's separate,
 * still-partially-gated four-outcome policy (see
 * plan/feature-memory-recovery-1.md's approved fact-promotion boundary).
 * Persisting admitted evidence (Phase 3) and wiring real host callbacks into
 * this function (Phase 5) are both out of scope here; nothing in this
 * module reads or writes `remem.session_events` or any other store.
 *
 * Trust boundary note: `RawEvidenceCandidate` is typed as
 * `RawEvidenceCandidate` for caller convenience, but at runtime it crosses a
 * genuine trust boundary (host-adapter-constructed, potentially reflecting
 * adversarial tool output or a host bug) where TypeScript's compile-time
 * types provide no guarantee. Every check below treats candidate fields
 * defensively (explicit `typeof`/`Array.isArray` guards, not just
 * `!== undefined`), and `admitEvidence` additionally wraps its entire body in
 * a catch-all so a shape or host bug no individual check anticipated still
 * cannot violate the documented "never throws" contract.
 */
import { createHash } from "node:crypto"
import { containsSensitiveCredential } from "./sensitive-data.js"
import type { MemoryContext } from "./types.js"

/** Transport/source classification assigned by the host adapter, not self-reported by event content. */
export type EvidenceRole = "user" | "assistant" | "tool" | "system"

/**
 * Origin classification, distinct from `role`: a direct user message can
 * still contain third-party/retrieved claims, so `role` alone never grants
 * an event's entire content original-user authority (SEC-002).
 */
export type EvidenceOrigin = "direct-user" | "host-observed" | "retrieved" | "extension" | "unknown"

/**
 * Raw event categories only -- these describe *what kind of thing happened*,
 * not a semantic label like "decision"/"fact" (that remains Phase 6's job,
 * applied after admission, never before it).
 */
export type EvidenceEventKind = "turn-completed" | "tool-result" | "lifecycle"

export const EVIDENCE_SCHEMA_VERSION = 1

/** The canonical, exhaustive list of `EvidenceRole` values -- exported so consumers (e.g. config parsing) validate against one source of truth rather than hand-duplicating this union. */
export const EVIDENCE_ROLES: readonly EvidenceRole[] = ["user", "assistant", "tool", "system"]

/** The canonical, exhaustive list of `EvidenceOrigin` values -- see `EVIDENCE_ROLES`. */
export const EVIDENCE_ORIGINS: readonly EvidenceOrigin[] = [
  "direct-user",
  "host-observed",
  "retrieved",
  "extension",
  "unknown",
]

/** The canonical, exhaustive list of `EvidenceEventKind` values -- see `EVIDENCE_ROLES`. */
export const EVIDENCE_KINDS: readonly EvidenceEventKind[] = [
  "turn-completed",
  "tool-result",
  "lifecycle",
]

/** At most `maxEvidenceRefs` per envelope; each must share the admitting authority's own provider scope. */
export interface EvidenceReference {
  providerId: string
  eventId: string
}

export interface EvidencePayload {
  /** Allowlisted, bounded safe text. Absent for e.g. a pure lifecycle event. */
  text?: string
  /** Structured tool-result metadata -- no arbitrary nested host object serialization beyond the bounds below. */
  metadata?: Record<string, unknown>
}

/**
 * The normalized, versioned envelope produced by a *successful* admission.
 * Every field here is validated/derived by `admitEvidence`; none of it is
 * trusted verbatim from the raw candidate (see `RawEvidenceCandidate`).
 */
export interface EvidenceEnvelope {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION
  /** Derived, namespaced identity (provider/host/project/session/turn/message) -- never the raw candidate's own claimed `id`, so source data cannot select another provider or project by supplying an arbitrary id. A hex digest: storage-safe (no embedded NUL/control bytes) for a future PostgreSQL `text` column. */
  id: string
  providerId: string
  host: string
  context: MemoryContext
  turnId?: string
  messageId?: string
  role: EvidenceRole
  origin: EvidenceOrigin
  kind: EvidenceEventKind
  /** Source-reported event time; never perturbed by a separate server-ingestion timestamp. */
  occurredAt: string
  /** The canonicalized (deep-cloned, key-order-sorted, JSON-plain) payload -- see `canonicalizePayload`. Never the raw candidate's own payload reference. */
  payload: EvidencePayload
  evidenceRefs: EvidenceReference[]
  /** Deterministic hash of the canonical sanitized evidence; excludes ingestion time and any later classifier result. A hex digest, storage-safe. */
  contentHash: string
}

/**
 * The untrusted shape a host adapter would construct before admission. Every
 * field is unchecked input: `admitEvidence` is exactly the boundary that
 * turns this into a validated `EvidenceEnvelope` or a structured rejection.
 * The declared type is for caller convenience; `admitEvidence` does not
 * actually trust it at runtime (see the module doc comment's trust-boundary
 * note).
 */
export interface RawEvidenceCandidate {
  providerId: string
  host: string
  context: MemoryContext
  turnId?: string
  messageId?: string
  role: EvidenceRole
  origin: EvidenceOrigin
  kind: EvidenceEventKind
  occurredAt: string
  payload: EvidencePayload
  evidenceRefs?: EvidenceReference[]
}

/**
 * The provider/host/project this specific admission call is being performed
 * for -- supplied by the caller (the actual configured store/session), never
 * read from the raw candidate. A candidate claiming a different provider or
 * project is rejected as `foreign-scope`, so untrusted source data cannot
 * select another provider or project merely by claiming to be one.
 */
export interface AdmissionAuthority {
  providerId: string
  host: string
  projectId: string
}

export interface EvidenceAdmissionConfig {
  /** New evidence capture is disabled until explicitly configured -- this is a development profile, not a shipped default. */
  enabled: boolean
  /**
   * Origins admitted when `enabled`. Approved 2026-09-10: `direct-user` and
   * `host-observed` are captured together from the start; `retrieved`,
   * `extension`, and `unknown` remain defined by the type system for future
   * phases but are not in the default enabled set -- admitting them requires
   * a separate, later reviewed decision, not a config toggle alone.
   */
  enabledOrigins: EvidenceOrigin[]
  /** Maximum serialized (UTF-8 byte) size of the canonicalized `payload`. */
  maxPayloadBytes: number
  /** Maximum entries in `evidenceRefs`. */
  maxEvidenceRefs: number
  /** Maximum events a caller may queue before this admission boundary; enforced by the caller's own queue, not by this stateless function. */
  maxQueuedEvents: number
}

export const DEFAULT_EVIDENCE_ADMISSION_CONFIG: EvidenceAdmissionConfig = {
  enabled: false,
  enabledOrigins: ["direct-user", "host-observed"],
  maxPayloadBytes: 8 * 1024,
  maxEvidenceRefs: 16,
  maxQueuedEvents: 32,
}

/** Bound shared by every identity-like field (`providerId`, `host`, `turnId`, `messageId`, and `context`'s own string fields). */
export const IDENTITY_FIELD_MAX_LENGTH = 256

/** Bounds on recursive payload-metadata screening, independent of `maxPayloadBytes`: protects against a pathologically deep/wide object stalling the scan before the byte-size check alone would catch it. The root `metadata` object itself is depth 0, so `PAYLOAD_MAX_SCAN_DEPTH` actually permits `PAYLOAD_MAX_SCAN_DEPTH + 1` levels (0 through the bound, inclusive) before rejecting. */
const PAYLOAD_MAX_SCAN_DEPTH = 6
const PAYLOAD_MAX_SCAN_VALUES = 500

export type AdmissionRejectionReason =
  | "disabled"
  | "malformed-envelope"
  | "invalid-identity-field"
  | "unsupported-identity"
  | "foreign-scope"
  | "origin-not-enabled"
  | "too-many-evidence-refs"
  | "payload-too-large"
  | "payload-too-complex"
  | "unscreenable-content"
  | "identity-collision"

export interface AdmissionRejection {
  outcome: "rejected"
  reason: AdmissionRejectionReason
  /** A bounded, safe description -- never the rejected content itself. */
  detail: string
}

export interface AdmissionDuplicate {
  /** Same identity, same content: an idempotent no-op, not a fresh admission and not a rejection. */
  outcome: "duplicate"
  id: string
}

export interface AdmissionAccepted {
  outcome: "admitted"
  envelope: EvidenceEnvelope
}

export type AdmissionResult = AdmissionAccepted | AdmissionDuplicate | AdmissionRejection

/** An already-admitted record's identity/hash, supplied by the caller's store so this pure function can detect a collision without performing any I/O itself. */
export interface ExistingEvidenceRecord {
  contentHash: string
}

function rejected(reason: AdmissionRejectionReason, detail: string): AdmissionRejection {
  return { outcome: "rejected", reason, detail }
}

function hasNul(value: string): boolean {
  return value.includes("\u0000")
}

/**
 * `value is string` at the type level, but the runtime check is
 * `typeof value === "string"` (not `value !== undefined`): the candidate
 * crosses a trust boundary where a field can be `null`, a number, or any
 * other JSON-representable shape despite what `RawEvidenceCandidate`
 * declares, and `.length`/`.includes` on a non-string would throw.
 */
function validIdentityField(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= IDENTITY_FIELD_MAX_LENGTH &&
    !hasNul(value)
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Deep-clones and recursively sorts object keys so two logically-identical
 * payloads built via different insertion orders hash identically (rather
 * than being misclassified as a collision), and so `payload.metadata`
 * cannot contain a `Map`/`Set`/getter/other non-JSON-plain value that could
 * (a) differ across repeated reads of the same object (a TOCTOU gap between
 * the byte-size check, the credential scan, and the persisted envelope), or
 * (b) silently bypass `Object.values`-based traversal in `screenPayload`
 * (e.g. a `Map`'s entries are not own enumerable properties). The initial
 * `JSON.stringify`/`parse` round-trip is also what makes a circular
 * reference or a `BigInt` value fail safely (caught below) instead of
 * throwing an uncaught `TypeError`/`RangeError` out of `admitEvidence`.
 *
 * Returns `undefined` if `payload` cannot be safely canonicalized at all
 * (circular reference, `BigInt`, pathological depth causing a stack
 * overflow in `JSON.stringify` itself, or an unexpected shape) -- the caller
 * treats this the same as any other malformed envelope.
 */
function canonicalizePayload(payload: unknown): EvidencePayload | undefined {
  if (!isPlainRecord(payload)) return undefined

  let cloned: unknown
  try {
    cloned = JSON.parse(JSON.stringify(payload)) as unknown
  } catch {
    return undefined
  }
  if (!isPlainRecord(cloned)) return undefined

  const text = typeof cloned.text === "string" ? cloned.text : undefined
  const metadata = isPlainRecord(cloned.metadata)
    ? (sortKeysDeep(cloned.metadata) as Record<string, unknown>)
    : undefined

  return {
    ...(text !== undefined ? { text } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  }
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (isPlainRecord(value)) {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key])
    return sorted
  }
  return value
}

/**
 * Recursively scans an already-canonicalized `payload` for a credential
 * using the same whole-input safety screening already established for
 * legacy user capture (`safeToCapture` in capture.ts): any detected
 * credential anywhere in the payload rejects the *entire* envelope, rather
 * than attempting a partial in-place redaction that could still leak
 * surrounding context.
 *
 * Returns `"too-complex"` if the bound is exceeded before a verdict is
 * reached, `"unscreenable"` if a credential was found, or `undefined` if the
 * payload scanned clean within bounds. Operates only on plain
 * objects/arrays/strings, which is safe here because `payload` has already
 * passed through `canonicalizePayload`.
 */
function screenPayload(payload: EvidencePayload): "too-complex" | "unscreenable" | undefined {
  if (payload.text !== undefined && containsSensitiveCredential(payload.text)) {
    return "unscreenable"
  }
  if (payload.metadata === undefined) return undefined

  let scanned = 0
  const stack: { value: unknown; depth: number }[] = [{ value: payload.metadata, depth: 0 }]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, depth } = next
    if (depth > PAYLOAD_MAX_SCAN_DEPTH) return "too-complex"
    scanned++
    if (scanned > PAYLOAD_MAX_SCAN_VALUES) return "too-complex"

    if (typeof value === "string") {
      if (containsSensitiveCredential(value)) return "unscreenable"
    } else if (Array.isArray(value)) {
      for (const entry of value) stack.push({ value: entry, depth: depth + 1 })
    } else if (isPlainRecord(value)) {
      for (const entry of Object.values(value)) stack.push({ value: entry, depth: depth + 1 })
    }
  }
  return undefined
}

function serializedByteLength(payload: EvidencePayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8")
}

/**
 * Derives the envelope's authoritative, namespaced identity from fields the
 * *authority* (not the raw candidate) controls, plus the host-reported
 * turn/message identity. Two candidates that genuinely share every one of
 * these fields are the same event; nothing about a candidate's own freeform
 * `id`-like claims (there is no such field on `RawEvidenceCandidate`) can
 * forge or select a different provider/project/session's identity space.
 *
 * The `\u0000`-joined namespace is purely an internal hashing input (every
 * field is pre-validated NUL-free by `validIdentityField`, so the join is
 * unambiguous); the returned `id` is a SHA-256 hex digest of that namespace,
 * never the raw joined string itself, so the result is always a short,
 * storage-safe (no NUL/control bytes) string suitable for a future
 * PostgreSQL `text` column (Phase 3), not just an internal fingerprint.
 */
function deriveEvidenceId(authority: AdmissionAuthority, candidate: RawEvidenceCandidate): string {
  const namespace = [
    `v${EVIDENCE_SCHEMA_VERSION}`,
    authority.providerId,
    authority.host,
    candidate.context.projectId,
    candidate.context.sessionId ?? "",
    candidate.turnId ?? "",
    candidate.messageId ?? "",
  ].join("\u0000")
  return createHash("sha256").update(namespace, "utf8").digest("hex")
}

/**
 * Deterministic function of the derived `id` plus the candidate's own
 * canonicalized, immutable fields; excludes any server-ingestion timestamp
 * (this function never reads a wall clock) and any later classifier result
 * (this module never sees one -- admission precedes classification). Uses
 * SHA-256 (via `node:crypto`, the same pattern `capture.ts`'s `stableId`
 * already establishes) rather than a lightweight custom hash: this value is
 * the sole signal distinguishing an idempotent replay (`"duplicate"`) from a
 * genuine `identity-collision`, so its collision resistance matters more
 * than the raw speed a smaller hash would buy.
 */
function computeContentHash(
  candidate: RawEvidenceCandidate,
  canonicalPayload: EvidencePayload,
  evidenceRefs: EvidenceReference[],
  id: string,
): string {
  const canonical = JSON.stringify({
    id,
    role: candidate.role,
    origin: candidate.origin,
    kind: candidate.kind,
    occurredAt: candidate.occurredAt,
    payload: canonicalPayload,
    evidenceRefs: [...evidenceRefs].map((ref) => `${ref.providerId}\u0000${ref.eventId}`).sort(),
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

function admitEvidenceUnsafe(
  candidate: RawEvidenceCandidate,
  authority: AdmissionAuthority,
  config: EvidenceAdmissionConfig,
  existing: ExistingEvidenceRecord | undefined,
): AdmissionResult {
  if (!config.enabled) return rejected("disabled", "evidence capture is not enabled")

  if (!EVIDENCE_ROLES.includes(candidate.role)) {
    return rejected("malformed-envelope", "role is not a recognized value")
  }
  if (!EVIDENCE_ORIGINS.includes(candidate.origin)) {
    return rejected("malformed-envelope", "origin is not a recognized value")
  }
  if (!EVIDENCE_KINDS.includes(candidate.kind)) {
    return rejected("malformed-envelope", "kind is not a recognized value")
  }
  if (typeof candidate.occurredAt !== "string" || Number.isNaN(Date.parse(candidate.occurredAt))) {
    return rejected("malformed-envelope", "occurredAt is not a valid timestamp")
  }
  if (!isPlainRecord(candidate.context)) {
    return rejected("malformed-envelope", "context is missing or not an object")
  }

  for (const [field, value] of [
    ["providerId", candidate.providerId],
    ["host", candidate.host],
    ["context.projectId", candidate.context.projectId],
    ["context.directory", candidate.context.directory],
    ["context.worktree", candidate.context.worktree],
  ] as const) {
    if (!validIdentityField(value)) {
      return rejected(
        "invalid-identity-field",
        `${field} is missing, empty, too long, or has a NUL character`,
      )
    }
  }
  if (
    candidate.context.sessionId !== undefined &&
    !validIdentityField(candidate.context.sessionId)
  ) {
    return rejected("invalid-identity-field", "context.sessionId is invalid")
  }
  if (candidate.turnId !== undefined && !validIdentityField(candidate.turnId)) {
    return rejected("invalid-identity-field", "turnId is invalid")
  }
  if (candidate.messageId !== undefined && !validIdentityField(candidate.messageId)) {
    return rejected("invalid-identity-field", "messageId is invalid")
  }

  // Credential-shaped values can be smuggled into identity-like fields, not
  // just payload text -- screen these the same way, rejecting the whole
  // candidate rather than admitting a secret through a field the payload
  // screen never looks at.
  for (const value of [
    candidate.context.sessionId,
    candidate.context.directory,
    candidate.context.worktree,
    candidate.turnId,
    candidate.messageId,
  ]) {
    if (typeof value === "string" && containsSensitiveCredential(value)) {
      return rejected("unscreenable-content", "an identity field contains an unscreenable value")
    }
  }

  // Host identity must be documented or use an established stable turn
  // identity; missing both yields an explicit unsupported-identity result
  // rather than deduplicating by prompt text. Lifecycle-only events may
  // legitimately lack both.
  if (
    candidate.kind !== "lifecycle" &&
    candidate.turnId === undefined &&
    candidate.messageId === undefined
  ) {
    return rejected("unsupported-identity", `no turnId or messageId for a ${candidate.kind} event`)
  }

  // Source data cannot select another provider or project: the candidate's
  // claimed provider/host/project must match the authority this admission
  // call is actually being performed for.
  if (
    candidate.providerId !== authority.providerId ||
    candidate.host !== authority.host ||
    candidate.context.projectId !== authority.projectId
  ) {
    return rejected(
      "foreign-scope",
      "candidate provider/host/project does not match the admitting authority",
    )
  }

  if (!config.enabledOrigins.includes(candidate.origin)) {
    return rejected("origin-not-enabled", `origin "${candidate.origin}" is not in the enabled set`)
  }

  const rawEvidenceRefs: unknown = candidate.evidenceRefs ?? []
  if (!Array.isArray(rawEvidenceRefs)) {
    return rejected("malformed-envelope", "evidenceRefs is not an array")
  }
  if (rawEvidenceRefs.length > config.maxEvidenceRefs) {
    return rejected(
      "too-many-evidence-refs",
      `${rawEvidenceRefs.length} evidence references exceeds the limit of ${config.maxEvidenceRefs}`,
    )
  }
  const evidenceRefs: EvidenceReference[] = []
  for (const ref of rawEvidenceRefs as unknown[]) {
    if (
      !isPlainRecord(ref) ||
      !validIdentityField(ref.providerId) ||
      !validIdentityField(ref.eventId)
    ) {
      return rejected(
        "invalid-identity-field",
        "an evidenceRefs entry is missing or has an invalid providerId/eventId",
      )
    }
    if (containsSensitiveCredential(ref.providerId) || containsSensitiveCredential(ref.eventId)) {
      return rejected(
        "unscreenable-content",
        "an evidenceRefs entry contains an unscreenable value",
      )
    }
    if (ref.providerId !== authority.providerId) {
      return rejected("foreign-scope", "an evidenceRefs entry references a foreign provider")
    }
    evidenceRefs.push({ providerId: ref.providerId, eventId: ref.eventId })
  }

  const canonicalPayload = canonicalizePayload(candidate.payload)
  if (canonicalPayload === undefined) {
    return rejected("malformed-envelope", "payload could not be canonicalized")
  }

  const payloadBytes = serializedByteLength(canonicalPayload)
  if (payloadBytes > config.maxPayloadBytes) {
    return rejected(
      "payload-too-large",
      `payload is ${payloadBytes} bytes, exceeding the limit of ${config.maxPayloadBytes}`,
    )
  }

  const screenResult = screenPayload(canonicalPayload)
  if (screenResult === "too-complex") {
    return rejected("payload-too-complex", "payload metadata exceeds the bounded scan depth/size")
  }
  if (screenResult === "unscreenable") {
    return rejected(
      "unscreenable-content",
      "payload contains an unscreenable credential-like value",
    )
  }

  const id = deriveEvidenceId(authority, candidate)
  const contentHash = computeContentHash(candidate, canonicalPayload, evidenceRefs, id)

  if (existing) {
    if (existing.contentHash === contentHash) return { outcome: "duplicate", id }
    return rejected("identity-collision", "same identity, different evidence")
  }

  return {
    outcome: "admitted",
    envelope: {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      id,
      providerId: authority.providerId,
      host: authority.host,
      context: candidate.context,
      ...(candidate.turnId !== undefined ? { turnId: candidate.turnId } : {}),
      ...(candidate.messageId !== undefined ? { messageId: candidate.messageId } : {}),
      role: candidate.role,
      origin: candidate.origin,
      kind: candidate.kind,
      occurredAt: candidate.occurredAt,
      payload: canonicalPayload,
      evidenceRefs,
      contentHash,
    },
  }
}

/**
 * Pure admission decision for one candidate event (TASK-008). Never throws
 * for malformed/hostile input -- every failure mode returns a structured
 * `AdmissionRejection` with a bounded reason code, never the rejected
 * content itself (decision 2, approved 2026-09-10). Every individual check
 * in `admitEvidenceUnsafe` is written defensively, and this wrapper is
 * additional defense-in-depth against any input shape or host bug (e.g. a
 * throwing getter) that an individual check did not anticipate.
 */
export function admitEvidence(
  candidate: RawEvidenceCandidate,
  authority: AdmissionAuthority,
  config: EvidenceAdmissionConfig = DEFAULT_EVIDENCE_ADMISSION_CONFIG,
  existing?: ExistingEvidenceRecord,
): AdmissionResult {
  try {
    return admitEvidenceUnsafe(candidate, authority, config, existing)
  } catch {
    return rejected("malformed-envelope", "candidate could not be validated")
  }
}

/**
 * Approved 2026-09-10: a rejection (e.g. `unsupported-identity`) must be
 * logged as a bounded diagnostic -- a reason code plus a count -- rather
 * than silently discarded, and never including the rejected content. This
 * aggregates a batch of results into exactly that shape; it performs no I/O
 * itself, leaving the caller to decide where the summary is logged.
 */
export function summarizeRejections(
  results: readonly AdmissionResult[],
): Partial<Record<AdmissionRejectionReason, number>> {
  const counts: Partial<Record<AdmissionRejectionReason, number>> = {}
  for (const result of results) {
    if (result.outcome !== "rejected") continue
    counts[result.reason] = (counts[result.reason] ?? 0) + 1
  }
  return counts
}
