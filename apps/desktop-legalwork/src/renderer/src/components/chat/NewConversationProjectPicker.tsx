import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Folder, FolderPlus, FolderX, Search } from 'lucide-react'
import type { NormalizedThread } from '../../agent/types'
import { workspaceLabelFromPath } from '../../lib/workspace-label'
import { normalizeWorkspaceRoot, workspaceRootIdentityKey } from '../../lib/workspace-path'
import {
  isNoProjectWorkspaceRoot,
  NO_PROJECT_WORKSPACE_ROOT
} from '@shared/workspace-context'
import { buildSidebarWorkspaceGroups } from './SidebarProjectsSection'

type Props = {
  threads: NormalizedThread[]
  workspaceRoot: string
  workspaceRoots: string[]
  runtimeReady: boolean
  onSelectWorkspace: (workspaceRoot: string) => void
  onPickWorkspace: () => void
  onClearWorkspace: () => void
  t: (key: string, options?: Record<string, unknown>) => string
}

type ProjectPickerMenuPosition = {
  left: number
  bottom: number
  width: number
}

export function projectPickerMenuPosition(
  triggerRect: Pick<DOMRect, 'left' | 'top'>,
  viewportWidth: number,
  viewportHeight: number
): ProjectPickerMenuPosition {
  const viewportPadding = 24
  const width = Math.min(420, Math.max(0, viewportWidth - viewportPadding * 2))
  const left = Math.min(
    Math.max(viewportPadding, triggerRect.left),
    Math.max(viewportPadding, viewportWidth - viewportPadding - width)
  )
  return {
    left,
    bottom: Math.max(viewportPadding, viewportHeight - triggerRect.top + 8),
    width
  }
}

export function shouldDismissProjectPicker(
  target: Node,
  root: Pick<Node, 'contains'> | null,
  menu: Pick<Node, 'contains'> | null
): boolean {
  return !root?.contains(target) && !menu?.contains(target)
}

function workspaceContextLabel(workspacePath: string, folderName: string): string {
  const normalized = workspacePath.replace(/[/\\]+$/, '')
  const parts = normalized.split(/[/\\]/).filter(Boolean)
  if (parts.length < 2) return ''
  const parent = parts[parts.length - 2] ?? ''
  if (!parent || parent.toLowerCase() === folderName.toLowerCase()) return ''
  return parent
}

function positionProjectPickerHover(
  menu: HTMLDivElement | null,
  target: HTMLButtonElement | null
): void {
  if (!menu || !target) return
  const indicator = menu.querySelector<HTMLElement>('[data-project-picker-hover-indicator]')
  if (!indicator) return
  const menuRect = menu.getBoundingClientRect()
  const targetRect = target.getBoundingClientRect()
  const scaleX = menu.offsetWidth > 0 ? menuRect.width / menu.offsetWidth : 1
  const scaleY = menu.offsetHeight > 0 ? menuRect.height / menu.offsetHeight : 1
  indicator.style.setProperty(
    '--project-picker-hover-x',
    `${(targetRect.left - menuRect.left) / scaleX}px`
  )
  indicator.style.setProperty(
    '--project-picker-hover-y',
    `${(targetRect.top - menuRect.top) / scaleY}px`
  )
  indicator.style.setProperty('--project-picker-hover-width', `${targetRect.width / scaleX}px`)
  indicator.style.setProperty('--project-picker-hover-height', `${targetRect.height / scaleY}px`)
  menu.setAttribute('data-project-picker-hover-active', 'true')
}

