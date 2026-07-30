import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BookOpen,
  FilePenLine,
  FileText,
  Scale,
  ScrollText,
  User,
  Trash2,
  Loader2
} from 'lucide-react'
import type { LegalTemplate, TemplateCategory } from './legal-templates'
import { AstryxSegmentedControl } from '../astryx/AstryxSegmentedControl'

type Props = {
  templates: LegalTemplate[]
  activeCategory: TemplateCategory | 'all'
  activeTemplateId: string | null
  searchQuery: string
  showUserTemplates: boolean
  onSelectTemplate: (template: LegalTemplate) => void
  onCategoryChange: (category: TemplateCategory | 'all') => void
  onSearchQueryChange: (query: string) => void
  onDeleteUserTemplate?: (templateId: string) => void
  deletingTemplateId?: string | null
  loadingUserTemplates?: boolean
}

const categoryIcons: Record<string, ReactElement> = {
  litigation: <Scale className="h-4 w-4" strokeWidth={1.75} />,
  'non-litigation': <ScrollText className="h-4 w-4" strokeWidth={1.75} />,
  custom: <FilePenLine className="h-4 w-4" strokeWidth={1.75} />
}

export function DocumentTemplateLibrary({
  templates,
  activeCategory,
  activeTemplateId,
  searchQuery,
  showUserTemplates,
  onSelectTemplate,
  onCategoryChange,
  onSearchQueryChange,
  onDeleteUserTemplate,
  deletingTemplateId,
  loadingUserTemplates
}: Props): ReactElement {
  const { t } = useTranslation('common')

  const filteredTemplates = templates.filter((tmpl) => {
    if (activeCategory !== 'all' && tmpl.category !== activeCategory) return false
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      return (
        tmpl.name.toLowerCase().includes(q)
      )
    }
    return true
  })

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="ds-no-drag shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <BookOpen className="h-5 w-5 text-[var(--ds-accent)]" strokeWidth={1.75} />
          <h2 className="text-[15px] font-semibold text-[var(--ds-ink)]">
            {t('documentWritingTemplateLibrary')}
          </h2>
        </div>
      </div>

      {/* Search */}
      <div className="ds-no-drag shrink-0 px-4 pb-3">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            placeholder={t('documentWritingSearchPlaceholder')}
            className="w-full rounded-[8px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-3 py-1.5 pl-9 text-[13px] text-[var(--ds-ink)] placeholder-[var(--ds-faint)] outline-none transition focus:border-[var(--ds-accent)] focus:ring-1 focus:ring-[var(--ds-accent)]"
          />
          <FileText className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-faint)]" strokeWidth={1.75} />
          {searchQuery && (
            <button
              type="button"
              onClick={() => onSearchQueryChange('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[4px] p-0.5 text-[var(--ds-faint)] hover:text-[var(--ds-ink)]"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Category tabs */}
      <div className="ds-no-drag shrink-0 px-4 pb-3">
        <AstryxSegmentedControl
          value={activeCategory}
          items={[
            { value: 'all', label: t('documentWritingAll') },
            {
              value: 'litigation',
              label: t('documentWritingLitigation'),
              icon: <Scale className="h-3.5 w-3.5" strokeWidth={1.9} />
            },
            {
              value: 'non-litigation',
              label: t('documentWritingNonLitigation'),
              icon: <ScrollText className="h-3.5 w-3.5" strokeWidth={1.9} />
            },
            {
              value: 'custom',
              label: t('documentWritingMyTemplates'),
              icon: <User className="h-3.5 w-3.5" strokeWidth={1.9} />
            }
          ]}
          onChange={onCategoryChange}
          ariaLabel={t('documentWritingTemplateLibrary')}
          className="grid grid-cols-2 gap-1 rounded-[10px] border border-[var(--ds-sidebar-row-ring)] bg-[color-mix(in_srgb,var(--ds-sidebar-field-bg)_84%,transparent)] p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.62)] dark:bg-white/[0.035] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
          buttonClassName="group inline-flex min-h-[30px] w-full items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 py-1 text-[12px] font-medium"
          indicatorClassName="rounded-[7px] bg-[var(--ds-sidebar-field-focus)] shadow-[0_1px_3px_rgba(15,23,42,0.07),inset_0_0_0_1px_var(--ds-sidebar-row-ring),inset_0_1px_0_rgba(255,255,255,0.78)] dark:bg-white/[0.09]"
          activeClassName="text-[#182230] dark:text-white"
          inactiveClassName="text-[#5c6675] hover:text-[#1f2733] dark:text-white/58 dark:hover:text-white/88"
        />
      </div>

      {/* Template list */}
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {loadingUserTemplates && activeCategory === 'custom' ? (
          <div className="mt-8 flex flex-col items-center gap-2 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ds-faint)]" />
            <p className="text-[13px] text-[var(--ds-faint)]">加载中...</p>
          </div>
        ) : filteredTemplates.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-2 text-center">
            <FileText className="h-8 w-8 text-[var(--ds-faint)]" strokeWidth={1.5} />
            <p className="text-[13px] text-[var(--ds-faint)]">
              {searchQuery
                ? t('documentWritingNoSearchResults')
                : activeCategory === 'custom'
                ? t('documentWritingMyTemplatesEmpty')
                : t('documentWritingNoTemplates')}
            </p>
          </div>
        ) : (
          <div data-control-hover-root className="grid grid-cols-2 gap-2">
            {filteredTemplates.map((tmpl) => {
              const isCustom = tmpl.category === 'custom' || '_isCustom' in tmpl
              return (
                <div key={tmpl.id} className="group relative min-w-0">
                  <button
                    type="button"
                    data-control-active={activeTemplateId === tmpl.id ? 'true' : undefined}
                    onClick={() => onSelectTemplate(tmpl)}
                    title={tmpl.name}
                    className={`ds-no-drag flex min-h-[84px] w-full flex-col items-start justify-between rounded-[14px] px-3 py-3 text-left transition duration-150 ${
                      activeTemplateId === tmpl.id
                        ? 'bg-[var(--ds-sidebar-field-focus)] shadow-[0_8px_22px_rgba(65,83,112,0.08),inset_0_0_0_1px_color-mix(in_srgb,var(--ds-accent)_24%,var(--ds-sidebar-row-ring)),inset_0_1px_0_rgba(255,255,255,0.82)] dark:bg-white/[0.09] dark:shadow-[0_10px_24px_rgba(0,0,0,0.16),inset_0_0_0_1px_rgba(51,156,255,0.22)]'
                        : 'bg-[color-mix(in_srgb,var(--ds-sidebar-field-bg)_60%,transparent)] shadow-[inset_0_0_0_1px_var(--ds-sidebar-row-ring)] hover:-translate-y-0.5 hover:bg-[var(--ds-sidebar-field-focus)] hover:shadow-[0_8px_20px_rgba(65,83,112,0.07),inset_0_0_0_1px_var(--ds-sidebar-row-ring)] dark:hover:bg-white/[0.07]'
                    }`}
                  >
                    <span className={`flex h-8 w-8 items-center justify-center rounded-[10px] ${
                      activeTemplateId === tmpl.id
                        ? 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent)]'
                        : 'bg-[var(--ds-sidebar-field-focus)] text-[var(--ds-muted)]'
                    }`}>
                      {categoryIcons[tmpl.category] ?? <FileText className="h-4 w-4" strokeWidth={1.75} />}
                    </span>
                    <span className="mt-2 line-clamp-2 text-[12.5px] font-medium leading-[1.35] text-[var(--ds-ink)]">
                      {tmpl.name}
                    </span>
                    {isCustom && tmpl.learningStatus === 'analyzing' && (
                      <span className="mt-1 inline-flex items-center gap-1 text-[9.5px] text-amber-500">
                        <Loader2 className="h-2.5 w-2.5 animate-spin" strokeWidth={2.2} />
                        AI 分析中
                      </span>
                    )}
                    {isCustom && tmpl.learningStatus === 'failed' && (
                      <span className="mt-1 inline-flex items-center gap-1 text-[9.5px] text-red-400">
                        AI 分析失败
                      </span>
                    )}
                    {isCustom && (!tmpl.learningStatus || tmpl.learningStatus === 'idle' || tmpl.learningStatus === 'done') && (
                      <span className="mt-1 inline-flex items-center gap-1 text-[9.5px] text-[var(--ds-accent)]">
                        <User className="h-2.5 w-2.5" strokeWidth={2.2} />
                        自定义
                      </span>
                    )}
                  </button>
                  {isCustom && onDeleteUserTemplate && (
                    <button
                      type="button"
                      data-control-hover-preserve
                      onClick={(e) => {
                        e.stopPropagation()
                        onDeleteUserTemplate(tmpl.id)
                      }}
                      disabled={deletingTemplateId === tmpl.id}
                      className="absolute right-2 top-2 rounded-[7px] p-1 text-[var(--ds-faint)] opacity-0 transition hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-red-900/20"
                      title={t('documentWritingDeleteTemplate')}
                    >
                      {deletingTemplateId === tmpl.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                      )}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
