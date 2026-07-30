import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Code2, Eye, FilePenLine, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { WriteMarkdownEditor } from '../write/WriteMarkdownEditor'
import { AstryxSegmentedControl } from '../astryx/AstryxSegmentedControl'

export type LegalResearchEditorDialogProps = {
  initialMarkdown: string
  onClose: () => void
  onSave: (markdown: string) => void
}

export function LegalResearchEditorDialog({
  initialMarkdown,
  onClose,
  onSave
}: LegalResearchEditorDialogProps): ReactElement {
  const { t } = useTranslation('common')
  const [draft, setDraft] = useState(initialMarkdown)
  const [appearance, setAppearance] = useState<'live' | 'source'>('live')

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="ds-no-drag fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-5 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-research-editor-title"
        className="ds-subfeature-controls flex h-[min(82vh,820px)] w-full max-w-5xl flex-col overflow-hidden rounded-[22px] border border-[var(--ds-border)] bg-[var(--ds-card-strong)] shadow-[0_28px_90px_rgba(0,0,0,0.42)]"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--ds-border)] px-6 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <FilePenLine
              className="h-4.5 w-4.5 shrink-0 text-[var(--ds-accent)]"
              strokeWidth={1.75}
            />
            <div className="min-w-0">
              <h2
                id="legal-research-editor-title"
                className="text-[16px] font-semibold text-[var(--ds-ink)]"
              >
                {t('legalResearchEditTitle')}
              </h2>
              <p className="mt-0.5 truncate text-[11px] text-[var(--ds-faint)]">
                {t('legalResearchEditHint')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('legalResearchEditClose')}
            title={t('legalResearchEditClose')}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[12px] text-[var(--ds-faint)] transition-colors hover:bg-[var(--ds-sidebar-row-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col p-5">
          <div className="flex shrink-0 items-center justify-between gap-4 rounded-t-[16px] border border-b-0 border-[var(--ds-border)] bg-[var(--ds-sidebar)] px-3 py-2">
            <AstryxSegmentedControl
              value={appearance}
              items={[
                {
                  value: 'live',
                  label: t('legalResearchEditVisualMode'),
                  icon: <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                },
                {
                  value: 'source',
                  label: t('legalResearchEditSourceMode'),
                  icon: <Code2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                }
              ]}
              onChange={setAppearance}
              ariaLabel={t('legalResearchEditMode')}
              className="flex items-center rounded-[16px] border border-[var(--ds-border)] bg-[var(--ds-main)] p-1"
              buttonClassName="inline-flex items-center gap-1.5 rounded-[12px] px-2.5 py-1 text-[11px] font-medium"
              indicatorClassName="rounded-[12px] bg-[var(--ds-card-strong)] shadow-sm"
              activeClassName="text-[var(--ds-ink)]"
              inactiveClassName="text-[var(--ds-faint)] hover:text-[var(--ds-ink)]"
            />
            <p className="min-w-0 truncate text-[11px] text-[var(--ds-faint)]">
              {appearance === 'live'
                ? t('legalResearchEditVisualHint')
                : t('legalResearchEditSourceHint')}
            </p>
          </div>

          <div
            className="min-h-0 flex-1 overflow-hidden rounded-b-[16px] border border-[var(--ds-border)] bg-[var(--ds-main)]"
            aria-label={t('legalResearchEditMarkdownLabel')}
          >
            <WriteMarkdownEditor
              value={draft}
              appearance={appearance}
              livePreviewEnabled={appearance === 'live'}
              readOnly={false}
              completionModel=""
              completionEnabled={false}
              completionDebounceMs={600}
              completionMinAcceptScore={1}
              completionLongEnabled={false}
              completionLongDebounceMs={1200}
              completionLongMinAcceptScore={1}
              onChange={setDraft}
              onSelectionChange={() => undefined}
              onSaveShortcut={() => onSave(draft)}
            />
          </div>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-4 border-t border-[var(--ds-border)] px-6 py-4">
          <p className="text-[11px] text-[var(--ds-faint)]">
            {t('legalResearchEditCloseHint')}
          </p>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="inline-flex shrink-0 items-center justify-center rounded-[12px] bg-[var(--ds-accent)] px-4 py-2 text-[12px] font-medium text-white shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-card-strong)] active:scale-[0.985]"
          >
            {t('legalResearchEditSave')}
          </button>
        </footer>
      </section>
    </div>
  )
}
