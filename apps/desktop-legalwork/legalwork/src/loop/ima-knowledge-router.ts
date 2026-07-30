import type { TurnItem } from '../contracts/items.js'
import type { ModelToolSpec } from '../ports/model-client.js'

const IMA_SERVER_ID = 'ima-knowledge-base'
const IMA_RESEARCH_TOOL_ID = `${IMA_SERVER_ID}/research_ima`
const DIRECT_IMA_RESEARCH_TOOL = 'mcp_ima_knowledge_base_research_ima'
const MCP_SEARCH_TOOL = 'mcp_search'
const MCP_CALL_TOOL = 'mcp_call'

const LEGAL_DOMAIN_PATTERN =
  /法律|法规|法条|司法解释|规范性文件|案例|判例|裁判|法院|检察|合规|合同|劳动|用工|公司法|行政法|诉讼|仲裁|证据|监管|政策|法学|立法|司法|数据治理|人工智能|算法治理|知识产权|侵权|刑事|民事|商事/
const KNOWLEDGE_ACTION_PATTERN =
  /查询|查找|检索|研究|分析|依据|规定|是什么|怎么|如何|是否|能否|风险|起草|审查|比较|总结|解释|适用|效力|引用|出处|梳理|论证|评估|意见/
const IMA_MANAGEMENT_PATTERN =
  /登录|扫码|刷新|配置|插件|接口|协议|报错|错误|调试|代码|MCP|RAG|向量|路由|有哪些知识库|知识库列表/i

export type ImaRouteAction = {
  kind: 'direct' | 'discover' | 'call'
  requiredToolName: string
  requiredArguments: Record<string, unknown>
  instruction: string
}

export function shouldAutoRouteToIma(prompt: string): boolean {
  const text = prompt.trim()
  if (!text) return false
  if (
    /(?:不要|不用|无需|不必|禁止).{0,12}(?:调用|使用|查询|检索)?.{0,8}(?:IMA|知识库|外部资料|外部来源)/i.test(text)
  ) {
    return false
  }
  if (/(?:仅|只)(?:根据|基于|使用).{0,16}(?:我提供|当前材料|附件|本文|这份)/.test(text)) {
    return false
  }
  if (
    /(?:仅|只)(?:使用|查|查询|检索).{0,16}(?:北大法宝|国家法律法规数据库|元典|本地知识库)/.test(text)
  ) {
    return false
  }
  if (/IMA/i.test(text) && IMA_MANAGEMENT_PATTERN.test(text)) return false
  if (/IMA/i.test(text)) return true
  if (
    /起草|撰写|生成|写一份/.test(text) &&
    !/查询|检索|研究|分析|依据|规定|风险|论证/.test(text)
  ) {
    return false
  }
  return LEGAL_DOMAIN_PATTERN.test(text) && KNOWLEDGE_ACTION_PATTERN.test(text)
}

export function resolveImaRouteAction(input: {
  prompt: string
  tools: readonly ModelToolSpec[]
  items: readonly TurnItem[]
  turnId: string
  enabled?: boolean
}): ImaRouteAction | null {
  if (input.enabled === false || !shouldAutoRouteToIma(input.prompt)) return null
  if (hasSuccessfulImaResearch(input.items, input.turnId)) return null

  const toolNames = new Set(input.tools.map((tool) => tool.name))
  if (toolNames.has(DIRECT_IMA_RESEARCH_TOOL)) {
    return {
      kind: 'direct',
      requiredToolName: DIRECT_IMA_RESEARCH_TOOL,
      requiredArguments: { question: input.prompt },
      instruction: autoRouteInstruction(DIRECT_IMA_RESEARCH_TOOL)
    }
  }

  const discoveredToolId = discoveredImaResearchToolId(input.items, input.turnId)
  if (discoveredToolId && toolNames.has(MCP_CALL_TOOL)) {
    return {
      kind: 'call',
      requiredToolName: MCP_CALL_TOOL,
      requiredArguments: {
        toolId: discoveredToolId,
        arguments: { question: input.prompt }
      },
      instruction: autoRouteInstruction(MCP_CALL_TOOL)
    }
  }

  if (!hasMcpDiscoveryAttempt(input.items, input.turnId) && toolNames.has(MCP_SEARCH_TOOL)) {
    return {
      kind: 'discover',
      requiredToolName: MCP_SEARCH_TOOL,
      requiredArguments: {
        query: `IMA 知识库自动研究：${input.prompt}`,
        serverId: IMA_SERVER_ID,
        topK: 5
      },
      instruction: autoRouteInstruction(MCP_SEARCH_TOOL)
    }
  }
  return null
}

function autoRouteInstruction(requiredToolName: string): string {
  return [
    '<ima_auto_route>',
    '当前请求已被运行时识别为知识密集型法律任务，应主动检索用户的 IMA 云知识库。',
    '用户不需要额外强调“请调用 IMA”。在形成最终结论前，先执行本轮唯一开放的 IMA 路由工具。',
    `本步必须调用 \`${requiredToolName}\`；不要仅凭模型记忆直接回答。`,
    'IMA 无匹配、不可用或失败时，再继续使用国家法律法规数据库、北大法宝、元典或本地知识库，并如实说明来源。',
    '</ima_auto_route>'
  ].join('\n')
}

function hasSuccessfulImaResearch(items: readonly TurnItem[], turnId: string): boolean {
  return items.some((item) => {
    if (item.turnId !== turnId || item.kind !== 'tool_result' || item.isError) return false
    if (item.toolName === DIRECT_IMA_RESEARCH_TOOL) return true
    if (item.toolName !== MCP_CALL_TOOL) return false
    const output = objectValue(item.output)
    return output.serverId === IMA_SERVER_ID && output.toolName === 'research_ima'
  })
}

function hasMcpDiscoveryAttempt(items: readonly TurnItem[], turnId: string): boolean {
  return items.some((item) =>
    item.turnId === turnId &&
    item.kind === 'tool_result' &&
    item.toolName === MCP_SEARCH_TOOL
  )
}

function discoveredImaResearchToolId(
  items: readonly TurnItem[],
  turnId: string
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (
      item?.turnId !== turnId ||
      item.kind !== 'tool_result' ||
      item.toolName !== MCP_SEARCH_TOOL ||
      item.isError
    ) {
      continue
    }
    const output = objectValue(item.output)
    const results = Array.isArray(output.results) ? output.results : []
    const match = results.find((result) => objectValue(result).toolId === IMA_RESEARCH_TOOL_ID)
    if (match) return IMA_RESEARCH_TOOL_ID
  }
  return undefined
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
