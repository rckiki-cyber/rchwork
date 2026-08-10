import { describe, expect, it } from 'vitest'
import { imaKnowledgeBaseInstruction, readImaKnowledgeBaseCache } from './ima-knowledge-base-cache.js'

describe('ima knowledge base cache', () => {
  it('generates instruction listing actual KBs', () => {
    const cache = {
      count: 3,
      knowledge_bases: [
        { id: 'a', name: '宽严相济' },
        { id: 'b', name: '⚖️法律法规库' },
        { id: 'c', name: '人民法院案例库' }
      ]
    }
    const inst = imaKnowledgeBaseInstruction(cache)
    expect(inst).toContain('宽严相济')
    expect(inst).toContain('法律法规库')
    expect(inst).toContain('research_ima')
    expect(inst).toContain('3 个')
  })

  it('reads the actual cache file on this machine', () => {
    const cache = readImaKnowledgeBaseCache()
    // 缓存文件可能不存在（IMA 尚未调用），此时返回 null 是合法的。
    if (cache) {
      expect(cache.knowledge_bases.length).toBeGreaterThan(0)
    }
  })
})
