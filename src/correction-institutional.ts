import type { InstitutionalWrite } from "./institutional.js"
import type { InstitutionalLoader } from "./correction.js"
import type { InstitutionalMemory, MemoryContext, MemoryProvider, MemoryRecord } from "./types.js"

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function toInstitutionalWrite(record: MemoryRecord): InstitutionalWrite {
  return {
    title: record.title,
    content: record.content,
    scope: record.scope,
    type: record.type,
    ...(record.provenance ? { provenance: record.provenance } : {}),
    ...(record.institutional ? { institutional: record.institutional } : {}),
  }
}

/**
 * Loads the full institutional corpus (positions and procedures) visible to
 * `context` across every provider: the catalog identifies which entries are
 * institutional, then `get()` fetches the full record each one needs, since
 * `CatalogEntry` doesn't carry `content`/`type`/`provenance`.
 */
async function loadInstitutionalRecords(
  providers: MemoryProvider[],
  context: MemoryContext,
): Promise<MemoryRecord[]> {
  const records: MemoryRecord[] = []
  for (const provider of providers) {
    if (!provider.get) continue
    const controller = new AbortController()
    const entries = await provider.catalog(context, controller.signal)
    const institutionalEntries = entries.filter((entry) => entry.institutional)
    // Non-null assertion is safe: `provider.get` was checked truthy above,
    // and providers don't mutate their own capabilities mid-loop.
    const fetched = await Promise.all(
      institutionalEntries.map((entry) => provider.get!(entry.id, context)),
    )
    records.push(...fetched.filter(isDefined))
  }
  return records
}

/**
 * Builds the `loadInstitutional`/`loadInstitutionalWrites` pair
 * `CorrectionReviewQueue` needs, backed by a live set of providers instead
 * of a fixture. Both loaders re-query the providers on every call, so a
 * candidate is always diagnosed and validated against the current corpus,
 * not a stale snapshot.
 */
export function createInstitutionalLoaders(providers: MemoryProvider[]): {
  loadInstitutional: InstitutionalLoader<InstitutionalMemory[]>
  loadInstitutionalWrites: InstitutionalLoader<InstitutionalWrite[]>
} {
  return {
    loadInstitutional: async (context) => {
      const records = await loadInstitutionalRecords(providers, context)
      return records.map((record) => record.institutional).filter(isDefined)
    },
    loadInstitutionalWrites: async (context) => {
      const records = await loadInstitutionalRecords(providers, context)
      return records.map(toInstitutionalWrite)
    },
  }
}
