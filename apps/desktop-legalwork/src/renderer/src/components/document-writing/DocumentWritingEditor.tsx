import type { ChangeEvent, ReactElement } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertCircle,
  FileDown,
  FileText,
  Loader2,
  SendHorizonal,
  Upload,
  X
} from 'lucide-react'
import type { LegalTemplate, LegalTemplateField } from './legal-templates'

type UploadedMaterial = {
  id: string
  file: File
  name: string
  content: string
  loaded: boolean
  error?: string
}

type Props = {
  template: LegalTemplate | null
  fieldValues: Record<string, string>
  generatedContent: string | null
  generating: boolean
  error: string | null
  onFieldChange: (fieldId: string, value: string) => void
  onGenerate: () => void
  onNewDocument: () => void
  uploadedMaterials?: UploadedMaterial[]
  onAddMaterial?: (file: File) => void
  onRemoveMaterial?: (index: number) => void
  onUpdateInstruction?: (text: string) => void
  instruction?: string
}

function FieldInput({
  field,
  value,
  onChange
}: {
  field: LegalTemplateField
  value: string
  onChange: (v: string) => void
}): ReactElement {
  if (field.type === 'textarea') {
    return (
      <textarea
        value={value}
        onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        placeholder={field.placeholder}
        rows={3}
        className="w-full resize-none rounded-[6px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-3 py-1.5 text-[13px] text-[var(--ds-ink)] placeholder-[var(--ds-faint)] outline-none transition focus:border-[var(--ds-accent)] focus:ring-1 focus:ring-[var(--ds-accent)]"
      />
    )
  }

  if (field.type === 'select' && field.options) {
    return (
      <select
        value={value}
        onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
        className="w-full rounded-[6px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-3 py-1.5 text-[13px] text-[var(--ds-ink)] outline-none transition focus:border-[var(--ds-accent)] focus:ring-1 focus:ring-[var(--ds-accent)]"
      >
        <option value="">{field.placeholder || ''}</option>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    )
  }

  if (field.type === 'date') {
    return (
      <input
        type="date"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        className="w-full rounded-[6px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-3 py-1.5 text-[13px] text-[var(--ds-ink)] outline-none transition focus:border-[var(--ds-accent)] focus:ring-1 focus:ring-[var(--ds-accent)]"
      />
    )
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
      placeholder={field.placeholder}
      className="w-full rounded-[6px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-3 py-1.5 text-[13px] text-[var(--ds-ink)] placeholder-[var(--ds-faint)] outline-none transition focus:border-[var(--ds-accent)] focus:ring-1 focus:ring-[var(--ds-accent)]"
    />
  )
}

const MAX_FIELDS_VISIBLE = 15

