import type { ChangeEvent, ReactElement } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertCircle,
  Check,
  ChevronDown,
  CircleCheck,
  FileDown,
  FilePenLine,
  FileText,
  FileUp,
  Loader2,
  Plus,
  WandSparkles,
  X
} from 'lucide-react'
import { DOCUMENT_SUBJECT_FIELD_ID } from '../../../../shared/user-templates'
import type { LegalTemplate, LegalTemplateField } from './legal-templates'
import { DocumentWritingEditorDialog } from './DocumentWritingEditorDialog'
import '../../styles/document-writing.css'

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
  onGeneratedContentChange: (content: string) => void
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
  const valueToneClassName = value.trim()
    ? 'document-writing-control-filled'
    : 'document-writing-control-preset'
  const controlClassName =
    `document-writing-control ${valueToneClassName} w-full border-0 bg-transparent px-3.5 text-[13px] outline-none`

  if (field.type === 'textarea') {
    return (
      <div className="document-writing-control-shell min-h-[88px]">
        <textarea
          value={value}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          className={`${controlClassName} min-h-[86px] resize-none py-3`}
        />
      </div>
    )
  }

  if (field.type === 'select' && field.options) {
    return (
      <div className="document-writing-control-shell">
        <select
          value={value}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
          className={`${controlClassName} h-11 appearance-none pr-10`}
        >
          <option value="">{field.placeholder || ''}</option>
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-faint)]"
          strokeWidth={1.8}
        />
      </div>
    )
  }

  if (field.type === 'date') {
    return (
      <div className="document-writing-control-shell">
        <input
          type="date"
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
          className={`${controlClassName} h-11`}
        />
      </div>
    )
  }

  return (
    <div className="document-writing-control-shell">
      <input
        type="text"
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={field.placeholder}
        className={`${controlClassName} h-11`}
      />
    </div>
  )
}

const MAX_FIELDS_VISIBLE = 15
const MATERIAL_DOCUMENT_SUBJECT_FIELD: LegalTemplateField = {
  id: DOCUMENT_SUBJECT_FIELD_ID,
  label: '文书涉及主体（我方/委托方）',
  type: 'text',
  placeholder: '请输入本次代表的当事人，例如：被告某某公司',
  required: true
}

export function canGenerateDocument(options: {
  missingRequiredFieldCount: number
  missingExplicitFieldCount: number
  missingDocumentSubjectCount?: number
  loadedMaterialCount: number
}): boolean {
  return (
    (options.missingDocumentSubjectCount ?? 0) === 0 &&
    options.missingExplicitFieldCount === 0 &&
    (options.missingRequiredFieldCount === 0 || options.loadedMaterialCount > 0)
  )
}

