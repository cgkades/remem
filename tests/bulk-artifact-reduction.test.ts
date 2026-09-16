import { describe, expect, it } from "vitest"
import {
  BULK_ARTIFACT_MAX_OUTPUT_BYTES,
  BULK_ARTIFACT_MIN_BYTES,
  looksLikeToolOutput,
  reduceBulkArtifact,
} from "../src/bulk-artifact-reduction.js"

function pythonTraceback(lineCount: number): string {
  const frames = Array.from(
    { length: lineCount },
    (_, index) =>
      `  File "/app/service/module_${index}.py", line ${100 + index}, in handler_${index}\n    do_thing_${index}()`,
  ).join("\n")
  return `Traceback (most recent call last):\n${frames}\nValueError: something went wrong deep in the stack`
}

function jsStackTrace(lineCount: number): string {
  const frames = Array.from(
    { length: lineCount },
    (_, index) => `    at handler${index} (/app/src/module${index}.js:${10 + index}:5)`,
  ).join("\n")
  return `TypeError: cannot read property 'x' of undefined\n${frames}`
}

function longLog(lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, index) =>
      `2026-09-16T00:${String(index % 60).padStart(2, "0")}:00.000Z INFO request handled ${index}`,
  ).join("\n")
}

describe("looksLikeToolOutput", () => {
  it("returns undefined for text under the minimum byte threshold, regardless of shape", () => {
    const shortTraceback = "Traceback (most recent call last):\nValueError: x"
    expect(Buffer.byteLength(shortTraceback, "utf8")).toBeLessThan(BULK_ARTIFACT_MIN_BYTES)
    expect(looksLikeToolOutput(shortTraceback)).toBeUndefined()
  })

  it("returns undefined for an ordinary long narrative with no tool-output markers", () => {
    const narrative = "We decided to migrate to logical replication because ".repeat(60)
    expect(Buffer.byteLength(narrative, "utf8")).toBeGreaterThan(BULK_ARTIFACT_MIN_BYTES)
    expect(looksLikeToolOutput(narrative)).toBeUndefined()
  })

  it("classifies a large Python traceback as stack-trace", () => {
    expect(looksLikeToolOutput(pythonTraceback(60))).toBe("stack-trace")
  })

  it("classifies a large Node/JS stack trace as stack-trace", () => {
    expect(looksLikeToolOutput(jsStackTrace(80))).toBe("stack-trace")
  })

  it("classifies a large Java stack trace (with a chained cause) as stack-trace", () => {
    const frames = Array.from(
      { length: 60 },
      (_, index) => `\tat com.example.Service.method${index}(Service.java:${100 + index})`,
    ).join("\n")
    const text = `java.lang.RuntimeException: outer failure\n${frames}\nCaused by: java.lang.NullPointerException\n${frames}`
    expect(looksLikeToolOutput(text)).toBe("stack-trace")
  })

  it("classifies a Go panic/goroutine dump as stack-trace", () => {
    const frames = Array.from(
      { length: 100 },
      (_, index) => `\t/app/main.go:${100 + index} +0x${index}`,
    ).join("\n")
    const text = `panic: runtime error: index out of range\n\ngoroutine 1 [running]:\n${frames}`
    expect(looksLikeToolOutput(text)).toBe("stack-trace")
  })

  it("classifies a dense timestamp-prefixed log as long-log", () => {
    expect(looksLikeToolOutput(longLog(45))).toBe("long-log")
  })

  it("does not classify a large payload with only occasional timestamp-like lines as long-log", () => {
    const mostlyNarrative = Array.from({ length: 60 }, (_, index) =>
      index === 0
        ? "2026-09-16T00:00:00.000Z started"
        : `We continued discussing option ${index} at considerable length in this narrative.`,
    ).join("\n")
    expect(Buffer.byteLength(mostlyNarrative, "utf8")).toBeGreaterThan(BULK_ARTIFACT_MIN_BYTES)
    expect(looksLikeToolOutput(mostlyNarrative)).toBeUndefined()
  })
})

