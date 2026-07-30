import type { ChangeEvent, ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, Upload, X, AlertCircle } from 'lucide-react'

type Props = {
  open: boolean
  onClose: () => void
  onUpload: (file: File) => Promise<void>
}

const ALLOWED_EXTENSIONS = ['.docx', '.pdf', '.txt', '.md']
const MAX_TEMPLATE_FILE_BYTES = 10 * 1024 * 1024

function getFileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

export function DocumentTemplateUploader({
  open,
  onClose,
  onUpload
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setError(null)
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !uploading) onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open, uploading])

  const validateFile = useCallback((file: File): string | null => {
    const ext = getFileExt(file.name)
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return t('documentWritingUploadInvalidType')
    }
    if (file.size > MAX_TEMPLATE_FILE_BYTES) {
      return t('documentWritingUploadTooLarge')
    }
    return null
  }, [t])

  const handleFile = useCallback(async (file: File) => {
    const err = validateFile(file)
    if (err) { setError(err); return }
    setError(null)
    setUploading(true)
    try {
      await onUpload(file)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('documentWritingUploadError'))
    } finally {
      setUploading(false)
    }
  }, [validateFile, onUpload, onClose, t])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) handleFile(file)
      e.target.value = ''
    },
    [handleFile]
  )

  if (!open) return <></>
  const portalRoot =
    document.querySelector<HTMLElement>('.ds-workbench-shell') ?? document.body

  return createPortal(
    <div
      className="ds-no-drag fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-5 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !uploading) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-template-upload-title"
        className="isolate flex max-h-[85vh] w-full max-w-lg flex-col rounded-[18px] border border-[var(--ds-border)] bg-[var(--surface-3)] p-6 shadow-[0_28px_90px_rgba(0,0,0,0.42)]"
        style={{ backgroundColor: 'var(--surface-3)' }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3
            id="document-template-upload-title"
            className="text-[15px] font-semibold text-[var(--ds-ink)]"
          >
            {t('documentWritingUploadTitle')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={uploading}
            className="rounded-[6px] p-1 text-[var(--ds-faint)] transition hover:bg-[color-mix(in_srgb,var(--ds-sidebar-field-focus)_56%,transparent)] hover:text-[var(--ds-ink)]"
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <div
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          className={`mb-4 flex cursor-pointer flex-col items-center gap-3 rounded-[8px] border-2 border-dashed p-10 transition ${
            dragging
              ? 'border-[var(--ds-accent)] bg-[var(--ds-accent)]/5'
              : 'border-[var(--ds-sidebar-row-ring)] hover:border-[var(--ds-accent)]/50'
          }`}
          onClick={() => !uploading && fileInputRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="h-8 w-8 animate-spin text-[var(--ds-accent)]" strokeWidth={1.5} />
          ) : (
            <Upload className={`h-8 w-8 ${dragging ? 'text-[var(--ds-accent)]' : 'text-[var(--ds-faint)]'}`} strokeWidth={1.5} />
          )}
          <p className="text-[13px] text-[var(--ds-ink)]">
            {uploading ? t('documentWritingUploading') : t('documentWritingUploadDragHint')}
          </p>
          <p className="text-[12px] text-[var(--ds-faint)]">
            {t('documentWritingUploadFormats')}
          </p>
          <input ref={fileInputRef} type="file" accept={ALLOWED_EXTENSIONS.join(',')} onChange={handleInputChange} className="hidden" disabled={uploading} />
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-[6px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>,
    portalRoot
  )
}
