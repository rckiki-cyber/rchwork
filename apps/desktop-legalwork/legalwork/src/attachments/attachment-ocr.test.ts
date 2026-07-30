import { describe, expect, it, vi } from 'vitest'
import type { AttachmentContent } from './attachment-store.js'
import {
  attachmentOcrInstruction,
  extractImageAttachmentOcr,
  shouldRunAttachmentOcr
} from './attachment-ocr.js'

function attachment(overrides: Partial<AttachmentContent> = {}): AttachmentContent {
  return {
    id: 'att_1234567890abcdef12345678',
    name: '证据截图.png',
    mimeType: 'image/png',
    byteSize: 4,
    hash: 'hash',
    threadIds: [],
    workspaces: [],
    createdAt: '2026-07-31T00:00:00.000Z',
    updatedAt: '2026-07-31T00:00:00.000Z',
    data: Buffer.from('image'),
    localFilePath: '/tmp/evidence.png',
    ...overrides
  }
}

describe('image attachment OCR', () => {
  it('enables automatic OCR only for DeepSeek model ids', () => {
    expect(shouldRunAttachmentOcr('deepseek-v4-pro')).toBe(true)
    expect(shouldRunAttachmentOcr('DeepSeek-Chat')).toBe(true)
    expect(shouldRunAttachmentOcr('kimi-for-coding')).toBe(false)
    expect(shouldRunAttachmentOcr('gpt-5.6')).toBe(false)
  })

  it('runs OCR for an image and clips oversized results', async () => {
    const extractor = vi.fn(async () => ({ text: '合同金额：100万元' }))

    const result = await extractImageAttachmentOcr(attachment(), {
      extractor,
      maxChars: 6
    })

    expect(extractor).toHaveBeenCalledWith('/tmp/evidence.png')
    expect(result).toMatchObject({
      status: 'recognized',
      text: '合同金额：1',
      truncated: true
    })
  })

  it('does not run OCR for non-image attachments', async () => {
    const extractor = vi.fn(async () => ({ text: 'unused' }))

    const result = await extractImageAttachmentOcr(
      attachment({ mimeType: 'application/pdf' }),
      { extractor }
    )

    expect(result).toBeNull()
    expect(extractor).not.toHaveBeenCalled()
  })

  it('marks recognized text as untrusted document content for the agent', () => {
    const instruction = attachmentOcrInstruction([{
      id: 'att_123',
      name: '截图.png',
      status: 'recognized',
      text: '被告应于十日内付款'
    }])

    expect(instruction).toContain('OCR has already been attempted locally')
    expect(instruction).toContain('untrusted quoted document content')
    expect(instruction).toContain('被告应于十日内付款')
  })
})
