import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

export type DocumentMaterialExtractionRequest = {
  fileName: string
  mimeType?: string
  dataBase64: string
}

export type DocumentMaterialExtractionResult =
  | { ok: true; content: string }
  | { ok: false; message: string }

type MammothModule = {
  default?: {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value?: string }>
  }
  extractRawText?: (input: { buffer: Buffer }) => Promise<{ value?: string }>
}

type PdfParse = (buffer: Buffer) => Promise<{ text?: string }>

const MEANINGFUL_PDF_TEXT_MIN_CHARS = 30
const OCR_TIMEOUT_MS = 180_000
const OCR_OUTPUT_MAX_BYTES = 20 * 1024 * 1024

function extFromName(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

function decodeBase64(dataBase64: string): Buffer {
  return Buffer.from(dataBase64, 'base64')
}

function meaningfulText(text: string): boolean {
  return text.replace(/\s/g, '').length >= MEANINGFUL_PDF_TEXT_MIN_CHARS
}

function uniqueExistingDirs(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path && existsSync(path)))]
}

function projectRootCandidates(): string[] {
  const cwd = process.cwd()
  const candidates = [
    cwd,
    join(cwd, '..'),
    join(cwd, '..', '..'),
    dirname(cwd),
    process.resourcesPath,
    join(process.resourcesPath ?? '', 'app'),
    join(process.resourcesPath ?? '', 'app.asar.unpacked')
  ]
  return uniqueExistingDirs(candidates)
}

function findOcrAgentPath(): string | null {
  for (const root of projectRootCandidates()) {
    const candidates = [
      join(root, 'ocr_agent.py'),
      join(root, '..', 'ocr_agent.py'),
      join(root, '..', '..', 'ocr_agent.py')
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function pythonCandidates(ocrAgentPath: string): string[] {
  const root = dirname(ocrAgentPath)
  const venvBin = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
  return [
    process.env.LEGALWORK_PYTHON,
    join(root, '.venv', venvBin),
    join(root, 'apps', 'desktop-legalwork', '.venv', venvBin),
    process.platform === 'win32' ? 'python.exe' : 'python3',
    'python'
  ].filter(Boolean) as string[]
}

function ocrRuntimeEnv(ocrAgentPath: string): NodeJS.ProcessEnv {
  const root = dirname(ocrAgentPath)
  const ocrRoots = uniqueExistingDirs([
    join(root, 'ocr-runtime'),
    join(root, 'vendor', 'ocr-runtime'),
    join(root, 'apps', 'desktop-legalwork', 'vendor', 'ocr-runtime'),
    join(process.resourcesPath ?? '', 'ocr-runtime'),
    join(process.resourcesPath ?? '', 'vendor', 'ocr-runtime')
  ])
  const binDirs: string[] = []
  for (const ocrRoot of ocrRoots) {
    binDirs.push(
      join(ocrRoot, `${process.platform}-${process.arch}`, 'bin'),
      join(ocrRoot, 'bin')
    )
  }
  const paddleModelRoot = ocrRoots
    .map((ocrRoot) => join(ocrRoot, 'paddle-models'))
    .find((candidate) => existsSync(candidate))
  const tessdataDir = ocrRoots
    .flatMap((ocrRoot) => [
      join(ocrRoot, `${process.platform}-${process.arch}`, 'share', 'tessdata'),
      join(ocrRoot, 'share', 'tessdata'),
      join(ocrRoot, 'tessdata')
    ])
    .find((candidate) => existsSync(candidate))

  return {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    ...(ocrRoots[0] ? { LEGALWORK_OCR_ROOT: ocrRoots[0] } : {}),
    ...(paddleModelRoot ? { LEGALWORK_PADDLEOCR_MODEL_ROOT: paddleModelRoot } : {}),
    ...(tessdataDir && !process.env.TESSDATA_PREFIX ? { TESSDATA_PREFIX: tessdataDir } : {}),
    PATH: [process.env.PATH ?? '', ...uniqueExistingDirs(binDirs)].filter(Boolean).join(delimiter)
  }
}

function parseOcrJson(stdout: string): Record<string, unknown> | null {
  const start = stdout.lastIndexOf('\n{')
  const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout.slice(stdout.indexOf('{'))).trim()
  if (!jsonText.startsWith('{')) return null
  try {
    return JSON.parse(jsonText) as Record<string, unknown>
  } catch {
    return null
  }
}

async function runOcrAgent(pdfPath: string): Promise<{ text: string; engine?: string; confidence?: number }> {
  const ocrAgentPath = findOcrAgentPath()
  if (!ocrAgentPath) {
    throw new Error('未找到本地 OCR Agent，无法自动识别扫描版 PDF。')
  }

  let lastError = ''
  for (const python of pythonCandidates(ocrAgentPath)) {
    const result = await new Promise<
      | { ok: true; stdout: string }
      | { ok: false; message: string }
    >((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const child = spawn(python, [ocrAgentPath, 'auto', pdfPath], {
        cwd: dirname(ocrAgentPath),
        env: ocrRuntimeEnv(ocrAgentPath),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        resolve({ ok: false, message: 'OCR 超时，请稍后重试或先手动 OCR。' })
      }, OCR_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < OCR_OUTPUT_MAX_BYTES) stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < OCR_OUTPUT_MAX_BYTES) stderr += chunk.toString('utf8')
      })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, message: error.message })
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) {
          resolve({ ok: true, stdout })
          return
        }
        resolve({ ok: false, message: stderr.trim() || stdout.trim() || `OCR 进程退出码 ${code}` })
      })
    })

    if (!result.ok) {
      lastError = result.message
      continue
    }

    const parsed = parseOcrJson(result.stdout)
    const success = parsed?.success === true
    const text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
    if (success && text) {
      return {
        text,
        engine: typeof parsed?.engine === 'string' ? parsed.engine : undefined,
        confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : undefined
      }
    }
    lastError = typeof parsed?.error === 'string' ? parsed.error : 'OCR 未识别到文本'
  }

  throw new Error(lastError || 'OCR 执行失败。')
}

