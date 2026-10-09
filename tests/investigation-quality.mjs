import { Buffer } from "node:buffer"

export function memoryContext(messages) {
  return messages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : (message.content ?? []).flatMap((part) =>
            typeof part.text === "string" ? [part.text] : [],
          ),
    )
    .filter((text) => text.includes("<memory-context>"))
    .join("\n")
}

function bodies(context, type) {
  return context.split(/\n(?=- \[)/u).flatMap((block) => {
    if (!block.startsWith(`- [current; ${type};`)) return []
    return block.split("\n").slice(1, 2).map(decodeContext)
  })
}

function decodeContext(text) {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")
}

/** Deliberately deterministic reader of the actual injected context. This is
 * a transport/answer-contract fixture, not a substitute for model evaluation. */
export function fixtureAnswer(context) {
  const root = bodies(context, "semantic").find((body) => body.includes("root cause:"))
  const procedure = bodies(context, "procedure").find((body) => body.includes("Goal:"))
  const commands = procedure
    ? [...procedure.matchAll(/Command: (.+?)(?= Command:| Error:| Steps:|$)/gu)].map((m) => m[1])
    : []
  const verified = procedure?.includes("same check subsequently completed with exit 0")
  const refs = [
    ...new Set([...context.matchAll(/Evidence: ([\w-]+:[a-f0-9]{64})/gu)].map((m) => m[1])),
  ]
  return {
    rootCause: root?.split("root cause:")[1]?.trim().replace(/\.$/u, "") ?? null,
    procedure: verified && commands.length === 2 ? [...commands, commands[0]] : [],
    decision:
      bodies(context, "decision")
        .find((body) => body.includes("Phoenix"))
        ?.trim() ?? null,
    followUp:
      bodies(context, "task")
        .find((body) => body.includes("is blocked"))
        ?.trim() ?? null,
    episodicDetail: context.includes("lookup root: workspace cwd") ? "workspace cwd" : null,
    evidenceRefs: refs,
    uncertainty: context.includes("not a verified conclusion") ? "historical evidence" : null,
  }
}

export function measureInvestigation({
  context,
  answer,
  expected,
  forbidden,
  requiredRefs,
  latencyMs,
}) {
  const targets = [
    expected.rootCause,
    expected.decision,
    expected.followUp,
    expected.detail,
    ...expected.procedure,
  ]
  const recalled = targets.filter((target) => decodeContext(context).includes(target)).length
  const falseInjection = forbidden.filter((text) => context.includes(text)).length
  const unsupportedAssertions = forbidden.filter((text) =>
    JSON.stringify(answer).includes(text),
  ).length
  const procedureAccuracy = JSON.stringify(answer.procedure) === JSON.stringify(expected.procedure)
  const answerCorrect =
    answer.rootCause === expected.rootCause &&
    answer.decision === expected.decision &&
    answer.followUp === expected.followUp &&
    answer.episodicDetail === expected.detailAnswer &&
    answer.uncertainty === "historical evidence" &&
    procedureAccuracy
  const provenanceCorrect = requiredRefs.every(
    (ref) => context.includes(ref) && answer.evidenceRefs.includes(ref),
  )
  return {
    recallAtK: recalled / targets.length,
    k: targets.length,
    answerCorrect,
    unsupportedAssertions,
    falseInjection,
    procedureAccuracy,
    provenanceCorrect,
    contextBytes: Buffer.byteLength(context, "utf8"),
    contextTokenUpperBound: Buffer.byteLength(context, "utf8"),
    contextTokenMeasurement: "UTF-8 byte upper bound; not tokenizer output",
    dispatchRoundTripMs: latencyMs,
    modelQuality: "not evaluated; deterministic context reader",
  }
}

export function percentile95(values) {
  if (!values.length) throw new Error("latency samples are required")
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]
}
