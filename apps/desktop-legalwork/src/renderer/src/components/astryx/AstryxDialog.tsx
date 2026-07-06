import type { ReactElement, ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { AstryxIconButton } from './AstryxIconButton'

export interface AstryxDialogProps {
  open: boolean
  onClose?: () => void
  title?: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  className?: string
  closeable?: boolean
}

export function AstryxDialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  closeable = true
}: AstryxDialogProps): ReactElement | null {
  if (!open) return null

  return (
    <div
      className="ds-no-drag fixed inset-0 z-[90] flex items-center justify-center bg-black/58 px-4 py-2"
      onMouseDown={closeable ? onClose : undefined}
      role="presentation"
    >
      <div
        className={cn(
          'flex max-h-[calc(100vh-1rem)] w-full max-w-[760px] flex-col overflow-hidden rounded-[22px] border border-white/55 bg-ds-card shadow-[0_30px_90px_rgba(15,23,42,0.28)] dark:border-white/10',
          className
        )}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'astryx-dialog-title' : undefined}
        aria-describedby={description ? 'astryx-dialog-description' : undefined}
      >
        {title || closeable ? (
          <div className="flex shrink-0 items-center justify-between gap-4 border-b border-ds-border-muted px-6 py-3">
            <div className="min-w-0">
              {title ? (
                <h2 id="astryx-dialog-title" className="truncate text-[17px] font-semibold text-ds-ink">
                  {title}
                </h2>
              ) : null}
              {description ? (
                <p id="astryx-dialog-description" className="mt-0.5 text-[13px] text-ds-muted">
                  {description}
                </p>
              ) : null}
            </div>
            {closeable ? (
              <AstryxIconButton
                aria-label="Close"
                title="Close"
                onClick={onClose}
                className="shrink-0"
              >
                <X className="h-4 w-4" strokeWidth={1.7} />
              </AstryxIconButton>
            ) : null}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">{children}</div>
        {footer ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-ds-border-muted bg-ds-card px-6 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}