async function extractScannedPdfWithOcr(fileName: string, buffer: Buffer): Promise<DocumentMaterialExtractionResult> {
  const dir = await mkdtemp(join(tmpdir(), 'legalwork-document-ocr-'))
  const pdfPath = join(dir, fileName.replace(/[\\/]/g, '_') || 'material.pdf')
  try {
    await writeFile(pdfPath, buffer)
    const result = await runOcrAgent(pdfPath)
    const confidenceText =
      typeof result.confidence === 'number' ? `，置信度：${Math.round(result.confidence * 100)}%` : ''
    return {
      ok: true,
      content: `【OCR识别文本；引擎：${result.engine ?? 'unknown'}${confidenceText}】\n\n${result.text}`
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function extractDocumentMaterial(
  request: DocumentMaterialExtractionRequest
): Promise<DocumentMaterialExtractionResult> {
  const ext = extFromName(request.fileName)
  const buffer = decodeBase64(request.dataBase64)

  try {
    if (['txt', 'md', 'markdown', 'csv', 'json', 'html', 'xml'].includes(ext)) {
      return { ok: true, content: buffer.toString('utf8') }
    }

    if (ext === 'docx') {
      const mammoth = await import('mammoth') as MammothModule
      const extractRawText = mammoth.extractRawText ?? mammoth.default?.extractRawText
      if (!extractRawText) {
        return { ok: false, message: '当前环境缺少 docx 文本解析能力。' }
      }
      const result = await extractRawText({ buffer })
      const content = result.value?.trim() ?? ''
      if (!content) return { ok: false, message: '未能从 docx 材料中提取到文字。' }
      return { ok: true, content }
    }

    if (ext === 'pdf') {
      try {
        const pdfModule = await import('pdf-parse') as { default?: PdfParse }
        const parse = pdfModule.default
        if (parse) {
          const result = await parse(buffer)
          const content = result.text?.trim() ?? ''
          if (meaningfulText(content)) return { ok: true, content }
        }
      } catch {
        // Fall through to OCR. Some scanned PDFs or damaged text layers make
        // text extraction fail before we can determine whether OCR is needed.
      }
      return extractScannedPdfWithOcr(request.fileName, buffer)
    }

    return { ok: false, message: '该材料格式暂不能作为文书事实来源，请上传 txt、md、docx 或可复制文字的 PDF。' }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
