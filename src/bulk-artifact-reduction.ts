/**
 * TASK-059 (Phase 3, approved 2026-09-16): deterministic bulk-artifact
 * reduction applied *before persistence*. Detects tool-output-shaped
 * payloads (stack traces, long logs) and reduces them to key error/
 * exception lines plus a bounded head/tail -- the raw form is never
 * stored for anything classified as a bulk artifact. Ordinary short or
 * structured payloads (the overwhelming majority of evidence) are never
 * touched: this module is deliberately conservative about what it
 * classifies as a bulk artifact, since misclassifying a narrative/
 * reasoning statement as "tool output" and shrinking it would violate
 * the plan's separate compaction policy (TASK-060), which requires
 * "minimal reduction of reasoning/narrative text." TASK-059 is a
 * narrower, purely content-shape-driven reduction independent of age or
 * storage pressure.
 *
 * This is the deterministic default path. An optional, explicitly
 * configured summarizer (see `EvidenceAdmissionConfig.bulkArtifactSummarizer`
 * in `observation-admission.ts`) may replace it for a given source, but the
 * deterministic path here is never bypassed unless a summarizer is actually
 * configured, and a summarizer failure always falls back to this module --
 * per the plan, the deterministic path is never optional to *have*, only
 * optional to *augment*.
 */

/** Below this size, a payload is never classified as a bulk artifact and is never touched -- this is what "ordinary short/structured payloads pass through unchanged" means in practice. */
export const BULK_ARTIFACT_MIN_BYTES = 2000

/** Lines kept verbatim from the start and end of a classified bulk artifact. */
export const BULK_ARTIFACT_HEAD_LINES = 5
export const BULK_ARTIFACT_TAIL_LINES = 5

/** Maximum number of distinct "key" (error/exception-shaped) lines extracted from the middle of a classified bulk artifact, beyond the head/tail. */
export const BULK_ARTIFACT_MAX_KEY_LINES = 15

/** Hard output-size ceiling for the reduced text itself, independent of the evidence-admission payload byte limit -- this module never claims to produce arbitrarily large "reduced" output. */
export const BULK_ARTIFACT_MAX_OUTPUT_BYTES = 2000

/**
 * Recognized stack-trace shapes across common runtimes. A single match
 * anywhere in the text is sufficient to classify as a bulk artifact --
 * these patterns are specific enough (multi-word literal markers, not
 * generic punctuation) that a false positive on ordinary narrative text is
 * very unlikely.
 */
const STACK_TRACE_PATTERNS: RegExp[] = [
  /^Traceback \(most recent call last\):/m, // Python
  /^\s*at\s+\S+\s*\(.*:\d+:\d+\)\s*$/m, // Node/V8 / JS
  /^\s*at\s+[\w$.<>]+\(.*\.java(?::\d+)?\)\s*$/m, // Java
  /^Caused by:\s/m, // Java chained cause
  /^\s*File "[^"]+", line \d+/m, // Python (alternate frame form)
  /^panic:\s/m, // Go panic
  /^goroutine \d+ \[[^\]]+\]:/m, // Go goroutine dump
  /^\s*#\d+\s+0x[0-9a-f]+/m, // native/C backtrace frame
  /^\s*at\s+\S+\(.*\)\s+in\s+.+:line\s+\d+\s*$/m, // .NET/C#
  /^thread '.*' panicked at /m, // Rust
  /^\s*\d+:\s+0x[0-9a-f]+\s+-\s+/m, // Rust backtrace frame (e.g. "  1: 0x... - rust_begin_unwind")
]

/**
 * A line that looks like a log line. Deliberately covers a few common
 * timestamp shapes (ISO 8601 with T-or-space separator, bracketed
 * `[YYYY-MM-DD HH:MM:SS]`, and a bare Unix-epoch-looking prefix) --
 * known gap: a purely JSON-structured log (e.g. `{"level":"error",...}`
 * with no textual timestamp prefix at all) is not detected by this
 * heuristic and will not be classified as a bulk artifact; this is an
 * accepted limitation of the deterministic detector, not a silent
 * correctness bug -- such content simply passes through this module
 * unreduced (and is subject to the ordinary `maxPayloadBytes` limit like
 * any other untouched payload).
 */
const LOG_LINE_PATTERN =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\]|\d{10,13}\s)/

/** A line likely to carry the actual diagnostic signal, worth preserving even outside the head/tail window. */
const KEY_LINE_PATTERN = /\b(error|exception|fail(?:ed|ure)?|panic|fatal|traceback|caused by)\b/i

/** Fraction of a large payload's lines that must look like log lines before it is classified as a "long log" bulk artifact (as opposed to, say, a long narrative document that merely happens to be long). */
const LOG_LINE_DENSITY_THRESHOLD = 0.5
const LOG_LINE_MIN_LINES = 20

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte character in half (which `Buffer.subarray` alone can do,
 * producing a `\uFFFD` replacement character at the cut point on
 * `.toString("utf8")`). Backs off past any trailing UTF-8 continuation
 * bytes (`10xxxxxx`) at the cut boundary, which can only belong to a
 * sequence that started earlier, so that sequence is dropped whole rather
 * than half-included.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const buffer = Buffer.from(text, "utf8")
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--
  return buffer.subarray(0, end).toString("utf8")
}

