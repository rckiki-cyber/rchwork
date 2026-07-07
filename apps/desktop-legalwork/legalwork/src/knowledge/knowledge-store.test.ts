import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { FileKnowledgeStore } from './knowledge-store.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../ports/model-client.js'

class StaticClassifierModel implements ModelClient {
  readonly provider = 'test'
  readonly model = 'test-classifier'
  requests: ModelRequest[] = []

  constructor(private readonly response: string) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
    this.requests.push(request)
    yield { kind: 'assistant_text_delta', text: this.response }
    yield { kind: 'completed', stopReason: 'stop' }
  }
}

describe('FileKnowledgeStore', () => {
  it('syncs local files and searches Chinese legal terms', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legalwork-kb-'))
    const sourceRoot = join(root, 'knowledge-base')
    const indexRoot = join(root, 'index')
    try {
      await mkdir(sourceRoot, { recursive: true })
      await writeFile(join(sourceRoot, 'personal-info.md'), [
        '# 个人信息保护法',
        '',
        '处理敏感个人信息应当取得个人的单独同意，并采取严格保护措施。'
      ].join('\n'), { encoding: 'utf8' })

      const store = new FileKnowledgeStore({
        rootDir: indexRoot,
        sourceRoots: [sourceRoot],
        nowIso: () => '2026-06-13T00:00:00.000Z'
      })

      const sync = await store.sync()
      expect(sync.documentCount).toBe(1)
      expect(sync.chunkCount).toBe(1)

      const hits = await store.search({
        query: '敏感个人信息 单独同意',
        limit: 5,
        includeContent: true
      })
      expect(hits).toHaveLength(1)
      expect(hits[0]?.title).toBe('personal info')
      expect(hits[0]?.content).toContain('单独同意')
      expect(hits[0]?.category).toBe('法规规范')
      expect(hits[0]?.keywords?.length).toBeGreaterThan(0)

      const diagnostics = await store.diagnostics()
      expect(diagnostics.lastSelectedIds).toEqual([hits[0]?.documentId])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('indexes files larger than the old upload-size guard', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legalwork-kb-large-'))
    const sourceRoot = join(root, 'knowledge-base')
    const indexRoot = join(root, 'index')
    try {
      await mkdir(sourceRoot, { recursive: true })
      await writeFile(
        join(sourceRoot, 'large.md'),
        `${'背景材料\n'.repeat(300_000)}\n超大文件索引特征词\n`,
        { encoding: 'utf8' }
      )

      const store = new FileKnowledgeStore({
        rootDir: indexRoot,
        sourceRoots: [sourceRoot],
        nowIso: () => '2026-06-13T00:00:00.000Z'
      })

      const sync = await store.sync()
      expect(sync.documentCount).toBe(1)

      const hits = await store.search({
        query: '超大文件索引特征词',
        limit: 5,
        includeContent: true
      })
      expect(hits[0]?.content).toContain('超大文件索引特征词')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('classifies managed files into category folders and refreshes retrieval index', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legalwork-kb-classify-'))
    const indexRoot = join(root, 'index')
    try {
      const store = new FileKnowledgeStore({
        rootDir: indexRoot,
        sourceRoots: [],
        nowIso: () => '2026-06-13T00:00:00.000Z'
      })

      await store.writeFile({
        path: '供应商合同审查.md',
        content: '供应商合同包含违约责任、解除条件和付款条款。',
        encoding: 'utf8'
      })
      await store.writeFile({
        path: '庭审证据目录.md',
        content: '本目录整理诉讼案件证据材料和质证意见。',
        encoding: 'utf8'
      })

      const result = await store.classify({ paths: ['供应商合同审查.md', '庭审证据目录.md'] })
      expect(result.moved.map((item) => item.destPath).sort()).toEqual([
        '合同协议/供应商合同审查.md',
        '诉讼仲裁/庭审证据目录.md'
      ])

      const tree = await store.tree()
      expect(tree.some((node) => node.path === '合同协议' && node.kind === 'folder')).toBe(true)
      expect(tree.some((node) => node.path === '诉讼仲裁' && node.kind === 'folder')).toBe(true)

      const hits = await store.search({
        query: '供应商 合同 违约责任',
        limit: 5,
        includeContent: false
      })
      expect(hits[0]?.relativePath).toBe('合同协议/供应商合同审查.md')
      expect(hits[0]?.category).toBe('合同协议')
      expect(hits[0]?.rankReason).toBeTruthy()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses the model and file content when classifying managed files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legalwork-kb-model-classify-'))
    const indexRoot = join(root, 'index')
    const model = new StaticClassifierModel('{"category":"论文","reason":"正文是学术论文"}')
    try {
      const store = new FileKnowledgeStore({
        rootDir: indexRoot,
        sourceRoots: [],
        nowIso: () => '2026-06-13T00:00:00.000Z',
        model
      })

      await store.writeFile({
        path: '未命名资料.md',
        content: '摘要：本文研究个人信息保护中的告知同意规则。\n关键词：个人信息保护；告知同意\n参考文献：[1] 民法典。',
        encoding: 'utf8'
      })

      const result = await store.classify({ paths: ['未命名资料.md'] })

      expect(result.moved[0]?.destPath).toBe('论文/未命名资料.md')
      expect(result.moved[0]?.reason).toBe('正文是学术论文')
      expect(model.requests).toHaveLength(1)
      const classifierMessage = model.requests[0]?.history[0]
      expect(classifierMessage?.kind).toBe('user_message')
      expect(classifierMessage?.kind === 'user_message' ? classifierMessage.text : '').toContain('告知同意规则')
      expect(model.requests[0]?.responseFormat).toBe('json_object')
      expect(model.requests[0]?.temperature).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to content-aware classification when no model is configured', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legalwork-kb-content-classify-'))
    const indexRoot = join(root, 'index')
    try {
      const store = new FileKnowledgeStore({
        rootDir: indexRoot,
        sourceRoots: [],
        nowIso: () => '2026-06-13T00:00:00.000Z'
      })

      await store.writeFile({
        path: '材料.md',
        content: '摘要：本文围绕劳动争议案件中的举证责任展开研究。\n关键词：劳动争议；举证责任\n参考文献：最高人民法院司法解释。',
        encoding: 'utf8'
      })

      const result = await store.classify({ paths: ['材料.md'] })

      expect(result.moved[0]?.destPath).toBe('论文/材料.md')
      expect(result.moved[0]?.reason).toBe('正文包含论文结构')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