export function DocumentWritingEditor({
  template,
  fieldValues,
  generatedContent,
  generating,
  error,
  onFieldChange,
  onGenerate,
  onNewDocument,
  uploadedMaterials = [],
  onAddMaterial,
  onRemoveMaterial,
  onUpdateInstruction,
  instruction = ''
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showAllFields, setShowAllFields] = useState(false)
  const [exporting, setExporting] = useState(false)

  const handleExportWord = useCallback(async (): Promise<void> => {
    if (!generatedContent || typeof window.dsGui?.exportLegalResearchToWord !== 'function') return
    setExporting(true)
    try {
      const html = generatedContent
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/^- (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        .replace(/((?:<li>.*<\/li>\n?)+)/g, (match) => {
          if (match.includes('<ul>')) return match
          return `<ol>${match}</ol>`
        })
        .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
        .replace(/\n{2,}/g, '\n')
        .split('\n')
        .map((line) => {
          const trimmed = line.trim()
          if (!trimmed) return ''
          if (/^<[holeu]/.test(trimmed) || /^<\/(ul|ol)>/.test(trimmed)) return line
          return `<p style="font-family:SimSun;font-size:12pt;line-height:2;margin:4px 0">${trimmed}</p>`
        })
        .join('\n')

      const fullHtml = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${template.name}</title>
  <style>
    body { font-family: SimSun, serif; font-size: 12pt; line-height: 2; color: #222; max-width: 800px; margin: 0 auto; padding: 40px; }
    h1 { font-size: 22pt; text-align: center; margin-bottom: 20px; }
    h2 { font-size: 16pt; margin-top: 24px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    h3 { font-size: 14pt; margin-top: 18px; }
    p { font-family: SimSun; font-size: 12pt; line-height: 2; margin: 4px 0; text-indent: 2em; }
    ul, ol { padding-left: 32px; margin: 6px 0; }
    li { font-family: SimSun; font-size: 12pt; line-height: 2; }
    table { width: 100%; border-collapse: collapse; margin: 12px 0; }
    th, td { border: 1px solid #bbb; padding: 6px 10px; text-align: left; font-family: SimSun; font-size: 12pt; }
    th { background: #f0f0f0; font-weight: bold; }
    code { background: #f5f5f5; padding: 2px 5px; border-radius: 3px; font-size: 11pt; }
    pre { background: #f5f5f5; padding: 12px; border-radius: 4px; overflow-x: auto; }
    blockquote { border-left: 4px solid #ddd; margin-left: 0; padding-left: 16px; color: #666; }
  </style>
</head>
<body>
  ${html}
</body>
</html>`

      const defaultName = template.name.replace(/[<>:"/\\|?*]/g, '_')
      const result = await window.dsGui.exportLegalResearchToWord({ html: fullHtml, defaultName })
      if (!result.ok && !result.canceled) {
        console.error('[document-writing] Word export failed:', result.message)
      }
    } catch (error) {
      console.error('[document-writing] Word export error:', error)
    } finally {
      setExporting(false)
    }
  }, [generatedContent, template.name])

  const hasRequiredFields = useMemo(
    () => template?.fields.some((f) => f.required) ?? false,
    [template]
  )

  const missingRequiredFields = useMemo(() => {
    if (!template) return []
    return template.fields
      .filter((f) => f.required && !fieldValues[f.id]?.trim())
      .map((f) => f.label)
  }, [template, fieldValues])

  const missingExplicitFields = useMemo(() => {
    if (!template) return []
    return template.fields
      .filter((f) => f.required && f.type === 'select' && !fieldValues[f.id]?.trim())
      .map((f) => f.label)
  }, [template, fieldValues])

  const visibleFields = useMemo(() => {
    if (!template) return []
    if (showAllFields || template.fields.length <= MAX_FIELDS_VISIBLE) {
      return template.fields
    }
    return template.fields.slice(0, MAX_FIELDS_VISIBLE)
  }, [template, showAllFields])

  const hiddenFieldCount = template ? template.fields.length - visibleFields.length : 0

  if (!template) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-md text-center">
          <div className="mb-3 text-4xl">📝</div>
          <p className="text-[15px] font-medium text-[var(--ds-ink)]">
            {t('documentWritingSelectTemplate')}
          </p>
          <p className="mt-1 text-[13px] text-[var(--ds-faint)]">
            {t('documentWritingSelectTemplateHint')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Template header */}
      <div className="ds-no-drag shrink-0 border-b border-[var(--ds-sidebar-divider)] px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[16px] font-semibold text-[var(--ds-ink)]">
              {template.name}
            </h2>
            <p className="mt-0.5 truncate text-[13px] text-[var(--ds-faint)]">
              {template.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onNewDocument}
            className="ml-4 shrink-0 rounded-[6px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-3 py-1.5 text-[12px] font-medium text-[var(--ds-ink)] transition hover:bg-[color-mix(in_srgb,var(--ds-sidebar-field-focus)_56%,transparent)]"
          >
            {t('documentWritingNew')}
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex flex-1 gap-0 overflow-hidden">
        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {generatedContent ? (
            <div className="flex-1 overflow-y-auto p-6">
              <div className="ds-markdown ds-chat-answer max-w-none text-[13px] leading-relaxed text-[var(--ds-ink)]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{generatedContent}</ReactMarkdown>
              </div>
              {/* Show generation hints */}
              <div className="mt-6 rounded-[8px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)]/50 px-4 py-3 text-[12px] text-[var(--ds-faint)]">
                以上由 AI 生成，请仔细核对后使用。建议经执业律师审核并修改后正式提交。
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-6">
              {/* Error message */}
              {error && (
                <div className="mb-4 flex items-start gap-2 rounded-[8px] border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
                  <span>{error}</span>
                </div>
              )}

              <div className="space-y-4">
                {/* Template fields */}
                {visibleFields.map((field) => (
                  <div key={field.id}>
                    <label className="mb-1 block text-[13px] font-medium text-[var(--ds-ink)]">
                      {field.label}
                      {field.required && (
                        <span className="ml-1 text-red-500">*</span>
                      )}
                    </label>
                    <FieldInput
                      field={field}
                      value={fieldValues[field.id] ?? ''}
                      onChange={(v) => onFieldChange(field.id, v)}
                    />
                  </div>
                ))}

                {/* Show more button */}
                {hiddenFieldCount > 0 && !showAllFields && (
                  <button
                    type="button"
                    onClick={() => setShowAllFields(true)}
                    className="w-full rounded-[6px] border border-dashed border-[var(--ds-sidebar-row-ring)] px-3 py-2 text-[12px] text-[var(--ds-faint)] transition hover:border-[var(--ds-accent)] hover:text-[var(--ds-accent)]"
                  >
                    还有 {hiddenFieldCount} 个字段，点击展开
                  </button>
                )}

                {/* Uploaded materials section - shown for all templates */}
                {onAddMaterial && (
                  <div className="border-t border-[var(--ds-sidebar-divider)] pt-4">
                    <label className="mb-2 block text-[13px] font-medium text-[var(--ds-ink)]">
                      上传参考材料
                      <span className="ml-1 text-[11px] text-[var(--ds-faint)]">（可选；AI 会读取材料并用于生成）</span>
                    </label>
                    <div className="space-y-2">
                      {uploadedMaterials.map((mat, idx) => (
                        <div
                          key={idx}
                          className="flex items-center gap-2 rounded-[6px] bg-[var(--ds-sidebar-field-focus)] px-3 py-2"
                        >
                          <FileText className="h-4 w-4 shrink-0 text-[var(--ds-accent)]" strokeWidth={1.75} />
                          <span className="flex-1 truncate text-[13px] text-[var(--ds-ink)]">
                            {mat.name}
                          </span>
                          {mat.error ? (
                            <span className="shrink-0 text-[11px] text-red-600 dark:text-red-400">读取失败</span>
                          ) : mat.loaded ? (
                            <span className="shrink-0 text-[11px] text-green-600 dark:text-green-400">已加载</span>
                          ) : (
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--ds-faint)]" />
                          )}
                          {onRemoveMaterial && (
                            <button
                              type="button"
                              onClick={() => onRemoveMaterial(idx)}
                              className="shrink-0 rounded-[4px] p-0.5 text-[var(--ds-faint)] hover:text-red-500"
                            >
                              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="flex w-full items-center justify-center gap-2 rounded-[6px] border border-dashed border-[var(--ds-sidebar-row-ring)] px-3 py-2 text-[12px] text-[var(--ds-faint)] transition hover:border-[var(--ds-accent)] hover:text-[var(--ds-accent)]"
                      >
                        <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
                        <span>添加参考文件</span>
                      </button>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".docx,.pdf,.txt,.md,.markdown"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file && onAddMaterial) {
                            onAddMaterial(file)
                          }
                          e.target.value = ''
                        }}
                        className="hidden"
                      />
                    </div>
                  </div>
                )}

                {/* User instructions */}
                {onUpdateInstruction && (
                  <div className="border-t border-[var(--ds-sidebar-divider)] pt-4">
                    <label className="mb-1 block text-[13px] font-medium text-[var(--ds-ink)]">
                      补充说明
                      <span className="ml-1 text-[11px] text-[var(--ds-faint)]">（可选，对文书撰写的特殊要求）</span>
                    </label>
                    <textarea
                      value={instruction}
                      onChange={(e) => onUpdateInstruction(e.target.value)}
                      placeholder="例如：请使用正式的法律语言，重点突出我方当事人的无过错情节..."
                      rows={3}
                      className="w-full resize-none rounded-[6px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-3 py-1.5 text-[13px] text-[var(--ds-ink)] placeholder-[var(--ds-faint)] outline-none transition focus:border-[var(--ds-accent)] focus:ring-1 focus:ring-[var(--ds-accent)]"
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Action panel */}
        <div className="flex w-[220px] shrink-0 flex-col border-l border-[var(--ds-sidebar-divider)] p-4">
          <button
            type="button"
            onClick={onGenerate}
            disabled={generating || missingExplicitFields.length > 0}
            className="ds-no-drag mb-3 flex items-center justify-center gap-2 rounded-[8px] bg-[var(--ds-accent)] px-4 py-2.5 text-[13px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {generating ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
            ) : (
              <SendHorizonal className="h-4 w-4" strokeWidth={2} />
            )}
            <span>
              {generating ? t('documentWritingGenerating') : t('documentWritingGenerate')}
            </span>
          </button>

          {/* Show missing required fields warning */}
          {!generatedContent && missingRequiredFields.length > 0 && (
            <div className="mb-3 rounded-[6px] bg-amber-50 px-3 py-2 text-[11px] text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
              {missingExplicitFields.length > 0
                ? `请先选择：${missingExplicitFields.join('、')}`
                : `请填写必填字段，或上传案件材料供 AI 提取：${missingRequiredFields.join('、')}`}
            </div>
          )}

          {generatedContent && (
            <>
              <button
                type="button"
                disabled={exporting}
                onClick={() => void handleExportWord()}
                className="ds-no-drag mb-2 flex items-center justify-center gap-2 rounded-[8px] bg-emerald-600 px-4 py-2.5 text-[13px] font-medium text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {exporting ? (
                  <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                ) : (
                  <FileDown className="h-4 w-4" strokeWidth={2} />
                )}
                <span>导出 Word</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  onFieldChange('__reset__', '')
                }}
                className="ds-no-drag flex items-center justify-center gap-2 rounded-[8px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-4 py-2 text-[13px] font-medium text-[var(--ds-ink)] transition hover:bg-[color-mix(in_srgb,var(--ds-sidebar-field-focus)_56%,transparent)]"
              >
                {t('documentWritingEditFields')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
