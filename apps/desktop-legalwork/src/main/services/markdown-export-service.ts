import { extname } from 'node:path'
import type {
  MarkdownDocumentExportPayload,
  MarkdownDocumentExportResult
} from '../../shared/ds-gui-api'

type SaveDialogOptions = {
  title: string
  defaultPath: string
  filters: Array<{ name: string; extensions: string[] }>
}

type MarkdownExportDependencies = {
  showSaveDialog: (options: SaveDialogOptions) => Promise<{
    canceled: boolean
    filePath?: string
  }>
  writeFile: (path: string, content: string, encoding: 'utf8') => Promise<unknown>
}

export function sanitizeMarkdownExportName(defaultName: string): string {
  return defaultName.replace(/[<>:"/\\|?*]/g, '_')
}

export function ensureMarkdownExtension(path: string): string {
  const extension = extname(path).toLowerCase()
  return extension === '.md' || extension === '.markdown' ? path : `${path}.md`
}

export async function exportMarkdownDocument(
  payload: MarkdownDocumentExportPayload,
  dependencies: MarkdownExportDependencies
): Promise<MarkdownDocumentExportResult> {
  try {
    const result = await dependencies.showSaveDialog({
      title: '导出 Markdown',
      defaultPath: `${sanitizeMarkdownExportName(payload.defaultName)}.md`,
      filters: [{ name: 'Markdown 文档', extensions: ['md', 'markdown'] }]
    })
    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true }
    }

    const targetPath = ensureMarkdownExtension(result.filePath)
    await dependencies.writeFile(targetPath, payload.markdown, 'utf8')
    return { ok: true, path: targetPath }
  } catch (error) {
    return {
      ok: false,
      canceled: false,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}
