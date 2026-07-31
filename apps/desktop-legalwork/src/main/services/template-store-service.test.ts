import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  deleteTemplate,
  readTemplateSource,
  saveTemplate,
  saveTemplateSource,
  setTemplatesBaseDir
} from './template-store-service'

let tempDir = ''

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

describe('template source storage', () => {
  it('stores, verifies and removes an original DOCX package', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'legalwork-template-store-'))
    setTemplatesBaseDir(tempDir)
    const original = Buffer.from('PK fake docx fixture')
    const source = await saveTemplateSource({
      templateId: 'custom-1',
      fileName: '客户模板.docx',
      dataBase64: original.toString('base64')
    })
    expect(source.ok).toBe(true)
    if (!source.ok) return

    const template = {
      id: 'custom-1',
      name: '客户模板',
      description: '用户上传模板',
      category: 'custom' as const,
      content: '正文',
      fields: [],
      sourceFile: '客户模板.docx',
      sourceDocument: {
        storedFileName: source.storedFileName,
        sha256: source.sha256
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    expect(await saveTemplate(template)).toEqual({ ok: true })
    expect(await readTemplateSource(template)).toEqual(original)
    expect(await deleteTemplate(template.id)).toEqual({ ok: true })
    await expect(readTemplateSource(template)).rejects.toThrow()
  })
})
