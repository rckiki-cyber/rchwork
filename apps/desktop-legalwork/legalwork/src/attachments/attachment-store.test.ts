import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentsCapabilityConfig } from '../contracts/capabilities.js'
import { FileAttachmentStore } from './attachment-store.js'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'legalwork-attachments-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('FileAttachmentStore', () => {
  it('materializes uploaded files with their original extension for tool access', async () => {
    const rootDir = await makeTempDir()
    const store = new FileAttachmentStore({
      rootDir,
      config: AttachmentsCapabilityConfig.parse({ enabled: true })
    })
    const data = Buffer.from('%PDF-1.7\n')

    const created = await store.create({
      name: '[OCR]_行政判决书.layered.pdf',
      mimeType: 'application/pdf',
      data,
      threadId: 'thread_1'
    })
    const resolved = await store.resolveContent(created.id, { threadId: 'thread_1' })

    expect(resolved.localFilePath).toMatch(/\.pdf$/)
    expect(resolved.localFilePath).toContain(created.id)
    await expect(readFile(resolved.localFilePath!)).resolves.toEqual(data)
  })
})
