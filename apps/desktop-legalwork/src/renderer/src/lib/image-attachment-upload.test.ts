import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  arrayBufferToBase64,
  isMissingAttachmentFilePathError,
  prepareAttachmentUpload,
  prepareImageAttachmentUpload,
  resolveAttachmentUploadName,
  uploadAttachmentWithMemoryFallback,
  type EncodedAttachmentImage
} from './image-attachment-upload'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('image attachment upload preparation', () => {
  it('recognizes the in-memory clipboard file path error for base64 fallback', () => {
    expect(isMissingAttachmentFilePathError(new Error('无法读取所选文件路径'))).toBe(true)
    expect(isMissingAttachmentFilePathError(new Error('Unable to read selected file path'))).toBe(true)
    expect(isMissingAttachmentFilePathError(new Error('attachment is too large'))).toBe(false)
  })

  it('gives unnamed clipboard images a MIME-derived file extension for OCR', () => {
    const file = new File([new Uint8Array([1])], '', { type: 'image/webp' })
    expect(resolveAttachmentUploadName(file)).toBe('pasted-image.webp')
  })

  it('falls back to an in-memory upload for a pasted image without a disk path', async () => {
    const close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 10,
      height: 8,
      close
    })))
    vi.stubGlobal('document', {})
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'pasted-image.png', {
      type: 'image/png'
    })
    const uploadAttachmentFile = vi.fn(async () => {
      throw new Error('无法读取所选文件路径')
    })
    const uploadAttachment = vi.fn(async () => ({ id: 'att_pasted' }))

    const result = await uploadAttachmentWithMemoryFallback(
      file,
      {
        maxImageBytes: 5 * 1024 * 1024,
        maxImageDimension: 4096,
        textFallbackMaxBase64Bytes: 512 * 1024,
        textFallbackMaxImageDimension: 1280
      },
      { uploadAttachmentFile, uploadAttachment },
      { name: file.name, mimeType: file.type, workspace: '/workspace' }
    )

    expect(uploadAttachmentFile).toHaveBeenCalledOnce()
    expect(uploadAttachment).toHaveBeenCalledWith(expect.objectContaining({
      name: 'pasted-image.png',
      mimeType: 'image/png',
      workspace: '/workspace',
      dataBase64: 'AQIDBA=='
    }))
    expect(result.attachment).toEqual({ id: 'att_pasted' })
    expect(result.prepared?.previewUrl).toBe('data:image/png;base64,AQIDBA==')
    expect(close).toHaveBeenCalledOnce()
  })

  it('prepares arbitrary files without image canvas encoding', async () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const prepared = await prepareAttachmentUpload(file, {
      maxImageBytes: 100,
      maxImageDimension: 100,
      textFallbackMaxBase64Bytes: 100
    })

    expect(prepared).toMatchObject({
      dataBase64: 'aGVsbG8=',
      mimeType: 'text/plain',
      textFallback: {
        dataBase64: 'aGVsbG8=',
        mimeType: 'text/plain',
        byteSize: 5,
        wasCompressed: false
      }
    })
    expect(prepared.previewUrl).toBeUndefined()
  })

  it('accepts unknown binary file types when the runtime advertises the */* wildcard', async () => {
    const file = new File([new Uint8Array([0, 1, 2])], 'evidence.custombin', {
      type: 'application/octet-stream'
    })
    const prepared = await prepareAttachmentUpload(file, {
      maxImageBytes: 100,
      maxImageDimension: 100,
      allowedMimeTypes: ['*/*'],
      textFallbackMaxBase64Bytes: 100
    })

    expect(prepared).toMatchObject({
      dataBase64: 'AAEC',
      mimeType: 'application/octet-stream',
      textFallback: {
        dataBase64: 'AAEC',
        mimeType: 'application/octet-stream',
        byteSize: 3,
        wasCompressed: false
      }
    })
  })

  it('infers PDF MIME type from the file name when the drag payload omits it', async () => {
    const file = new File(['%PDF'], 'contract.pdf', { type: '' })
    const prepared = await prepareAttachmentUpload(file, {
      maxImageBytes: 100,
      maxImageDimension: 100,
      allowedMimeTypes: ['application/pdf'],
      textFallbackMaxBase64Bytes: 100
    })

    expect(prepared).toMatchObject({
      dataBase64: 'JVBERg==',
      mimeType: 'application/pdf',
      textFallback: {
        dataBase64: 'JVBERg==',
        mimeType: 'application/pdf',
        byteSize: 4,
        wasCompressed: false
      }
    })
  })

  it('rejects arbitrary files before upload when the runtime MIME list does not allow them', async () => {
    const file = new File(['%PDF'], 'contract.pdf', { type: '' })

    await expect(prepareAttachmentUpload(file, {
      maxImageBytes: 100,
      maxImageDimension: 100,
      allowedMimeTypes: ['image/*'],
      textFallbackMaxBase64Bytes: 100
    })).rejects.toThrow(/application\/pdf/)
  })

  it('omits oversized arbitrary file text fallback while keeping upload data', async () => {
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const prepared = await prepareAttachmentUpload(file, {
      maxImageBytes: 100,
      maxImageDimension: 100,
      textFallbackMaxBase64Bytes: 4
    })

    expect(prepared.dataBase64).toBe('aGVsbG8=')
    expect(prepared.textFallback).toBeUndefined()
  })

  it('reuses one bitmap decode for upload and text fallback preparation', async () => {
    const close = vi.fn()
    const createImageBitmap = vi.fn(async () => ({
      width: 10,
      height: 8,
      close
    }))
    const toBlob = vi.fn()
    const drawImage = vi.fn()
    const createElement = vi.fn(() => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob
    }))
    vi.stubGlobal('createImageBitmap', createImageBitmap)
    vi.stubGlobal('document', { createElement })

    const file = new File([new Uint8Array([1, 2, 3, 4])], 'shot.png', { type: 'image/png' })
    const prepared = await prepareImageAttachmentUpload(file, {
      maxImageBytes: 100,
      maxImageDimension: 100,
      textFallbackMaxBase64Bytes: 100,
      textFallbackMaxImageDimension: 100,
      textFallbackPreferredMimeType: 'image/webp'
    })

    expect(createImageBitmap).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(createElement).not.toHaveBeenCalled()
    expect(toBlob).not.toHaveBeenCalled()
    expect(prepared).toMatchObject({
      dataBase64: 'AQIDBA==',
      mimeType: 'image/png',
      textFallback: {
        dataBase64: 'AQIDBA==',
        mimeType: 'image/png',
        byteSize: 4,
        width: 10,
        height: 8,
        wasCompressed: false
      }
    })
  })

  it('keeps custom encoders compatible by calling them for each variant', async () => {
    const encoded = (wasCompressed: boolean): EncodedAttachmentImage => ({
      dataBase64: wasCompressed ? 'ZmFsbGJhY2s=' : 'dXBsb2Fk',
      mimeType: 'image/webp',
      byteSize: wasCompressed ? 8 : 6,
      width: 4,
      height: 3,
      wasCompressed
    })
    const encoder = vi.fn(async (_file: File, options) =>
      encoded(Boolean(options.maxBase64Bytes))
    )
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })

    const prepared = await prepareImageAttachmentUpload(file, {
      maxImageBytes: 100,
      maxImageDimension: 100,
      textFallbackMaxBase64Bytes: 64,
      textFallbackMaxImageDimension: 32,
      textFallbackPreferredMimeType: 'image/webp'
    }, encoder)

    expect(encoder).toHaveBeenCalledTimes(2)
    expect(encoder.mock.calls[0]?.[1]).toMatchObject({
      maxDecodedBytes: 100,
      maxDimension: 100
    })
    expect(encoder.mock.calls[1]?.[1]).toMatchObject({
      maxBase64Bytes: 64,
      maxDimension: 32
    })
    expect(prepared).toMatchObject({
      dataBase64: 'dXBsb2Fk',
      textFallback: {
        dataBase64: 'ZmFsbGJhY2s=',
        wasCompressed: true
      }
    })
  })

  it('rejects when no compressed text fallback can fit', async () => {
    const encoder = vi.fn(async (_file: File, options) => {
      if (options.maxBase64Bytes) return null
      return {
        dataBase64: 'dXBsb2Fk',
        mimeType: 'image/webp',
        byteSize: 6,
        width: 4,
        height: 3,
        wasCompressed: true
      }
    })
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })

    await expect(prepareImageAttachmentUpload(file, {
      maxImageBytes: 100,
      maxImageDimension: 100,
      textFallbackMaxBase64Bytes: 4,
      textFallbackMaxImageDimension: 32,
      textFallbackPreferredMimeType: 'image/webp'
    }, encoder)).rejects.toThrow(/text-only model fallback/)
  })

  it('encodes large array buffers without relying on one giant string conversion', () => {
    const bytes = new Uint8Array(100_000)
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251

    const expected = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    expect(arrayBufferToBase64(bytes.buffer)).toBe(expected)
  })
})
