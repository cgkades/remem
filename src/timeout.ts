export class OperationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`operation timed out after ${timeoutMs}ms`)
    this.name = "OperationTimeoutError"
  }
}

export async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (parentSignal?.aborted) {
    const suppliedReason: unknown = parentSignal.reason
    throw suppliedReason instanceof Error
      ? suppliedReason
      : new DOMException("The operation was aborted", "AbortError")
  }
  const controller = new AbortController()
  let rejectParent: ((reason?: unknown) => void) | undefined
  const parentAbort = new Promise<never>((_resolve, reject) => {
    rejectParent = reject
  })
  const onParentAbort = () => {
    const suppliedReason: unknown = parentSignal?.reason
    const reason =
      suppliedReason instanceof Error
        ? suppliedReason
        : new DOMException("The operation was aborted", "AbortError")
    controller.abort(reason)
    rejectParent?.(reason)
  }
  if (parentSignal?.aborted) onParentAbort()
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new OperationTimeoutError(timeoutMs)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })

  try {
    return await Promise.race([operation(controller.signal), timeout, parentAbort])
  } finally {
    if (timer) clearTimeout(timer)
    parentSignal?.removeEventListener("abort", onParentAbort)
  }
}