export interface BulkArtifactReductionResult {
  text: string
  /** False means the input was returned completely unchanged (not classified as a bulk artifact, or already within bounds). */
  reduced: boolean
  /** Present only when `reduced` is true -- which detector classified the input. */
  reason?: "stack-trace" | "long-log"
}

/**
 * Content-shape classifier, independent of the caller's declared `kind`/
 * `role` -- a user pasting a raw stack trace must be classified the same
 * way a tool-result event carrying the same text would be, since the
 * plan's concern is the *shape* of the payload, not its declared origin.
 */
export function looksLikeToolOutput(text: string): "stack-trace" | "long-log" | undefined {
  if (Buffer.byteLength(text, "utf8") < BULK_ARTIFACT_MIN_BYTES) return undefined
  if (STACK_TRACE_PATTERNS.some((pattern) => pattern.test(text))) return "stack-trace"

  const lines = text.split("\n")
  if (lines.length < LOG_LINE_MIN_LINES) return undefined
  const logLineCount = lines.filter((line) => LOG_LINE_PATTERN.test(line)).length
  if (logLineCount / lines.length >= LOG_LINE_DENSITY_THRESHOLD) return "long-log"
  return undefined
}

/**
 * Reduces `text` to a bounded head + deduplicated key (error/exception)
 * lines + a bounded tail, if and only if `looksLikeToolOutput` classifies
 * it as a bulk artifact. Returns the input unchanged (with `reduced:
 * false`) for anything not classified as such -- this function is the
 * single point that decides "does this get shrunk at all," so a caller
 * never needs to duplicate the classification logic.
 */
export function reduceBulkArtifact(text: string): BulkArtifactReductionResult {
  const reason = looksLikeToolOutput(text)
  if (!reason) return { text, reduced: false }

  const lines = text.split("\n")
  const headLines = lines.slice(0, BULK_ARTIFACT_HEAD_LINES)
  const tailLines =
    lines.length > BULK_ARTIFACT_HEAD_LINES ? lines.slice(-BULK_ARTIFACT_TAIL_LINES) : []
  const headTailSet = new Set([...headLines, ...tailLines])

  // Key lines are taken from the *middle* (not already covered by head/
  // tail) so the same line is never duplicated between sections; dedup by
  // exact line content, in first-seen order, capped so this section itself
  // stays bounded regardless of how many "error" lines a pathological
  // input contains.
  const middleStart = BULK_ARTIFACT_HEAD_LINES
  const middleEnd = Math.max(middleStart, lines.length - BULK_ARTIFACT_TAIL_LINES)
  const seenKeyLines = new Set<string>()
  const keyLines: string[] = []
  for (const line of lines.slice(middleStart, middleEnd)) {
    if (!KEY_LINE_PATTERN.test(line)) continue
    if (seenKeyLines.has(line)) continue
    seenKeyLines.add(line)
    keyLines.push(line)
    if (keyLines.length >= BULK_ARTIFACT_MAX_KEY_LINES) break
  }

  const omittedLineCount = lines.length - headTailSet.size - keyLines.length
  const sections = [
    headLines.join("\n"),
    keyLines.length > 0
      ? `... [${Math.max(0, omittedLineCount)} line(s) omitted; ${keyLines.length} key line(s) extracted deterministically] ...\n${keyLines.join("\n")}`
      : `... [${Math.max(0, omittedLineCount)} line(s) omitted deterministically] ...`,
    tailLines.join("\n"),
  ].filter((section) => section.length > 0)

  let combined = sections.join("\n")
  if (Buffer.byteLength(combined, "utf8") > BULK_ARTIFACT_MAX_OUTPUT_BYTES) {
    // Even the reduced form can exceed the bound for a pathological input
    // (e.g. extremely long individual lines) -- fall back to a hard byte
    // truncation of the already-reduced text rather than leaving an
    // unbounded result. `truncateToTokens`-style ellipsis is intentionally
    // not reused here (that module's truncation targets prose readability,
    // not a bulk artifact's already-structured section markers).
    // `truncateUtf8` (not a plain `Buffer.subarray`) avoids splitting a
    // multi-byte character at the cut point. The annotation suffix's own
    // byte length is reserved *before* truncating the body, so the total
    // returned text never exceeds `BULK_ARTIFACT_MAX_OUTPUT_BYTES` -- it is
    // an actual hard ceiling, not one this fallback path quietly overshoots.
    const suffix = "\n... [reduced output itself truncated to fit the output bound] ..."
    const bodyBudget = Math.max(
      0,
      BULK_ARTIFACT_MAX_OUTPUT_BYTES - Buffer.byteLength(suffix, "utf8"),
    )
    combined = `${truncateUtf8(combined, bodyBudget)}${suffix}`
  }

  return { text: combined, reduced: true, reason }
}
