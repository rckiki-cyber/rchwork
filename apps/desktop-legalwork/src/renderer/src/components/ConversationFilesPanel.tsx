import {
  ArrowLeft,
  Files,
  Loader2,
  PanelRightClose,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { getProvider } from '../agent/registry'
import type { CoreAttachmentContentResponseJson } from '../agent/legalwork-contract'
import type { ConversationFile } from '../lib/conversation-files'
import { FileTypeIcon, fileTypeLabel } from '../lib/file-type-icon'
import { languageFromFilePath } from '../lib/code-highlighting'
import { DocxPreview } from './knowledge-base/DocxPreview'
import { PdfJsPreview } from './knowledge-base/PdfJsPreview'

type Props = {
  files: ConversationFile[]
  activeThreadId: string | null
  workspaceRoot: string
  className?: string
  onClose: () => void
  onOpenWorkspaceFile: (path: string) => void
  /** Attachment to preview on mount (from the floating file list). */
  initialAttachment?: ConversationFile | null
}

export type ConversationFilesFloatingProps = {
  files: ConversationFile[]
  open: boolean
  onClose: () => void
  onOpenFile: (file: ConversationFile) => void
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// Every human-readable extension previews inline as decoded text; anything
// the browser cannot render falls back to a file-info card.
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'jsonl', 'xml',
  'yml', 'yaml', 'html', 'htm', 'log', 'ini', 'conf', 'cfg', 'toml',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java',
  'c', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt', 'sql',
  'css', 'scss', 'less', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'env',
  'gitignore', 'dockerfile', 'vue', 'svelte', 'r', 'lua', 'pl', 'dart',
  'properties', 'gradle', 'tf', 'lock', 'license', 'readme', 'nfo'
])

function attachmentKind(name: string, mimeType: string): 'docx' | 'pdf' | 'image' | 'audio' | 'video' | 'text' | 'other' {
  const lowerName = name.toLowerCase()
  const lowerMime = mimeType.toLowerCase()
  if (lowerName.endsWith('.docx') || lowerMime.includes('wordprocessingml')) return 'docx'
  if (lowerName.endsWith('.pdf') || lowerMime === 'application/pdf') return 'pdf'
  if (lowerMime.startsWith('image/')) return 'image'
  if (lowerMime.startsWith('audio/')) return 'audio'
  if (lowerMime.startsWith('video/')) return 'video'
  const dotIndex = lowerName.lastIndexOf('.')
  const ext = dotIndex > 0 ? lowerName.slice(dotIndex + 1).replace(/^\./, '') : ''
  if (lowerMime.startsWith('text/') || ext === 'csv' || TEXT_EXTENSIONS.has(ext)) return 'text'
  // Office spreadsheets/slides and other binary formats: show info + open locally.
  return 'other'
}

function AttachmentPreview({ content }: { content: CoreAttachmentContentResponseJson }): ReactElement {
  const { attachment, dataBase64 } = content
  const kind = attachmentKind(attachment.name, attachment.mimeType)
  const dataUrl = `data:${attachment.mimeType};base64,${dataBase64}`

  if (kind === 'docx') {
    return <DocxPreview base64Content={dataBase64} fileName={attachment.name} fallbackText="" />
  }
  if (kind === 'pdf') {
    return <PdfJsPreview base64Content={dataBase64} fileName={attachment.name} />
  }
  if (kind === 'image') {
    return (
      <div className="flex min-h-full items-center justify-center bg-ds-subtle/70 p-5">
        <img src={dataUrl} alt={attachment.name} className="max-h-full max-w-full rounded-lg object-contain shadow-sm" />
      </div>
    )
  }
  if (kind === 'audio') {
    return <div className="flex min-h-full items-center justify-center p-6"><audio src={dataUrl} controls className="w-full" /></div>
  }
  if (kind === 'video') {
    return <div className="flex min-h-full items-center justify-center bg-black p-3"><video src={dataUrl} controls className="max-h-full max-w-full" /></div>
  }
  if (kind === 'text') {
    // Decode any text-like file (md/csv/json/code/log/...) and render it
    // with language-aware formatting where a known extension exists.
    const text = new TextDecoder().decode(bytesFromBase64(dataBase64))
    const language = languageFromFilePath(attachment.name)
    return (
      <div className="flex min-h-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-ds-border-muted bg-ds-card/60 px-4 py-2">
          <span className="truncate font-mono text-[11px] text-ds-faint">{attachment.name}</span>
          <span className="shrink-0 rounded bg-ds-subtle px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-ds-muted">
            {language || 'text'}
          </span>
        </div>
        <pre className="min-h-0 flex-1 whitespace-pre-wrap break-words p-5 font-mono text-[12px] leading-6 text-ds-ink">
          {text}
        </pre>
      </div>
    )
  }
  return (
    <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 p-8 text-center">
      <FileTypeIcon name={attachment.name} className="h-12 w-12" />
      <div className="font-medium text-ds-ink">{fileTypeLabel(attachment.name)}</div>
      <div className="text-[12px] text-ds-muted">{attachment.name} · {formatBytes(attachment.byteSize)} · {attachment.mimeType || '未知类型'}</div>
      <div className="text-[12px] leading-6 text-ds-muted">此格式暂不支持内嵌预览，可在文件列表中双击打开，或从右侧栏用本机应用打开。</div>
    </div>
  )
}

