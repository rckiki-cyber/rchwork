import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDocumentSkillExecuteTool,
  deterministicPdfPayloadError,
  prepareDocumentWorkerArgs
} from '../src/adapters/tool/builtin-document-skill-tool.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

describe('document_skill_execute', () => {
  let root = ''
  let workspace = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'legalwork-document-tool-'))
    workspace = join(root, 'workspace')
    await mkdir(workspace, { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('advertises valid operations and the one-call inline Word path', () => {
    const tool = createDocumentSkillExecuteTool()
    const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>

    expect(properties.operation?.enum).toContain('from-markdown')
    expect(properties.content?.description).toContain('inline Markdown')
    expect(properties.content?.description).toContain('Never use a preview')
    expect(properties.outputPath?.description).toContain('thread workspace')
    expect(tool.description).toContain('Do not probe with help/list')
    expect(tool.description).toContain('never pass cache-hygiene text')
  })

  it('prepares a Word worker invocation from inline Markdown without a bash intermediate file', async () => {
    const prepared = await prepareDocumentWorkerArgs({
      args: [],
      content: '# 文献综述\n\n正文',
      outputPath: '交付/文献综述.docx',
      profile: 'academic',
      workspace
    })
    const expectedPath = join(workspace, '交付', '文献综述.docx')
    const inputIndex = prepared.workerArgs.indexOf('--input')
    const outputIndex = prepared.workerArgs.indexOf('--output')
    const profileIndex = prepared.workerArgs.indexOf('--profile')

    expect(prepared.workerArgs[outputIndex + 1]).toBe(expectedPath)
    expect(prepared.workerArgs[profileIndex + 1]).toBe('academic')
    await expect(readFile(prepared.workerArgs[inputIndex + 1] ?? '', 'utf8'))
      .resolves.toBe('# 文献综述\n\n正文')
    await prepared.cleanup()
    await expect(readFile(prepared.workerArgs[inputIndex + 1] ?? '', 'utf8')).rejects.toThrow()
  })

  it('rejects inline content for mismatched worker operations before execution', async () => {
    const tool = createDocumentSkillExecuteTool()
    const result = await tool.execute({
      kind: 'docx',
      operation: 'inspect',
      content: 'unexpected'
    }, context())

    expect(result.isError).toBe(true)
    expect(result.output).toMatchObject({
      error: 'inline content is supported only for docx/from-markdown; use open-kimi-ppt for presentation creation'
    })
  })

  it('advertises local PDF conversion and delegates new PPT creation to open-kimi-ppt', async () => {
    const tool = createDocumentSkillExecuteTool()
    const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>
    expect(properties.kind?.enum).toContain('pdf')
    expect(properties.operation?.enum).toContain('from-docx')
    expect(tool.description).toContain('pdf/from-docx')
    expect(tool.description).toContain('unified open-kimi-ppt Skill')
    expect(tool.description).not.toContain('PPT uses pptx/from-json')
  })

  it('rejects every generic pptx/from-json creation attempt', async () => {
    const tool = createDocumentSkillExecuteTool()

    await expect(tool.execute({
      kind: 'pptx',
      operation: 'from-json',
      content: '{"slides":[]}',
      outputPath: 'empty.pptx'
    }, context())).resolves.toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('supported operations: inspect, replace') }
    })
    await expect(tool.execute({
      kind: 'pptx',
      operation: 'from-json',
      args: ['--input', '{"slides":[{"title":"错误路径"}]}', '--output', 'result.pptx']
    }, context())).resolves.toMatchObject({
      isError: true,
      output: { error: expect.stringContaining('supported operations: inspect, replace') }
    })
  })

  it('rejects PDF conversion without explicit DOCX input and PDF output', async () => {
    const tool = createDocumentSkillExecuteTool()
    await expect(tool.execute({
      kind: 'pdf',
      operation: 'from-docx',
      args: ['--input', 'report.docx']
    }, context())).resolves.toMatchObject({
      isError: true,
      output: { error: 'pdf/from-docx requires args containing --input and --output' }
    })
  })

  it('accepts only application-owned PDF rendering with embedded bundled fonts', () => {
    expect(deterministicPdfPayloadError({
      status: 'ok',
      converter: 'legalwork-reportlab-bundled',
      verification: {
        songti_embedded: true,
        font_program_embedded: true,
        external_office_used: false
      }
    })).toBeUndefined()
    expect(deterministicPdfPayloadError({
      status: 'ok',
      converter: 'LibreOffice',
      verification: { songti_embedded: true, font_program_embedded: true }
    })).toContain('untrusted external converter')
    expect(deterministicPdfPayloadError({
      status: 'ok',
      converter: 'legalwork-reportlab-bundled',
      verification: { songti_embedded: true, external_office_used: false }
    })).toContain('bundled Chinese font was embedded')
  })

  it('returns the valid operation list instead of leaving the model to probe repeatedly', async () => {
    const tool = createDocumentSkillExecuteTool()
    const result = await tool.execute({ kind: 'docx', operation: 'help' }, context())
    const output = result.output as Record<string, unknown>

    expect(result.isError).toBe(true)
    expect(output.error).toContain('supported operations: inspect, normalize, page, replace, from-markdown')
  })

  it('rejects incomplete and conflicting one-call Word arguments before starting the worker', async () => {
    const tool = createDocumentSkillExecuteTool()

    await expect(tool.execute({
      kind: 'docx',
      operation: 'from-markdown'
    }, context())).resolves.toMatchObject({ isError: true })
    await expect(tool.execute({
      kind: 'docx',
      operation: 'from-markdown',
      content: '   ',
      outputPath: 'empty.docx'
    }, context())).resolves.toMatchObject({
      isError: true,
      output: { error: 'content must not be empty for inline document creation' }
    })
    await expect(tool.execute({
      kind: 'docx',
      operation: 'from-markdown',
      content: '# 正文',
      outputPath: 'result.docx',
      args: ['--input', 'other.md']
    }, context())).resolves.toMatchObject({
      isError: true,
      output: { error: 'args cannot be combined with inline content; use content, outputPath, and profile only' }
    })
  })

  it('rejects model-visible history placeholders before overwriting a Word file', async () => {
    const tool = createDocumentSkillExecuteTool()
    const result = await tool.execute({
      kind: 'docx',
      operation: 'from-markdown',
      content:
        '[cache hygiene: omitted completed document_skill_execute.content argument, 14.3KB, approx 4963 token(s); see following tool result] preview="# 文献综述"',
      outputPath: 'result.docx',
      profile: 'academic'
    }, context())

    expect(result).toMatchObject({
      isError: true,
      output: {
        status: 'error',
        error: expect.stringContaining('history/cache-hygiene placeholder')
      }
    })
    await expect(readFile(join(workspace, 'result.docx'))).rejects.toThrow()
  })

  it('keeps relative inline output inside the thread workspace', async () => {
    await expect(prepareDocumentWorkerArgs({
      args: [],
      content: '# 正文',
      outputPath: '../escaped.docx',
      workspace
    })).rejects.toThrow(/inside the thread workspace/)
  })

  function context(): ToolHostContext {
    return {
      threadId: 'thr_test',
      turnId: 'turn_test',
      workspace,
      approvalPolicy: 'auto',
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow'
    }
  }
})
