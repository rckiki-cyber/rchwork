import { basename, extname } from 'node:path'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from './truncate.js'

/**
 * read 工具单次返回的默认字节上限（16KB ≈ 4K token）。
 * 对标 DSH 的小块读：更小的单次读取 → 模型多次小块读 → 前缀复用率高、命中率高、成本低。
 * （默认 50KB/8K token 的一次大读会注入大量新内容，拉低复用。）
 */
const READ_DEFAULT_MAX_BYTES = 16_000
import type { ReadLocalToolOptions, TextSlice } from './builtin-tool-types.js'
import { defaultReadLocalToolOperations } from './builtin-tool-operations.js'
import { EXTRACTABLE_EXTENSIONS } from '../../knowledge/text-extractor.js'
import { buildDocumentMap, renderDocumentMapText } from '../../knowledge/document-map.js'
import {
  formatDimensionNote,
  getReadClassification,
  isBinaryBuffer,
  normalizePositiveInteger,
  resolveWorkspacePath,
  withToolBoundary
} from './builtin-tool-utils.js'

export function createReadLocalTool(options: ReadLocalToolOptions = {}): LocalTool {
  const statOp = options.operations?.stat ?? defaultReadLocalToolOperations.stat!
  const readFileOp = options.operations?.readFile ?? defaultReadLocalToolOperations.readFile!
  const extractDocumentTextOp =
    options.operations?.extractDocumentText ?? defaultReadLocalToolOperations.extractDocumentText!
  const detectImageMimeTypeOp =
    options.operations?.detectImageMimeType ?? defaultReadLocalToolOperations.detectImageMimeType!
  const resizeImageOp = options.operations?.resizeImage
  const autoResizeImages = options.autoResizeImages ?? true
  return LocalToolHost.defineTool({
    name: 'read',
    description: 'Read a file from the local filesystem. Relative paths resolve against the current workspace; absolute paths may point anywhere on the computer. Supports optional line offset and limit for large files, and extracts text from PDF/DOCX/XLSX documents when possible.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
        structure: { type: 'boolean' },
        charStart: { type: 'number' },
        charLen: { type: 'number' }
      },
      required: ['path'],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = typeof args.path === 'string' ? args.path : ''
      if (!rawPath.trim()) return { output: { error: 'path is required' }, isError: true }
      const { absolutePath, relativePath } = resolveWorkspacePath(rawPath, context)
      await statOp(absolutePath)
      const fileBuffer = await readFileOp(absolutePath)
      const classification = getReadClassification(absolutePath, context.workspace)
      const image = detectImageMimeTypeOp(fileBuffer)
      if (image) {
        if (autoResizeImages && resizeImageOp) {
          const resized = await resizeImageOp(fileBuffer, image.mimeType)
          if (!resized) {
            return {
              output: {
                path: absolutePath,
                relative_path: relativePath,
                kind: 'image',
                mime_type: image.mimeType,
                width: image.width ?? null,
                height: image.height ?? null,
                byte_size: fileBuffer.length,
                note: `Read image file [${image.mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]`,
                classification: classification ?? null
              }
            }
          }
          const dimensionNote = formatDimensionNote(resized)
          return {
            output: {
              path: absolutePath,
              relative_path: relativePath,
              kind: 'image',
              mime_type: resized.mimeType,
              width: resized.width,
              height: resized.height,
              byte_size: fileBuffer.length,
              data_base64: resized.dataBase64,
              note: dimensionNote
                ? `Read image file [${resized.mimeType}]\n${dimensionNote}`
                : `Read image file [${resized.mimeType}]`,
              classification: classification ?? null,
              resized: resized.wasResized === true
            }
          }
        }
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            kind: 'image',
            mime_type: image.mimeType,
            width: image.width ?? null,
            height: image.height ?? null,
            byte_size: fileBuffer.length,
            data_base64: fileBuffer.toString('base64'),
            note: `Read image file [${image.mimeType}]`,
            classification: classification ?? null
          }
        }
      }
      const extension = extname(absolutePath).toLowerCase()
      const isExtractableDocument = EXTRACTABLE_EXTENSIONS.has(extension)
      if (isBinaryBuffer(fileBuffer) && !isExtractableDocument) {
        return { output: { error: 'read only supports text files, images, and extractable documents in Legalwork serve mode', path: absolutePath }, isError: true }
      }
      const extracted = isExtractableDocument
        ? await extractDocumentTextOp(absolutePath)
        : { text: fileBuffer.toString('utf8').replace(/\r\n/g, '\n') }
      const text = typeof extracted === 'string' ? extracted : extracted.text
      if (isExtractableDocument && !text.trim()) {
        return {
          output: {
            error: 'document text extraction returned no readable text',
            hint: 'This is likely a scanned (image-based) document with no text layer. Try: (1) convert each page to an image and read the image, or (2) ask the user to upload the scanned page images / provide the text version. Do not keep retrying read on the same file.',
            path: absolutePath
          },
          isError: true
        }
      }
      if (args.structure === true) {
        const map = buildDocumentMap(text)
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            content: renderDocumentMapText(map, basename(absolutePath), text.length),
            kind: 'document_map',
            total_lines: map.totalLines,
            total_chars: map.totalChars,
            content_start_line: map.contentStartLine,
            section_count: map.sections.length,
            no_headings: map.noHeadings
          }
        }
      }
      const allLines = text.split('\n')
      const offset = Math.max(1, normalizePositiveInteger(args.offset, 1))
      const effectiveMaxLines = options.maxLines ?? DEFAULT_MAX_LINES
      const effectiveMaxBytes = options.maxBytes ?? READ_DEFAULT_MAX_BYTES
      const limit = normalizePositiveInteger(args.limit, effectiveMaxLines)
      const selected = allLines.slice(offset - 1, offset - 1 + limit).join('\n')
      // 字符范围读取：对 OCR 超长行（单行数千字符）支持 charStart/charLen 小段读取，
      // 对齐 DSH 模型用 awk substr 做字符级读取的用法，避免一次注入整行超大内容。
      if (args.charStart !== undefined) {
        const charStart = Math.max(1, normalizePositiveInteger(args.charStart, 1))
        const charLen = Math.max(1, normalizePositiveInteger(args.charLen, 2_000))
        const charContent = selected.slice(charStart - 1, charStart - 1 + charLen)
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            content: charContent,
            kind: isExtractableDocument ? 'document_text' : 'text',
            start_line: offset,
            end_line: Math.max(offset, offset + limit - 1),
            char_start: charStart,
            char_end: charStart + charContent.length - 1,
            total_lines: allLines.length
          }
        }
      }
      const truncatedResult = truncateHead(selected, {
        maxLines: effectiveMaxLines,
        maxBytes: effectiveMaxBytes
      })
      const truncated: TextSlice = {
        text: truncatedResult.content,
        truncated: truncatedResult.truncated,
        totalLines: truncatedResult.totalLines,
        shownLines: truncatedResult.outputLines,
        totalBytes: truncatedResult.totalBytes,
        shownBytes: truncatedResult.outputBytes,
        firstLineExceedsLimit: truncatedResult.firstLineExceedsLimit,
        truncatedBy: truncatedResult.truncatedBy ?? undefined,
        lastLinePartial: truncatedResult.lastLinePartial
      }
      let content = truncated.text
      if (truncated.firstLineExceedsLimit) {
        content = `[first line exceeds ${formatSize(effectiveMaxBytes)} at line ${offset}. Use bash for a byte-limited slice of this line.]`
      } else if (truncated.truncated) {
        const endLine = Math.max(offset, offset + truncated.shownLines - 1)
        const nextOffset = endLine + 1
        if (truncated.truncatedBy === 'lines') {
          content = `${truncated.text}\n\n[showing lines ${offset}-${endLine} of ${allLines.length}. Use offset=${nextOffset} to continue.]`
        } else {
          content = `${truncated.text}\n\n[showing lines ${offset}-${endLine} of ${allLines.length} (${formatSize(effectiveMaxBytes)} limit). Use offset=${nextOffset} to continue.]`
        }
      } else if (limit !== undefined && offset - 1 + limit < allLines.length) {
        const nextOffset = offset + limit
        const remaining = allLines.length - (offset - 1 + limit)
        content = `${truncated.text}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          content,
          kind: isExtractableDocument ? 'document_text' : 'text',
          extension: isExtractableDocument ? extension : undefined,
          classification: classification ?? null,
          start_line: offset,
          end_line: Math.max(offset, offset + truncated.shownLines - 1),
          total_lines: allLines.length,
          truncated: truncated.truncated,
          truncation_by: truncated.truncatedBy ?? null,
          first_line_exceeds_limit: truncated.firstLineExceedsLimit === true
        }
      }
    })
  })
}

export const createReadTool = createReadLocalTool
export const createReadToolDefinition = createReadLocalTool