function renderFileGroup(
  title: string,
  items: ConversationFile[],
  onOpen: (file: ConversationFile) => void
): ReactElement | null {
  if (!items.length) return null
  return (
    <section>
      <div className="mb-2 flex items-center justify-between px-1 text-[11px] font-semibold text-ds-faint">
        <span>{title}</span><span>{items.length}</span>
      </div>
      <div className="space-y-1">
        {items.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => onOpen(file)}
            className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition hover:bg-ds-hover"
            title={file.kind === 'workspace' ? file.path : file.name}
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-ds-border-muted bg-ds-card shadow-[inset_0_1px_0_rgba(255,255,255,0.55)]">
              <FileTypeIcon name={file.name} className="h-5 w-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ds-ink">{file.name}</span>
              <span className="mt-0.5 block truncate text-[11px] text-ds-faint">
                {file.kind === 'attachment' ? '用户上传' : 'Agent 产出'} · {fileTypeLabel(file.name)}
              </span>
            </span>
          </button>
        ))}
      </div>
    </section>
  )
}

/**
 * Floating file list shown above the chat surface. Clicking a concrete
 * file closes the float and opens the preview in the right sidebar.
 */
export function ConversationFilesFloating({
  files,
  open,
  onClose,
  onOpenFile
}: ConversationFilesFloatingProps): ReactElement | null {
  const uploaded = useMemo(() => files.filter((file) => file.origin === 'user'), [files])
  const produced = useMemo(() => files.filter((file) => file.origin === 'agent'), [files])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  const handleOpen = (file: ConversationFile): void => {
    onClose()
    onOpenFile(file)
  }

  return (
    <div className="ds-no-drag fixed right-4 top-16 z-50 flex max-h-[min(72vh,680px)] w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden rounded-[16px] border border-ds-border-muted bg-ds-card/98 text-ds-ink shadow-[0_22px_64px_rgba(15,23,42,0.22)] backdrop-blur-xl dark:bg-ds-card/98 dark:shadow-[0_24px_72px_rgba(0,0,0,0.46)]">
      <div className="flex h-[48px] shrink-0 items-center gap-2 border-b border-ds-border-muted px-4">
        <Files className="h-[18px] w-[18px] text-ds-muted" strokeWidth={1.75} />
        <div className="min-w-0 flex-1 text-[14px] font-semibold text-ds-ink">对话文件</div>
        {files.length ? <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[10px] font-semibold text-ds-muted">{files.length}</span> : null}
        <button type="button" onClick={onClose} className="ds-code-sidebar-icon-button" aria-label="关闭" title="关闭">
          <X className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {files.length ? (
          <div className="space-y-5">
            {renderFileGroup('用户文件', uploaded, handleOpen)}
            {renderFileGroup('Agent 产出', produced, handleOpen)}
          </div>
        ) : (
          <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 px-6 text-center text-[12px] leading-6 text-ds-muted">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-ds-border-muted bg-ds-card"><Files className="h-5 w-5 text-ds-faint" strokeWidth={1.6} /></span>
            <span>对话中上传或生成的文件会自动显示在这里。</span>
          </div>
        )}
      </div>
    </div>
  )
}

export function ConversationFilesPanel({
  files,
  activeThreadId,
  workspaceRoot,
  className,
  onClose,
  onOpenWorkspaceFile,
  initialAttachment
}: Props): ReactElement {
  const [selectedAttachment, setSelectedAttachment] = useState<ConversationFile | null>(initialAttachment ?? null)
  const [attachmentContent, setAttachmentContent] = useState<CoreAttachmentContentResponseJson | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!selectedAttachment || selectedAttachment.kind !== 'attachment') return
    const provider = getProvider()
    if (typeof provider.getAttachmentContent !== 'function') {
      setError('当前运行环境无法读取这个附件。')
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setAttachmentContent(null)
    void provider.getAttachmentContent(selectedAttachment.attachmentId, {
      ...(activeThreadId ? { threadId: activeThreadId } : {}),
      ...(workspaceRoot ? { workspace: workspaceRoot } : {})
    }).then((content) => {
      if (!cancelled) setAttachmentContent(content)
    }).catch((fetchError) => {
      if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : String(fetchError))
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [activeThreadId, selectedAttachment, workspaceRoot])

  if (selectedAttachment?.kind === 'attachment') {
    return (
      <aside className={`ds-no-drag flex min-h-0 flex-col border-l border-ds-border-muted bg-ds-main ${className ?? ''}`}>
        <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-ds-border-muted px-3">
          <button type="button" onClick={() => setSelectedAttachment(null)} className="ds-code-sidebar-icon-button" aria-label="返回文件列表" title="返回文件列表">
            <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
          </button>
          <FileTypeIcon name={selectedAttachment.name} className="h-5 w-5 shrink-0" />
          <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ds-ink">{selectedAttachment.name}</div>
          <button type="button" onClick={onClose} className="ds-code-sidebar-icon-button" aria-label="收起右侧栏" title="收起右侧栏">
            <PanelRightClose className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {loading ? (
            <div className="flex min-h-[320px] items-center justify-center gap-2 text-[12px] text-ds-muted"><Loader2 className="h-4 w-4 animate-spin" />正在还原文件…</div>
          ) : error ? (
            <div className="flex min-h-[320px] items-center justify-center px-8 text-center text-[12px] leading-6 text-red-700 dark:text-red-300">{error}</div>
          ) : attachmentContent ? <AttachmentPreview content={attachmentContent} /> : null}
        </div>
      </aside>
    )
  }

  return (
    <aside className={`ds-no-drag flex min-h-0 flex-col border-l border-ds-border-muted bg-ds-sidebar ${className ?? ''}`}>
      <div className="flex h-[50px] shrink-0 items-center gap-2 border-b border-ds-border-muted px-4">
        <Files className="h-[18px] w-[18px] text-ds-muted" strokeWidth={1.75} />
        <div className="min-w-0 flex-1 text-[14px] font-semibold text-ds-ink">对话文件</div>
        {files.length ? <span className="rounded-full bg-ds-subtle px-2 py-0.5 text-[10px] font-semibold text-ds-muted">{files.length}</span> : null}
        <button type="button" onClick={onClose} className="ds-code-sidebar-icon-button" aria-label="收起右侧栏" title="收起右侧栏">
          <PanelRightClose className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {files.length ? (
          <div className="space-y-5">
            {renderFileGroup('用户文件', files.filter((file) => file.origin === 'user'), (file) => {
              if (file.kind === 'attachment') setSelectedAttachment(file)
              else onOpenWorkspaceFile(file.path)
            })}
            {renderFileGroup('Agent 产出', files.filter((file) => file.origin === 'agent'), (file) => {
              if (file.kind === 'attachment') setSelectedAttachment(file)
              else onOpenWorkspaceFile(file.path)
            })}
          </div>
        ) : (
          <div className="flex min-h-[300px] flex-col items-center justify-center gap-3 px-6 text-center text-[12px] leading-6 text-ds-muted">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-ds-border-muted bg-ds-card"><Files className="h-5 w-5 text-ds-faint" strokeWidth={1.6} /></span>
            <span>对话中上传或生成的文件会自动显示在这里。</span>
          </div>
        )}
      </div>
    </aside>
  )
}
