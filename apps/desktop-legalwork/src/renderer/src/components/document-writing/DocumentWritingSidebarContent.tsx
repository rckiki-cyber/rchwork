import type { ReactElement } from 'react'
import { BookOpen, Clock, Database, RefreshCw, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AstryxSegmentedControl } from '../astryx/AstryxSegmentedControl'
import { DocumentHistorySidebar } from './DocumentHistorySidebar'
import { DocumentTemplateLibrary } from './DocumentTemplateLibrary'
import { DocumentTemplateUploader } from './DocumentTemplateUploader'
import { useDocumentWriting } from './DocumentWritingContext'

export function DocumentWritingSidebarContent(): ReactElement {
  const { t } = useTranslation('common')
  const documentWriting = useDocumentWriting()

  return (
    <div className="ds-no-drag flex min-h-0 flex-1 flex-col pt-1">
      <div className="flex items-center gap-2 px-1 pb-3">
        <AstryxSegmentedControl
          value={documentWriting.leftTab}
          items={[
            {
              value: 'templates',
              label: t('documentWritingTemplateLibrary'),
              icon: <BookOpen className="h-3.5 w-3.5" strokeWidth={1.75} />
            },
            {
              value: 'history',
              label: t('documentWritingHistory'),
              icon: <Clock className="h-3.5 w-3.5" strokeWidth={1.75} />
            }
          ]}
          onChange={documentWriting.setLeftTab}
          ariaLabel={`${t('documentWritingTemplateLibrary')} / ${t('documentWritingHistory')}`}
          className="flex min-w-0 flex-1 rounded-[8px] bg-[var(--ds-sidebar-field-bg)] p-1"
          buttonClassName="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[7px] text-[12px] font-medium"
          indicatorClassName="rounded-[7px] bg-ds-card shadow-sm"
          activeClassName="text-[var(--ds-ink)]"
          inactiveClassName="text-[var(--ds-muted)] hover:text-[var(--ds-ink)]"
        />
        <button
          type="button"
          onClick={documentWriting.handleKnowledgeToggle}
          title={t('knowledgeBase')}
          aria-pressed={documentWriting.knowledgePanelOpen}
          className={`astryx-button flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-[var(--ds-sidebar-row-ring)] text-[12px] font-medium transition ${
            documentWriting.knowledgePanelOpen
              ? 'bg-ds-card text-[var(--ds-ink)] shadow-sm'
              : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
          }`}
        >
          <Database className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {documentWriting.leftTab === 'templates' ? (
          <div className="flex h-full flex-col">
            <DocumentTemplateLibrary
              templates={documentWriting.allTemplates}
              activeCategory={documentWriting.activeCategory}
              activeTemplateId={documentWriting.activeTemplateId}
              searchQuery={documentWriting.searchQuery}
              showUserTemplates={documentWriting.showUserTemplates}
              onSelectTemplate={documentWriting.handleSelectTemplate}
              onCategoryChange={documentWriting.handleCategoryChange}
              onSearchQueryChange={documentWriting.setSearchQuery}
              onDeleteUserTemplate={(id) => void documentWriting.handleDeleteUserTemplate(id)}
              deletingTemplateId={documentWriting.deletingTemplateId}
              loadingUserTemplates={documentWriting.loadingTemplates}
            />
            <div className="shrink-0 border-t border-[var(--ds-sidebar-divider)] px-4 py-3">
              <button
                type="button"
                onClick={() => documentWriting.setUploaderOpen(true)}
                disabled={documentWriting.loadingTemplates}
                className="flex w-full items-center justify-center gap-2 rounded-[8px] border border-[var(--ds-sidebar-row-ring)] bg-[var(--ds-sidebar-field-bg)] px-4 py-2 text-[13px] font-medium text-[var(--ds-ink)] transition hover:bg-[color-mix(in_srgb,var(--ds-sidebar-field-focus)_56%,transparent)] disabled:opacity-40"
              >
                {documentWriting.loadingTemplates ? (
                  <RefreshCw className="h-4 w-4 animate-spin" strokeWidth={1.75} />
                ) : (
                  <Upload className="h-4 w-4" strokeWidth={1.75} />
                )}
                <span>
                  {documentWriting.loadingTemplates
                    ? t('documentWritingLoadingTemplates') || '加载中...'
                    : t('documentWritingUploadTemplate')}
                </span>
              </button>
            </div>
          </div>
        ) : (
          <DocumentHistorySidebar
            onRestore={documentWriting.handleRestoreHistory}
            onRefreshSignal={documentWriting.historyRefreshSignal}
          />
        )}
      </div>

      <DocumentTemplateUploader
        open={documentWriting.uploaderOpen}
        onClose={() => documentWriting.setUploaderOpen(false)}
        onUpload={documentWriting.handleUpload}
        onSaveLearnedTemplate={documentWriting.handleSaveLearnedTemplate}
      />
    </div>
  )
}
