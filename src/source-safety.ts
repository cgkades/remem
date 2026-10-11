import { containsSensitiveCredential, containsSensitivePathCredential } from "./sensitive-data.js"

// Known poisoning shapes only. Framing all recalled data as untrusted remains
// necessary; this bounded screen is not a general injection detector.
export const KNOWN_UNSAFE_INSTRUCTIONS =
  /<\/?(?:memory-context|system|instructions)>|\bignore (?:all |the )?(?:previous|prior|system) instructions\b|\b(?:reveal|exfiltrate)\b.{0,80}\b(?:secrets?|credentials?|system prompt)\b/isu

/** Screen the whole source before truncation, including nested provenance and
 * metadata. Never invoke accessors, toJSON, or custom objects from providers. */
export function sourceIsSafe(value: unknown): boolean {
  let nodes = 0
  let characters = 0
  const seen = new WeakSet<object>()
  function inspect(item: unknown, key: string, depth: number): boolean {
    if (++nodes > 4000 || depth > 16) return false
    if (typeof item === "string") {
      characters += item.length
      return (
        characters <= 2_000_000 &&
        !KNOWN_UNSAFE_INSTRUCTIONS.test(item) &&
        !(/(?:source|uri|path|directory|worktree)$/iu.test(key) ||
        /^(?:\/|[a-z][a-z0-9+.-]*:\/\/)/iu.test(item)
          ? containsSensitivePathCredential(item)
          : containsSensitiveCredential(item))
      )
    }
    if (item === null || item === undefined || typeof item === "boolean") return true
    if (typeof item === "number") return Number.isFinite(item)
    if (typeof item !== "object" || seen.has(item)) return false
    seen.add(item)
    try {
      const prototype: unknown = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype)
        return false
      const descriptors = Object.getOwnPropertyDescriptors(item)
      const keys = Reflect.ownKeys(descriptors)
      if (keys.length > 4000) return false
      for (const name of keys) {
        if (typeof name !== "string") return false
        const descriptor = descriptors[name]!
        if (!("value" in descriptor) || !inspect(name, "", depth + 1)) return false
        const child: unknown = descriptor.value
        // Credential field names and values must also be screened together.
        if (
          typeof child === "string" &&
          /^(?:api[_ -]?(?:key|token)|secret|pass(?:word)?|pwd|private[_ -]?key|access[_ -]?token)$/iu.test(
            name,
          ) &&
          containsSensitiveCredential(`${name}=${child}`)
        )
          return false
        if (!inspect(child, name, depth + 1)) return false
      }
      return true
    } catch {
      return false
    } finally {
      // Shared plain data is a DAG, not a cycle. Bound repeated visits while
      // rejecting only references already on the active recursion path.
      seen.delete(item)
    }
  }
  return inspect(value, "", 0)
}

export function safeSourceLabel(value: string): string {
  return value.length <= 160 && sourceIsSafe(value) ? value : "withheld-source"
}