export function NewConversationProjectPicker({
  threads,
  workspaceRoot,
  workspaceRoots,
  runtimeReady,
  onSelectWorkspace,
  onPickWorkspace,
  t
}: Props): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [menuPosition, setMenuPosition] = useState<ProjectPickerMenuPosition | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const hoverTargetRef = useRef<HTMLButtonElement | null>(null)
  const hoverPointRef = useRef<{ clientX: number; clientY: number } | null>(null)
  const selectedWorkspace = normalizeWorkspaceRoot(workspaceRoot)
  const selectedWorkspaceKey = workspaceRootIdentityKey(selectedWorkspace)
  const noProjectSelected = isNoProjectWorkspaceRoot(selectedWorkspace)

  const groups = useMemo(() => {
    return buildSidebarWorkspaceGroups({
      threads,
      searchQuery: query,
      showArchived: false,
      workspaceRoot,
      workspaceRoots
    }).filter(([workspacePath]) => !isNoProjectWorkspaceRoot(workspacePath))
  }, [query, threads, workspaceRoot, workspaceRoots])

  const updateMenuPosition = useCallback((): void => {
    const triggerRect = rootRef.current?.getBoundingClientRect()
    if (!triggerRect) return
    setMenuPosition(
      projectPickerMenuPosition(triggerRect, window.innerWidth, window.innerHeight)
    )
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!shouldDismissProjectPicker(event.target as Node, rootRef.current, menuRef.current)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const items = Array.from(
          menuRef.current?.querySelectorAll('[role="menuitem"], [role="menuitemradio"]') ?? []
        )
        if (items.length === 0) return
        const active = document.activeElement
        let index = items.indexOf(active as Element)
        if (index === -1) {
          index = event.key === 'ArrowDown' ? -1 : items.length
        }
        const nextIndex =
          event.key === 'ArrowDown'
            ? (index + 1) % items.length
            : (index - 1 + items.length) % items.length
        const next = items[nextIndex] as HTMLElement | undefined
        next?.focus()
      }
    }
    updateMenuPosition()
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', updateMenuPosition)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', updateMenuPosition)
    }
  }, [open, updateMenuPosition])

  const toggleOpen = (): void => {
    if (!open) updateMenuPosition()
    setOpen((value) => !value)
  }

  const selectWorkspace = (nextWorkspaceRoot: string): void => {
    setOpen(false)
    onSelectWorkspace(nextWorkspaceRoot)
  }

  const pickWorkspace = (): void => {
    setOpen(false)
    onPickWorkspace()
  }

  const clearWorkspace = (): void => {
    setOpen(false)
    onSelectWorkspace(NO_PROJECT_WORKSPACE_ROOT)
  }

  const hideProjectPickerHover = (): void => {
    menuRef.current?.removeAttribute('data-project-picker-hover-active')
    hoverTargetRef.current = null
  }

  const updateProjectPickerHover = (origin: Element, force = false): void => {
    const menu = menuRef.current
    const target = origin.closest<HTMLButtonElement>('[data-project-picker-hover-target]')
    if (!menu || !target || !menu.contains(target)) {
      hideProjectPickerHover()
      return
    }
    if (!force && target === hoverTargetRef.current) return
    positionProjectPickerHover(menu, target)
    hoverTargetRef.current = target
  }

  const handleMenuPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    hoverPointRef.current = { clientX: event.clientX, clientY: event.clientY }
    if (event.target instanceof Element) updateProjectPickerHover(event.target)
  }

  const handleMenuPointerLeave = (): void => {
    hoverPointRef.current = null
    const active = document.activeElement
    if (
      active instanceof HTMLButtonElement
      && active.hasAttribute('data-project-picker-hover-target')
      && menuRef.current?.contains(active)
    ) {
      positionProjectPickerHover(menuRef.current, active)
      hoverTargetRef.current = active
      return
    }
    hideProjectPickerHover()
  }

  const handleMenuScroll = (): void => {
    const point = hoverPointRef.current
    if (!point) return
    const origin = document.elementFromPoint(point.clientX, point.clientY)
    if (origin instanceof Element) updateProjectPickerHover(origin, true)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={!runtimeReady}
        onClick={toggleOpen}
        className="ds-no-drag flex h-8 max-w-[min(72vw,360px)] min-w-0 items-center gap-2 rounded-[12px] px-2 text-[14px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        aria-haspopup="menu"
        aria-expanded={open}
        title={runtimeReady ? t('newConversationProjectPickerTitle') : t('runtimeActionNeedsConnection')}
      >
        <Folder className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 truncate">{workspaceLabelFromPath(selectedWorkspace)}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ds-faint" strokeWidth={2} />
      </button>

      {open && menuPosition && typeof document !== 'undefined'
        ? createPortal(
          <>
            <div
              aria-hidden="true"
              className="ds-no-drag fixed inset-0 z-[49]"
              onPointerDown={() => setOpen(false)}
            />
            <div
              ref={menuRef}
              role="menu"
              data-project-picker-hover-root
              onPointerMove={handleMenuPointerMove}
              onPointerLeave={handleMenuPointerLeave}
              onScrollCapture={handleMenuScroll}
              className="ds-no-drag fixed z-50 overflow-hidden rounded-[16px] border border-ds-border bg-ds-elevated shadow-[0_24px_70px_rgba(44,55,78,0.18)] backdrop-blur-xl dark:shadow-[0_30px_80px_rgba(0,0,0,0.42)]"
              style={menuPosition}
            >
              <span aria-hidden data-project-picker-hover-indicator />
              <div className="flex items-center gap-2 border-b border-ds-border-muted px-4 py-3">
                <Search className="h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.8} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('newConversationProjectSearch')}
                  className="min-w-0 flex-1 bg-transparent text-[15px] text-ds-ink outline-none placeholder:text-ds-faint"
                  autoFocus
                />
              </div>

              <div className="max-h-[320px] overflow-y-auto px-3 py-3">
                {groups.length === 0 ? (
                  <div className="px-1 py-3 text-[13px] text-ds-faint">
                    {t('newConversationProjectEmpty')}
                  </div>
                ) : null}

                {groups.map(([workspacePath]) => {
                  const label = workspaceLabelFromPath(workspacePath)
                  const context = workspaceContextLabel(workspacePath, label)
                  const selected = workspaceRootIdentityKey(workspacePath) === selectedWorkspaceKey
                  return (
                    <button
                      key={workspacePath}
                      type="button"
                      role="menuitemradio"
                      data-project-picker-hover-target
                      aria-checked={selected}
                      onFocus={(event) => updateProjectPickerHover(event.currentTarget, true)}
                      onClick={() => selectWorkspace(workspacePath)}
                      className="flex w-full items-start gap-3 rounded-[12px] px-1 py-2.5 text-left text-ds-ink transition focus-visible:outline-none"
                      title={workspacePath}
                    >
                      <Folder className="mt-0.5 h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.75} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-medium">{label}</span>
                        {context ? (
                          <span className="mt-0.5 block truncate text-[12px] text-ds-faint">{context}</span>
                        ) : null}
                      </span>
                      {selected ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-ds-muted" strokeWidth={2} /> : null}
                    </button>
                  )
                })}
              </div>

              <div className="border-t border-ds-border-muted px-3 py-3">
                <button
                  type="button"
                  role="menuitem"
                  data-project-picker-hover-target
                  onFocus={(event) => updateProjectPickerHover(event.currentTarget, true)}
                  onClick={pickWorkspace}
                  className="flex w-full items-center gap-3 rounded-[12px] px-1 py-2 text-left text-[14px] font-medium text-ds-ink transition focus-visible:outline-none"
                >
                  <FolderPlus className="h-4 w-4 shrink-0 text-ds-muted" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">{t('newConversationProjectAdd')}</span>
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  data-project-picker-hover-target
                  aria-checked={noProjectSelected}
                  onFocus={(event) => updateProjectPickerHover(event.currentTarget, true)}
                  onClick={clearWorkspace}
                  className="flex w-full items-center gap-3 rounded-[12px] px-1 py-2 text-left text-[14px] font-medium text-ds-muted transition hover:text-ds-ink focus-visible:outline-none"
                >
                  <FolderX className="h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">{t('newConversationProjectNone')}</span>
                  {noProjectSelected ? (
                    <Check className="h-4 w-4 shrink-0 text-ds-muted" strokeWidth={2} />
                  ) : null}
                </button>
              </div>
            </div>
          </>,
          document.body
        )
        : null}
    </div>
  )
}