describe("reduceBulkArtifact", () => {
  it("passes ordinary short/structured payloads through completely unchanged", () => {
    const text = "We decided to use logical replication for Orion."
    const result = reduceBulkArtifact(text)
    expect(result).toEqual({ text, reduced: false })
  })

  it("passes a large ordinary narrative through unchanged -- TASK-059 only touches tool-output-shaped content", () => {
    const narrative = "We decided to migrate to logical replication because ".repeat(60)
    const result = reduceBulkArtifact(narrative)
    expect(result).toEqual({ text: narrative, reduced: false })
  })

  it("reduces a large Python traceback and shrinks it substantially", () => {
    const raw = pythonTraceback(200)
    const result = reduceBulkArtifact(raw)
    expect(result.reduced).toBe(true)
    expect(result.reason).toBe("stack-trace")
    expect(result.text.length).toBeLessThan(raw.length)
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      BULK_ARTIFACT_MAX_OUTPUT_BYTES,
    )
    // The raw form must never appear verbatim in the reduced output.
    expect(result.text).not.toBe(raw)
  })

  it("preserves the head and tail lines verbatim", () => {
    const raw = pythonTraceback(200)
    const result = reduceBulkArtifact(raw)
    const rawLines = raw.split("\n")
    expect(result.text).toContain(rawLines[0])
    expect(result.text).toContain(rawLines[rawLines.length - 1])
  })

  it("preserves a key error line even when it is buried deep in the middle, outside the head/tail window", () => {
    const paddingBefore = Array.from(
      { length: 100 },
      (_, index) => `    at padding${index} (/app/pad${index}.js:1:1)`,
    )
    const paddingAfter = Array.from(
      { length: 100 },
      (_, index) => `    at padding${index + 100} (/app/pad${index + 100}.js:1:1)`,
    )
    const buriedKeyLine = "FATAL: connection pool exhausted after 30s"
    const text = [
      "Unrelated first line",
      ...paddingBefore,
      buriedKeyLine,
      ...paddingAfter,
      "Unrelated last line",
    ].join("\n")
    expect(looksLikeToolOutput(text)).toBeDefined()

    const result = reduceBulkArtifact(text)
    expect(result.reduced).toBe(true)
    expect(result.text).toContain(buriedKeyLine)
  })

  it("caps the number of extracted key lines", () => {
    const manyErrorLines = Array.from(
      { length: 100 },
      (_, index) => `Error: distinct failure number ${index}`,
    )
    const text = [
      "Traceback (most recent call last):",
      ...manyErrorLines,
      "ValueError: final",
    ].join("\n")
    const result = reduceBulkArtifact(text)
    expect(result.reduced).toBe(true)
    // Far fewer than the 100 available error lines should survive --
    // compare exact reduced-text lines, not substring containment (several
    // of these generated lines are literal prefixes of one another, e.g.
    // "number 1" is a substring of "number 10", "number 11", ...). A few
    // of the head/tail lines happen to also match the key-line pattern and
    // are preserved regardless (by design, head/tail are always kept
    // verbatim), so the bound here is generous rather than exact.
    const resultLines = new Set(result.text.split("\n"))
    const keyLineOccurrences = manyErrorLines.filter((line) => resultLines.has(line)).length
    expect(keyLineOccurrences).toBeLessThanOrEqual(30)
  })

  it("deduplicates an identical repeated key line found in the middle, without touching the separately-preserved tail", () => {
    const repeatedLine = "Error: the same failure repeated"
    const paddingBefore = Array.from(
      { length: 30 },
      (_, index) => `    at pad${index} (/app/pad${index}.js:1:1)`,
    )
    const repeatsInMiddle = Array.from({ length: 30 }, () => repeatedLine)
    const paddingAfter = Array.from(
      { length: 30 },
      (_, index) => `    at post${index} (/app/post${index}.js:1:1)`,
    )
    const text = [
      "Traceback (most recent call last):",
      ...paddingBefore,
      ...repeatsInMiddle,
      ...paddingAfter,
      "final line",
    ].join("\n")
    const result = reduceBulkArtifact(text)
    const occurrences = result.text.split(repeatedLine).length - 1
    expect(occurrences).toBe(1)
  })

  it("reduces a dense long log and bounds the output size", () => {
    const raw = longLog(500)
    const result = reduceBulkArtifact(raw)
    expect(result.reduced).toBe(true)
    expect(result.reason).toBe("long-log")
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      BULK_ARTIFACT_MAX_OUTPUT_BYTES,
    )
  })

  it("hard-truncates the reduced output itself if even the reduced form would exceed the output bound, and never overshoots the stated ceiling", () => {
    // A pathological input where head/tail lines are each individually
    // enormous, so even 5+5 lines of head/tail alone exceed the bound.
    const hugeLine = "x".repeat(2000)
    const lines = Array.from({ length: 30 }, () => hugeLine)
    const text = `Traceback (most recent call last):\n${lines.join("\n")}`
    const result = reduceBulkArtifact(text)
    expect(result.reduced).toBe(true)
    // BULK_ARTIFACT_MAX_OUTPUT_BYTES is documented as a hard ceiling on the
    // returned text itself -- no slop/tolerance here; the truncation
    // annotation's own byte cost must be reserved out of the budget, not
    // appended on top of it.
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      BULK_ARTIFACT_MAX_OUTPUT_BYTES,
    )
  })

  it("truncates at the output-byte bound without splitting a multi-byte UTF-8 character, even when the cut point lands mid-character", () => {
    // Each "🎉" is 4 UTF-8 bytes -- packing the huge line entirely with
    // this character all but guarantees the naive byte-offset cut point
    // lands inside a 4-byte sequence rather than on a boundary.
    const hugeLine = "🎉".repeat(1000)
    const lines = Array.from({ length: 10 }, () => hugeLine)
    const text = `Traceback (most recent call last):\n${lines.join("\n")}`
    const result = reduceBulkArtifact(text)
    expect(result.reduced).toBe(true)
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      BULK_ARTIFACT_MAX_OUTPUT_BYTES,
    )
    // No replacement character from a split multi-byte sequence.
    expect(result.text).not.toContain("\uFFFD")
  })
})
