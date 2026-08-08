export type RecoveredDsmlToolCall = {
  toolName: string
  arguments: Record<string, unknown>
  visibleText: string
}

/**
 * Some DeepSeek-compatible gateways occasionally serialize their internal
 * DSML tool syntax into assistant text instead of returning structured
 * tool_calls. Recover one well-formed invocation only when its name is in the
 * tool list advertised for this exact request.
 */
export function recoverDsmlToolCall(
  text: string,
  advertisedToolNames: ReadonlySet<string>
): RecoveredDsmlToolCall | null {
  if (!text.includes('DSML') || !text.includes('invoke')) return null
  const invocation = text.match(
    /<[^<>]*invoke\s+name=["']([^"']+)["'][^<>]*>([\s\S]*?)<\/[^<>]*invoke\s*>/i
  )
  const toolName = invocation?.[1]?.trim() ?? ''
  const body = invocation?.[2] ?? ''
  if (!toolName || !advertisedToolNames.has(toolName)) return null

  const args: Record<string, unknown> = {}
  const parameter = /<[^<>]*parameter\s+name=["']([^"']+)["'](?:\s+string=["']([^"']+)["'])?[^<>]*>([\s\S]*?)<\/[^<>]*parameter\s*>/gi
  let match: RegExpExecArray | null
  while ((match = parameter.exec(body)) !== null) {
    const name = match[1]?.trim()
    if (!name) continue
    const raw = decodeXmlEntities(match[3] ?? '').trim()
    args[name] = match[2]?.toLowerCase() === 'true' ? raw : parseJsonValue(raw)
  }

  const wholeBlock = /<[^<>]*tool_calls[^<>]*>[\s\S]*?<\/[^<>]*tool_calls\s*>/i
  const visibleText = text.replace(wholeBlock, '').trim()
  return { toolName, arguments: args, visibleText }
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
