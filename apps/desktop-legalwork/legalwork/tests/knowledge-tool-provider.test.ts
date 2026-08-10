import { describe, expect, it } from 'vitest'
import { buildKnowledgeToolProviders } from '../src/adapters/tool/knowledge-tool-provider.js'
import type { KnowledgeStore } from '../src/knowledge/knowledge-store.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

describe('knowledge tool provider', () => {
  it('rejects citation verification when the draft contains no citation markers', async () => {
    const store = {
      diagnostics: async () => ({ documentCount: 1 }),
      tree: async () => []
    } as unknown as KnowledgeStore
    const provider = buildKnowledgeToolProviders(store)[0]
    const tool = provider?.tools.find((candidate) => candidate.name === 'knowledge_citation_verify')
    if (!tool) throw new Error('knowledge_citation_verify tool missing')

    const result = await tool.execute(
      { draft: '# 研究报告\n\n正文没有任何 [N] 格式引用。\n\n# 参考文献' },
      {} as ToolHostContext
    )
    const output = result.output as Record<string, unknown>

    expect(result.isError).toBe(true)
    expect(output.verificationPassed).toBe(false)
    expect(output.documentStats).toMatchObject({ totalCitations: 0 })
    expect(output.recommendations).toEqual([
      expect.stringContaining('不能视为已完成引用核验')
    ])
  })
})
