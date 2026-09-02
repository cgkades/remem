import type {
  MemoryContext,
  MemoryMutationOptions,
  MemoryProvider,
  MemoryRecord,
  MemoryWrite,
} from "./types.js"

export class MemoryManager {
  private readonly providers: Map<string, MemoryProvider>

  constructor(
    providers: MemoryProvider[],
    private readonly primaryProviderId?: string,
  ) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]))
  }

  async create(
    memory: MemoryWrite,
    options: MemoryMutationOptions = {},
    providerId = this.primaryProviderId,
  ): Promise<MemoryRecord> {
    const provider = this.mutableProvider(providerId, "write")
    const result = await provider.write(memory, options)
    await provider.refresh?.()
    return result
  }

  async update(
    id: string,
    memory: MemoryWrite,
    options: MemoryMutationOptions = {},
    providerId = this.primaryProviderId,
  ): Promise<MemoryRecord> {
    const provider = this.mutableProvider(providerId, "update")
    const result = await provider.update(id, memory, options)
    await provider.refresh?.()
    return result
  }

  async supersede(
    id: string,
    replacement: MemoryWrite,
    options: MemoryMutationOptions = {},
    providerId = this.primaryProviderId,
  ): Promise<MemoryRecord> {
    const provider = this.mutableProvider(providerId, "supersede")
    const result = await provider.supersede(id, replacement, options)
    await provider.refresh?.()
    return result
  }

  async delete(
    id: string,
    context: MemoryContext,
    options: MemoryMutationOptions = {},
    providerId = this.primaryProviderId,
  ): Promise<void> {
    const provider = this.mutableProvider(providerId, "delete")
    await provider.delete(id, context, options)
    await provider.refresh?.()
  }

  async get(
    id: string,
    context: MemoryContext,
    providerId = this.primaryProviderId,
  ): Promise<MemoryRecord | undefined> {
    const provider = this.provider(providerId)
    if (!provider.get || !provider.capabilities().read) {
      throw new Error(`provider ${provider.id} does not support point reads`)
    }
    return provider.get(id, context)
  }

  private provider(providerId?: string): MemoryProvider {
    const provider = providerId
      ? this.providers.get(providerId)
      : this.providers.values().next().value
    if (!provider) throw new Error("no memory provider is configured")
    return provider
  }

  private mutableProvider<Method extends "write" | "update" | "supersede" | "delete">(
    providerId: string | undefined,
    method: Method,
  ): MemoryProvider & Required<Pick<MemoryProvider, Method>> {
    const provider = this.provider(providerId)
    if (!provider[method]) throw new Error(`provider ${provider.id} does not support ${method}`)
    return provider as MemoryProvider & Required<Pick<MemoryProvider, Method>>
  }
}
