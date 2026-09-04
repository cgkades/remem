import type { ApplyMutation } from "./correction.js"
import type { MemoryContext, MemoryProvider } from "./types.js"

async function findOwningProvider(
  providers: MemoryProvider[],
  id: string,
  context: MemoryContext,
): Promise<MemoryProvider | undefined> {
  for (const provider of providers) {
    if (!provider.get) continue
    const record = await provider.get(id, context)
    if (record) return provider
  }
  return undefined
}

/**
 * Builds a real `ApplyMutation` that dispatches a candidate's mutation to
 * the provider that owns it: `create` goes to the first configured provider
 * with write capability, `update`/`supersede`/`retire` are resolved to
 * whichever provider's `get()` already knows the target id.
 * `route_adjustment` mutations describe a routing/procedure fix outside
 * memory content and are rejected here -- there is nothing for a provider
 * to write.
 */
export function createProviderApplyMutation(providers: MemoryProvider[]): ApplyMutation {
  return async (mutation, context) => {
    if (mutation.kind === "route_adjustment") {
      throw new Error(
        "route_adjustment mutations describe a routing/procedure change and cannot be applied to a provider automatically",
      )
    }

    if (mutation.kind === "create") {
      const provider = providers.find(
        (candidate) => candidate.capabilities().write && typeof candidate.write === "function",
      )
      if (!provider?.write) {
        throw new Error("no configured provider supports write; cannot apply a create mutation")
      }
      const record = await provider.write(mutation.proposed, { context })
      await provider.refresh?.()
      return { memoryId: record.id }
    }

    const owner = await findOwningProvider(providers, mutation.targetMemoryId, context)
    if (!owner) {
      throw new Error(`no configured provider owns memory ${mutation.targetMemoryId}`)
    }

    if (mutation.kind === "retire") {
      if (!owner.delete) {
        throw new Error(
          `provider ${owner.id} does not support delete; cannot apply a retire mutation`,
        )
      }
      await owner.delete(mutation.targetMemoryId, context)
      await owner.refresh?.()
      return { memoryId: mutation.targetMemoryId }
    }

    let record: { id: string }
    if (mutation.kind === "update") {
      record = await callOrThrow(
        owner,
        "update",
        mutation.targetMemoryId,
        mutation.proposed,
        context,
      )
    } else if (mutation.kind === "supersede") {
      record = await callOrThrow(
        owner,
        "supersede",
        mutation.targetMemoryId,
        mutation.proposed,
        context,
      )
    } else {
      const unknownKind: never = mutation.kind
      throw new Error(`unrecognized mutation kind: ${JSON.stringify(unknownKind)}`)
    }
    await owner.refresh?.()
    return { memoryId: record.id }
  }
}

async function callOrThrow(
  provider: MemoryProvider,
  method: "update" | "supersede",
  id: string,
  memory: Parameters<NonNullable<MemoryProvider["update"]>>[1],
  context: MemoryContext,
) {
  if (method === "update") {
    if (!provider.update) throw new Error(`provider ${provider.id} does not support update`)
    return provider.update(id, memory, { context })
  }
  if (!provider.supersede) throw new Error(`provider ${provider.id} does not support supersede`)
  return provider.supersede(id, memory, { context })
}
