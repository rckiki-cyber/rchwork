import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import { Code2, Eye, FilePenLine, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AstryxSegmentedControl } from '../astryx/AstryxSegmentedControl'
import { WriteMarkdownEditor } from '../write/WriteMarkdownEditor'

type Props = {
  initialMarkdown: string
  onClose: () => void
  onSave: (markdown: string) => void
}

export function DocumentWritingEditorDialog({
  initialMarkdown,
  onClose,
  onSave
}: Props): ReactElement {
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
        aria-labelledby="document-writing-editor-title"
        className="flex h-[min(82vh,820px)] w-full max-w-5xl flex-col overflow-hidden rounded-[22px] border border-[var(--ds-border)] bg-[var(--ds-card-strong)] shadow-[0_28px_90px_rgba(0,0,0,0.42)]"
      >
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--ds-border)] px-6 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <FilePenLine
              className="h-4.5 w-4.5 shrink-0 text-[var(--ds-accent)]"
              strokeWidth={1.75}
            />
            <div className="min-w-0">
              <h2
                id="document-writing-editor-title"
                className="text-[16px] font-semibold text-[var(--ds-ink)]"
              >
                {t('documentWritingEditTitle')}
              </h2>
              <p className="mt-0.5 truncate text-[11px] text-[var(--ds-faint)]">
                {t('documentWritingEditHint')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('documentWritingEditClose')}
            title={t('documentWritingEditClose')}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-[var(--ds-faint)] transition-colors hover:bg-[var(--ds-sidebar-row-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)]"
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col p-5">
          <div className="flex shrink-0 items-center justify-between gap-4 rounded-t-[12px] border border-b-0 border-[var(--ds-border)] bg-[var(--ds-sidebar)] px-3 py-2">
            <AstryxSegmentedControl
              value={appearance}
              items={[
                {
                  value: 'live',
                  label: t('documentWritingEditVisualMode'),
                  icon: <Eye className="h-3.5 w-3.5" strokeWidth={1.75} />
                },
                {
                  value: 'source',
                  label: t('documentWritingEditSourceMode'),
                  icon: <Code2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                }
              ]}
              onChange={setAppearance}
              ariaLabel={t('documentWritingEditMode')}
              className="flex items-center rounded-[7px] border border-[var(--ds-border)] bg-[var(--ds-main)] p-0.5"
              buttonClassName="inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-[11px] font-medium"
              indicatorClassName="rounded-[5px] bg-[var(--ds-card-strong)] shadow-sm"
              activeClassName="text-[var(--ds-ink)]"
              inactiveClassName="text-[var(--ds-faint)] hover:text-[var(--ds-ink)]"
            />
            <p className="min-w-0 truncate text-[11px] text-[var(--ds-faint)]">
              {appearance === 'live'
                ? t('documentWritingEditVisualHint')
                : t('documentWritingEditSourceHint')}
            </p>
          </div>

          <div
            className="min-h-0 flex-1 overflow-hidden rounded-b-[12px] border border-[var(--ds-border)] bg-[var(--ds-main)]"
            aria-label={t('documentWritingEditMarkdownLabel')}
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
            {t('documentWritingEditCloseHint')}
          </p>
          <button
            type="button"
            onClick={() => onSave(draft)}
            className="inline-flex shrink-0 items-center justify-center rounded-[8px] bg-[var(--ds-accent)] px-4 py-2 text-[12px] font-medium text-white shadow-sm transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-card-strong)] active:scale-[0.985]"
          >
            {t('documentWritingEditSave')}
          </button>
        </footer>
      </section>
    </div>
  )
}
