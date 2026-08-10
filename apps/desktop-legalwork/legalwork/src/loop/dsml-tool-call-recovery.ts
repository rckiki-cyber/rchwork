export type RecoveredDsmlToolCall = {
  toolName: string
  arguments: Record<string, unknown>
  visibleText: string
}

export type RecoveredDsmlToolCalls = {
  calls: Array<Omit<RecoveredDsmlToolCall, 'visibleText'>>
  visibleText: string
}

/**
 * Some DeepSeek-compatible gateways occasionally serialize their internal
 * DSML tool syntax into assistant text instead of returning structured
 * tool_calls. Recover every well-formed invocation whose name is in the tool
 * list advertised for this exact request. A single DSML block may contain
 * multiple invocations (for example, two independent bash checks), and
 * dropping all but the first can strand a required artifact workflow.
 */
export function recoverDsmlToolCalls(
  text: string,
  advertisedToolNames: ReadonlySet<string>
): RecoveredDsmlToolCalls | null {
  if (!text.includes('DSML') || !text.includes('invoke')) return null
  const invocation = /<[^<>]*invoke\s+name=["']([^"']+)["'][^<>]*>([\s\S]*?)<\/[^<>]*invoke\s*>/gi
  const calls: RecoveredDsmlToolCalls['calls'] = []
  let invocationMatch: RegExpExecArray | null
  while ((invocationMatch = invocation.exec(text)) !== null) {
    const toolName = invocationMatch[1]?.trim() ?? ''
    if (!toolName || !advertisedToolNames.has(toolName)) continue
    const body = invocationMatch[2] ?? ''
    const args: Record<string, unknown> = {}
    const parameter = /<[^<>]*parameter\s+name=["']([^"']+)["'](?:\s+string=["']([^"']+)["'])?[^<>]*>([\s\S]*?)<\/[^<>]*parameter\s*>/gi
    let parameterMatch: RegExpExecArray | null
    while ((parameterMatch = parameter.exec(body)) !== null) {
      const name = parameterMatch[1]?.trim()
      if (!name) continue
      const raw = decodeXmlEntities(parameterMatch[3] ?? '').trim()
      args[name] = parameterMatch[2]?.toLowerCase() === 'true' ? raw : parseJsonValue(raw)
    }
    calls.push({ toolName, arguments: args })
  }
  if (calls.length === 0) return null

  const wholeBlock = /<[^<>]*tool_calls[^<>]*>[\s\S]*?<\/[^<>]*tool_calls\s*>/gi
  const visibleText = text.replace(wholeBlock, '').trim()
  return { calls, visibleText }
}

/** Backward-compatible single-call view for callers that only need one call. */
export function recoverDsmlToolCall(
  text: string,
  advertisedToolNames: ReadonlySet<string>
): RecoveredDsmlToolCall | null {
  const recovered = recoverDsmlToolCalls(text, advertisedToolNames)
  const first = recovered?.calls[0]
  if (!recovered || !first) return null
  return { ...first, visibleText: recovered.visibleText }
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}