export function DocumentWritingEditor({
  template,
  fieldValues,
  generatedContent,
  generating,
  error,
  onFieldChange,
  onGeneratedContentChange,
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
  const [exportingFormat, setExportingFormat] = useState<'word' | 'markdown' | null>(null)
  const [exportFeedback, setExportFeedback] = useState<{
    tone: 'success' | 'warning' | 'error'
    message: string
  } | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)

  const handleExportWord = useCallback(async (): Promise<void> => {
    if (!generatedContent || !template || typeof window.dsGui?.exportLegalResearchToWord !== 'function') return
    if (exportingFormat) return
    setExportFeedback(null)
    setExportingFormat('word')
    try {
      const defaultName = template.name.replace(/[<>:"/\\|?*]/g, '_')
      const result = await window.dsGui.exportLegalResearchToWord({
        markdown: generatedContent,
        templateId: template.id,
        templateName: template.name,
        defaultName
      })
      if (result.ok) {
        setExportFeedback({
          tone: result.warning ? 'warning' : 'success',
          message: result.warning || (result.formatPreserved
            ? '已基于原 DOCX 原位写入，保留原模板版式。'
            : 'Word 文档已导出。')
        })
      } else if (!result.canceled) {
        setExportFeedback({ tone: 'error', message: result.message })
      }
    } catch (error) {
      setExportFeedback({
        tone: 'error',
        message: error instanceof Error ? error.message : 'Word 导出失败，请重试。'
      })
    } finally {
      setExportingFormat(null)
    }
  }, [exportingFormat, generatedContent, template])

  const handleExportMarkdown = useCallback(async (): Promise<void> => {
    if (!generatedContent || !template || typeof window.dsGui?.exportMarkdownDocument !== 'function') return
    if (exportingFormat) return
    setExportingFormat('markdown')
    try {
      const defaultName = template.name.replace(/[<>:"/\\|?*]/g, '_')
      const result = await window.dsGui.exportMarkdownDocument({
        markdown: generatedContent,
        defaultName
      })
      if (!result.ok && !result.canceled) {
        console.error('[document-writing] Markdown export failed:', result.message)
      }
    } catch (error) {
      console.error('[document-writing] Markdown export error:', error)
    } finally {
      setExportingFormat(null)
    }
  }, [exportingFormat, generatedContent, template])

  const loadedMaterialCount = useMemo(
    () => uploadedMaterials.filter((material) => material.loaded && material.content.trim()).length,
    [uploadedMaterials]
  )
  const hasLoadedMaterials = loadedMaterialCount > 0
  const documentSubjectMissing =
    hasLoadedMaterials && !fieldValues[DOCUMENT_SUBJECT_FIELD_ID]?.trim()

  const missingRequiredFields = useMemo(() => {
    if (!template) return []
    if (hasLoadedMaterials) {
      return documentSubjectMissing ? [MATERIAL_DOCUMENT_SUBJECT_FIELD.label] : []
    }
    return template.fields
      .filter((f) => f.required && !fieldValues[f.id]?.trim())
      .map((f) => f.label)
  }, [documentSubjectMissing, fieldValues, hasLoadedMaterials, template])

  const missingExplicitFields = useMemo(() => {
    if (!template) return []
    if (hasLoadedMaterials) return []
    return template.fields
      .filter((f) => f.required && f.type === 'select' && !fieldValues[f.id]?.trim())
      .map((f) => f.label)
  }, [fieldValues, hasLoadedMaterials, template])

  const visibleFields = useMemo(() => {
    if (!template) return []
    if (showAllFields || template.fields.length <= MAX_FIELDS_VISIBLE) {
      return template.fields
    }
    return template.fields.slice(0, MAX_FIELDS_VISIBLE)
  }, [template, showAllFields])

  const hiddenFieldCount = template ? template.fields.length - visibleFields.length : 0
  const completedFieldCount = useMemo(
    () =>
      (template?.fields.filter((field) => fieldValues[field.id]?.trim()).length ?? 0) +
      (hasLoadedMaterials && fieldValues[DOCUMENT_SUBJECT_FIELD_ID]?.trim() ? 1 : 0),
    [fieldValues, hasLoadedMaterials, template]
  )
  const displayedFieldCount = (template?.fields.length ?? 0) + (hasLoadedMaterials ? 1 : 0)
  const canGenerate = canGenerateDocument({
    missingRequiredFieldCount: missingRequiredFields.length,
    missingExplicitFieldCount: missingExplicitFields.length,
    missingDocumentSubjectCount: documentSubjectMissing ? 1 : 0,
    loadedMaterialCount
  })

  if (!template) {
    return (
      <div className="document-writing-canvas flex h-full items-center justify-center px-8">
        <div className="document-writing-empty max-w-md text-center">
          <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-[18px] bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]">
            <FilePenLine className="h-6 w-6" strokeWidth={1.65} />
          </span>
          <p className="text-[16px] font-semibold text-[var(--ds-ink)]">
            {t('documentWritingSelectTemplate')}
          </p>
          <p className="mt-1.5 text-[13px] leading-5 text-[var(--ds-faint)]">
            {t('documentWritingSelectTemplateHint')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="document-writing-canvas flex h-full flex-col">
      <header className="document-writing-header ds-no-drag shrink-0 px-7 py-4">
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]">
              <FilePenLine className="h-[19px] w-[19px]" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-ink)]">
                {template.name}
              </h2>
              <div className="mt-1 flex items-center gap-2 text-[11.5px] text-[var(--ds-faint)]">
                <span>{template.fields.length} 项信息</span>
                <span aria-hidden="true">·</span>
                <span>{uploadedMaterials.length > 0 ? `${uploadedMaterials.length} 份材料` : '尚未添加材料'}</span>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onNewDocument}
            className="document-writing-secondary-button ml-4 shrink-0"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            {t('documentWritingNew')}
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {generatedContent ? (
          <div className="mx-auto grid w-full max-w-[1280px] grid-cols-[minmax(0,1fr)_280px] gap-5 p-6 max-[980px]:grid-cols-1">
            <section className="document-writing-card min-w-0 px-7 py-6">
              <div className="mb-5 flex items-center gap-2">
                <CircleCheck className="h-[18px] w-[18px] text-[var(--ds-success)]" strokeWidth={1.9} />
                <h3 className="text-[14px] font-semibold text-[var(--ds-ink)]">文书预览</h3>
              </div>
              <div className="legal-document-preview ds-markdown ds-chat-answer max-w-none text-[13px] text-[var(--ds-ink)]">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{generatedContent}</ReactMarkdown>
              </div>
              <div className="mt-6 flex items-start gap-2 rounded-[12px] bg-[var(--ds-sidebar-field-bg)] px-4 py-3 text-[12px] leading-5 text-[var(--ds-faint)]">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                以上由 AI 生成，请仔细核对后使用。建议经执业律师审核并修改后正式提交。
              </div>
            </section>

            <aside className="min-w-0">
              <div data-control-hover-root className="document-writing-card document-writing-assistant-card sticky top-6 p-4">
                <div className="mb-4 flex items-center gap-3 px-1">
                  <span className="document-writing-ai-icon">
                    <WandSparkles className="h-[18px] w-[18px]" strokeWidth={1.9} />
                  </span>
                  <div>
                    <h3 className="text-[14px] font-semibold text-[var(--ds-ink)]">AI 文书助手</h3>
                    <p className="mt-0.5 text-[11.5px] text-[var(--ds-faint)]">已完成本次生成</p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={exportingFormat !== null}
                  onClick={() => void handleExportWord()}
                  className="document-writing-primary-button mb-2 w-full"
                >
                  {exportingFormat === 'word' ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  ) : (
                    <FileDown className="h-4 w-4" strokeWidth={1.9} />
                  )}
                  <span>
                    {exportingFormat === 'word'
                      ? t('documentWritingExportingWord')
                      : t('documentWritingExportWord')}
                  </span>
                </button>
                <div className="mb-3 flex items-start gap-2 rounded-[10px] bg-[var(--ds-sidebar-field-bg)] px-3 py-2 text-[10.5px] leading-[1.5] text-[var(--ds-faint)]">
                  {template.hasSourceDocument ? (
                    <>
                      <CircleCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-success)]" strokeWidth={1.9} />
                      <span>已保留原始 DOCX；Word 导出会沿用原文件的页面、样式、表格及页眉页脚。</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                      <span>当前模板没有原始 DOCX，Word 将使用标准法律文书格式。</span>
                    </>
                  )}
                </div>
                {exportFeedback && (
                  <div className={`mb-3 rounded-[10px] px-3 py-2 text-[10.5px] leading-[1.5] ${
                    exportFeedback.tone === 'error'
                      ? 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400'
                      : exportFeedback.tone === 'warning'
                        ? 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
                        : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                  }`}>
                    {exportFeedback.message}
                  </div>
                )}
                <button
                  type="button"
                  disabled={exportingFormat !== null}
                  onClick={() => void handleExportMarkdown()}
                  className="document-writing-secondary-button mb-2 w-full justify-center"
                >
                  {exportingFormat === 'markdown' ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  ) : (
                    <FileText className="h-4 w-4" strokeWidth={1.9} />
                  )}
                  <span>
                    {exportingFormat === 'markdown'
                      ? t('documentWritingExportingMarkdown')
                      : t('documentWritingExportMarkdown')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setEditorOpen(true)}
                  className="document-writing-secondary-button mb-2 w-full justify-center"
                >
                  <FilePenLine className="h-4 w-4" strokeWidth={1.9} />
                  {t('documentWritingEditDocument')}
                </button>
                <button
                  type="button"
                  onClick={() => onFieldChange('__reset__', '')}
                  className="document-writing-secondary-button w-full justify-center"
                >
                  {t('documentWritingEditFields')}
                </button>
              </div>
            </aside>
          </div>
        ) : (
          <div className="document-writing-layout mx-auto w-full max-w-[1280px] p-6">
            <main className="min-w-0 space-y-5">
              {error && (
                <div className="flex items-start gap-2 rounded-[14px] border border-red-200/80 bg-red-50/90 px-4 py-3 text-[13px] text-red-700 shadow-sm dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.9} />
                  <span>{error}</span>
                </div>
              )}

              {onAddMaterial && (
                <section className="document-writing-card document-writing-material-card p-5">
                  <div className="mb-4 flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]">
                        <FileUp className="h-[18px] w-[18px]" strokeWidth={1.8} />
                      </span>
                      <div>
                        <h3 className="text-[14px] font-semibold text-[var(--ds-ink)]">上传案件材料</h3>
                        <p className="mt-0.5 text-[11.5px] leading-4 text-[var(--ds-faint)]">
                          AI 会优先读取材料，并自动补充下方信息
                        </p>
                      </div>
                    </div>
                    {uploadedMaterials.length > 0 && (
                      <span className="document-writing-status-pill">
                        <Check className="h-3 w-3" strokeWidth={2.2} />
                        {uploadedMaterials.length} 份已添加
                      </span>
                    )}
                  </div>

                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {uploadedMaterials.map((mat, idx) => (
                      <div key={mat.id} className="document-writing-material-item">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[var(--ds-sidebar-field-bg)] text-[var(--ds-accent)]">
                          <FileText className="h-4 w-4" strokeWidth={1.7} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12.5px] font-medium text-[var(--ds-ink)]">
                            {mat.name}
                          </span>
                          <span className={`mt-0.5 block text-[10.5px] ${
                            mat.error ? 'text-red-500' : mat.loaded ? 'text-[var(--ds-success)]' : 'text-[var(--ds-faint)]'
                          }`}>
                            {mat.error ? '读取失败' : mat.loaded ? '已读取，可用于生成' : '正在读取'}
                          </span>
                        </span>
                        {!mat.loaded && !mat.error && (
                          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--ds-faint)]" />
                        )}
                        {onRemoveMaterial && (
                          <button
                            type="button"
                            aria-label={`移除 ${mat.name}`}
                            onClick={() => onRemoveMaterial(idx)}
                            className="rounded-[7px] p-1 text-[var(--ds-faint)] transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/20"
                          >
                            <X className="h-3.5 w-3.5" strokeWidth={1.8} />
                          </button>
                        )}
                      </div>
                    ))}

                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className={`document-writing-upload-button ${uploadedMaterials.length === 0 ? 'sm:col-span-2' : ''}`}
                    >
                      <span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]">
                        <Plus className="h-4 w-4" strokeWidth={2} />
                      </span>
                      <span className="text-left">
                        <span className="block text-[12.5px] font-medium text-[var(--ds-ink)]">添加参考文件</span>
                        <span className="mt-0.5 block text-[10.5px] text-[var(--ds-faint)]">PDF、Word 或文本文件</span>
                      </span>
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".docx,.pdf,.txt,.md,.markdown"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        if (file) onAddMaterial(file)
                        event.target.value = ''
                      }}
                      className="hidden"
                    />
                  </div>
                </section>
              )}

              <section className="document-writing-card overflow-hidden">
                <div className="flex items-center justify-between gap-4 px-5 pb-3 pt-5">
                  <div>
                    <h3 className="text-[14px] font-semibold text-[var(--ds-ink)]">文书信息</h3>
                    <p className="mt-0.5 text-[11.5px] text-[var(--ds-faint)]">填写关键信息，AI 会结合材料完成文书</p>
                  </div>
                  <span className="text-[11.5px] tabular-nums text-[var(--ds-faint)]">
                    已填写 {completedFieldCount}/{displayedFieldCount}
                  </span>
                </div>

                <div className="document-writing-progress mx-5 mb-5" aria-hidden="true">
                  <span style={{ width: `${displayedFieldCount > 0 ? (completedFieldCount / displayedFieldCount) * 100 : 0}%` }} />
                </div>

                <div className="document-writing-fields px-5 pb-5">
                  {hasLoadedMaterials && (
                    <div className="document-writing-field-wide">
                      <label className="mb-1.5 block text-[12px] font-medium text-[var(--ds-ink)]">
                        {MATERIAL_DOCUMENT_SUBJECT_FIELD.label}
                        <span className="ml-1 text-red-500">*</span>
                      </label>
                      <FieldInput
                        field={MATERIAL_DOCUMENT_SUBJECT_FIELD}
                        value={fieldValues[DOCUMENT_SUBJECT_FIELD_ID] ?? ''}
                        onChange={(value) => onFieldChange(DOCUMENT_SUBJECT_FIELD_ID, value)}
                      />
                      <p className="mt-1.5 text-[10.5px] leading-4 text-[var(--ds-faint)]">
                        请明确本次代表哪一方；其余空缺信息由 Agent 从已上传材料中提取。
                      </p>
                    </div>
                  )}
                  {visibleFields.map((field) => (
                    <div
                      key={field.id}
                      className={field.type === 'textarea' ? 'document-writing-field-wide' : undefined}
                    >
                      <label className="mb-1.5 block text-[12px] font-medium text-[var(--ds-ink)]">
                        {field.label}
                        {!hasLoadedMaterials && field.required && <span className="ml-1 text-red-500">*</span>}
                      </label>
                      <FieldInput
                        field={field}
                        value={fieldValues[field.id] ?? ''}
                        onChange={(value) => onFieldChange(field.id, value)}
                      />
                    </div>
                  ))}
                </div>

                {hiddenFieldCount > 0 && !showAllFields && (
                  <button
                    type="button"
                    onClick={() => setShowAllFields(true)}
                    className="flex w-full items-center justify-center gap-1.5 border-t border-[var(--ds-sidebar-divider)] px-4 py-3 text-[12px] font-medium text-[var(--ds-accent)] transition hover:bg-[var(--ds-sidebar-field-bg)]"
                  >
                    展开其余 {hiddenFieldCount} 项
                    <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.9} />
                  </button>
                )}
              </section>

              {onUpdateInstruction && (
                <section className="document-writing-card p-5">
                  <label className="mb-3 block">
                    <span className="block text-[14px] font-semibold text-[var(--ds-ink)]">补充要求</span>
                    <span className="mt-0.5 block text-[11.5px] text-[var(--ds-faint)]">可选，用于说明表达风格或需要重点呈现的事实</span>
                  </label>
                  <div className="document-writing-control-shell min-h-[96px]">
                    <textarea
                      value={instruction}
                      onChange={(event) => onUpdateInstruction(event.target.value)}
                      placeholder="例如：使用正式法律语言，重点说明我方当事人无过错……"
                      rows={3}
                      className="document-writing-control min-h-[94px] w-full resize-none border-0 bg-transparent px-3.5 py-3 text-[13px] text-[var(--ds-ink)] placeholder-[var(--ds-faint)] outline-none"
                    />
                  </div>
                </section>
              )}
            </main>

            <aside className="min-w-0">
              <div className="document-writing-card document-writing-assistant-card sticky top-0 p-4">
                <div className="mb-4 flex items-center gap-3 px-1">
                  <span className="document-writing-ai-icon">
                    <WandSparkles className="h-[18px] w-[18px]" strokeWidth={1.9} />
                  </span>
                  <div>
                    <h3 className="text-[14px] font-semibold text-[var(--ds-ink)]">AI 文书助手</h3>
                    <p className="mt-0.5 text-[11.5px] text-[var(--ds-faint)]">先理解材料、调研法律依据，再撰写文书</p>
                  </div>
                </div>

                <div className="mb-4 space-y-1.5 rounded-[12px] bg-[var(--ds-sidebar-field-bg)] p-3">
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="text-[var(--ds-faint)]">参考材料</span>
                    <span className="font-medium text-[var(--ds-ink)]">{uploadedMaterials.length} 份</span>
                  </div>
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="text-[var(--ds-faint)]">已填信息</span>
                    <span className="font-medium text-[var(--ds-ink)]">{completedFieldCount}/{displayedFieldCount}</span>
                  </div>
                  <div className="flex items-center justify-between text-[11.5px]">
                    <span className="text-[var(--ds-faint)]">生成状态</span>
                    <span className={canGenerate ? 'font-medium text-[var(--ds-success)]' : 'font-medium text-amber-600 dark:text-amber-400'}>
                      {canGenerate ? '可以生成' : '需要补充'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onGenerate}
                  disabled={generating || !canGenerate}
                  className="document-writing-primary-button w-full"
                >
                  {generating ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
                  ) : (
                    <WandSparkles className="h-4 w-4" strokeWidth={1.9} />
                  )}
                  <span>{generating ? t('documentWritingGenerating') : t('documentWritingGenerate')}</span>
                </button>

                {documentSubjectMissing ? (
                  <div className="mt-3 flex items-start gap-2 px-1 text-[11px] leading-[1.55] text-[var(--ds-faint)]">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                    <span>请填写文书涉及主体，明确本次代表哪一方；其他字段由 Agent 从材料提取。</span>
                  </div>
                ) : missingRequiredFields.length > 0 ? (
                  <div className="mt-3 flex items-start gap-2 px-1 text-[11px] leading-[1.55] text-[var(--ds-faint)]">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                    <span>
                      {missingExplicitFields.length > 0
                        ? `请先选择：${missingExplicitFields.join('、')}`
                        : '请填写必填内容，或上传一份可读取的案件材料，由 Agent 自动提取并撰写。'}
                    </span>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-2 px-1 text-[11px] text-[var(--ds-success)]">
                    <CircleCheck className="h-3.5 w-3.5" strokeWidth={1.9} />
                    {hasLoadedMaterials ? '主体已确认，其余信息将从材料提取' : '关键信息已就绪'}
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
      {editorOpen && generatedContent ? (
        <DocumentWritingEditorDialog
          initialMarkdown={generatedContent}
          onClose={() => setEditorOpen(false)}
          onSave={(markdown) => {
            onGeneratedContentChange(markdown)
            setEditorOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}
