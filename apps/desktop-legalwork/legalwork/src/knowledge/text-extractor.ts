import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

const execFileAsync = promisify(execFile)
const MIN_TEXT_BEFORE_OCR = 40
const OCR_OUTPUT_BUFFER_BYTES = 1024 * 1024 * 1024

export const EXTRACTABLE_EXTENSIONS = new Set([
  '.pdf',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.xlsx',
  '.xls',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif'
])

/**
 * Extract plain text from common binary document formats.
 * Falls back to empty string when extraction fails or the format is unsupported.
 */
export async function extractDocumentText(filePath: string): Promise<string> {
  const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  try {
    if (extension === '.pdf') {
      return await extractPdfText(filePath)
    }
    if (extension === '.docx' || extension === '.doc') {
      return await extractDocxText(filePath)
    }
    if (extension === '.pptx') {
      return await extractPptxText(filePath)
    }
    if (extension === '.ppt') {
      return await extractTextutilText(filePath)
    }
    if (extension === '.xlsx' || extension === '.xls') {
      return await extractXlsxText(filePath)
    }
    if (isOcrImageExtension(extension)) {
      return await extractOcrText(filePath)
    }
  } catch {
    // Extraction failures are treated as unindexable content.
  }
  return ''
}

async function extractPdfText(filePath: string): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  const buffer = await readFile(filePath)
  const parser = new PDFParse({ data: buffer })
  try {
    const result = await parser.getText()
    const text = normalizeExtractedText(result.text)
    if (text.length >= MIN_TEXT_BEFORE_OCR) return text
    return await extractOcrText(filePath)
  } finally {
    await parser.destroy()
  }
}

async function extractDocxText(filePath: string): Promise<string> {
  if (filePath.toLowerCase().endsWith('.doc')) {
    const converted = await extractTextutilText(filePath)
    if (converted) return converted
  }
  const { default: mammoth } = await import('mammoth')
  const buffer = await readFile(filePath)
  const result = await mammoth.extractRawText({ buffer })
  return normalizeExtractedText(result.value)
}

async function extractPptxText(filePath: string): Promise<string> {
  const buffer = await readFile(filePath)
  const entries = readZipEntries(buffer)
  const slideEntries = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => naturalNameCompare(a.name, b.name))
  const noteEntries = entries
    .filter((entry) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => naturalNameCompare(a.name, b.name))
  const lines: string[] = []
  for (const entry of [...slideEntries, ...noteEntries]) {
    const text = extractOfficeXmlText(entry.data.toString('utf8'))
    if (text) lines.push(text)
  }
  return normalizeExtractedText(lines.join('\n\n'))
}

async function extractXlsxText(filePath: string): Promise<string> {
  const { readFile: readXlsx, utils } = await import('xlsx')
  const workbook = readXlsx(filePath)
  const lines: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    if (!sheet) continue
    const json = utils.sheet_to_json(sheet, { header: 1 }) as unknown[][]
    for (const row of json) {
      const cells = row.filter((cell): cell is string | number => cell !== undefined && cell !== null)
      if (cells.length > 0) lines.push(cells.join(' '))
    }
  }
  return normalizeExtractedText(lines.join('\n'))
}

async function extractTextutilText(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('textutil', ['-convert', 'txt', '-stdout', filePath], {
      maxBuffer: OCR_OUTPUT_BUFFER_BYTES
    })
    return normalizeExtractedText(stdout)
  } catch {
    return ''
  }
}

type ZipEntry = {
  name: string
  data: Buffer
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset < 0) return []
  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  let offset = buffer.readUInt32LE(eocdOffset + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const nameStart = offset + 46
    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString('utf8')
    const data = readZipEntryData(buffer, localHeaderOffset, compressedSize, method)
    if (data) entries.push({ name, data })
    offset = nameStart + fileNameLength + extraLength + commentLength
  }
  return entries
}

function readZipEntryData(
  buffer: Buffer,
  localHeaderOffset: number,
  compressedSize: number,
  method: number
): Buffer | null {
  if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    return null
  }
  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28)
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength
  const dataEnd = dataStart + compressedSize
  if (dataEnd > buffer.length) return null
  const compressed = buffer.subarray(dataStart, dataEnd)
  if (method === 0) return Buffer.from(compressed)
  if (method === 8) return inflateRawSync(compressed)
  return null
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minOffset = Math.max(0, buffer.length - 65557)
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function extractOfficeXmlText(xml: string): string {
  const values: string[] = []
  const textRegex = /<(?:a:)?t\b[^>]*>([\s\S]*?)<\/(?:a:)?t>/g
  for (const match of xml.matchAll(textRegex)) {
    const value = decodeXmlText(match[1] ?? '').trim()
    if (value) values.push(value)
  }
  return values.join('\n')
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function naturalNameCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

async function extractOcrText(filePath: string): Promise<string> {
  const script = String.raw`
import json
import os
import sys

path = sys.argv[1]
lang = os.environ.get("LEGALWORK_OCR_LANG", "chi_sim+eng")
texts = []

def ocr_image(image):
    import pytesseract
    try:
        return pytesseract.image_to_string(image, lang=lang)
    except Exception:
        return pytesseract.image_to_string(image, lang="eng")

try:
    suffix = os.path.splitext(path)[1].lower()
    if suffix == ".pdf":
        import fitz
        doc = fitz.open(path)
        for page in doc:
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            try:
                from PIL import Image
                image = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                text = ocr_image(image)
            finally:
                pix = None
            if text.strip():
                texts.append(text)
    else:
        from PIL import Image
        with Image.open(path) as image:
            texts.append(ocr_image(image))
    print(json.dumps({"ok": True, "text": "\n\n".join(texts)}, ensure_ascii=False))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
`
  try {
    const { stdout } = await execFileAsync(process.env.PYTHON || process.env.PYTHON3 || 'python3', ['-c', script, filePath], {
      maxBuffer: OCR_OUTPUT_BUFFER_BYTES
    })
    const parsed = JSON.parse(stdout.trim() || '{}') as { ok?: boolean; text?: string }
    return parsed.ok && parsed.text ? normalizeExtractedText(parsed.text) : ''
  } catch {
    return ''
  }
}

function isOcrImageExtension(extension: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tiff', '.tif'].includes(extension)
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(new RegExp(`[${String.fromCharCode(0)}\\u200B-\\u200D\\uFEFF]`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
