import type { Dispatch, ReactElement, SetStateAction } from 'react'
import { Bot, Brain, ChevronLeft, Cpu, Globe, Keyboard, RefreshCw, Settings, Smartphone } from 'lucide-react'

type SettingsCategory = 'general' | 'model' | 'agents' | 'memory' | 'claw' | 'shortcuts' | 'guiUpdate'

export function SettingsSidebar({
  category,
  goBack,
  setCategory,
  t
}: {
  category: SettingsCategory
  goBack: () => void
  setCategory: Dispatch<SetStateAction<SettingsCategory>>
  t: (key: string) => string
}): ReactElement {
  const catCls = (c: SettingsCategory): string =>
    `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium transition ${
      category === c
        ? 'bg-ds-subtle text-ds-ink shadow-sm ring-1 ring-ds-border-muted'
        : 'text-ds-muted hover:bg-ds-hover'
    }`

  return (
    <aside
      data-sidebar-hover-root
      className="ds-drag relative flex w-[248px] shrink-0 flex-col overflow-hidden border-r border-ds-border bg-ds-sidebar backdrop-blur-md"
    >
      <span aria-hidden data-sidebar-hover-indicator />
      <div className="px-3 pb-3 pt-3">
        <div aria-hidden className="ds-titlebar-safe-block" />
        <button
          type="button"
          data-sidebar-hover-target
          onClick={goBack}
          className="ds-no-drag flex items-center gap-2 rounded-xl px-2 py-2 text-[14px] text-ds-muted hover:bg-ds-hover hover:text-ds-ink"
        >
          <ChevronLeft className="h-4 w-4" strokeWidth={1.75} />
          {t('back')}
        </button>
      </div>
      <nav className="ds-no-drag flex flex-col gap-0.5 px-2">
        <button type="button" data-sidebar-hover-target data-sidebar-active={category === 'general' ? 'true' : undefined} className={catCls('general')} onClick={() => setCategory('general')}>
          <Globe className="h-4 w-4 shrink-0 opacity-70" strokeWidth={1.75} />
          {t('general')}
        </button>
        <button type="button" data-sidebar-hover-target data-sidebar-active={category === 'model' ? 'true' : undefined} className={catCls('model')} onClick={() => setCategory('model')}>
          <Cpu className="h-4 w-4 shrink-0 opacity-70" strokeWidth={1.75} />
          {t('modelConfig')}
        </button>
        <button type="button" data-sidebar-hover-target data-sidebar-active={category === 'agents' ? 'true' : undefined} className={catCls('agents')} onClick={() => setCategory('agents')}>
          <Bot className="h-4 w-4 shrink-0 opacity-70" strokeWidth={1.75} />
          {t('agents')}
        </button>
        <button type="button" data-sidebar-hover-target data-sidebar-active={category === 'memory' ? 'true' : undefined} className={catCls('memory')} onClick={() => setCategory('memory')}>
          <Brain className="h-4 w-4 shrink-0 opacity-70" strokeWidth={1.75} />
          {t('memory')}
        </button>
        <button type="button" data-sidebar-hover-target data-sidebar-active={category === 'shortcuts' ? 'true' : undefined} className={catCls('shortcuts')} onClick={() => setCategory('shortcuts')}>
          <Keyboard className="h-4 w-4 shrink-0 opacity-70" strokeWidth={1.75} />
          {t('keyboardShortcuts')}
        </button>
        <button type="button" data-sidebar-hover-target data-sidebar-active={category === 'claw' ? 'true' : undefined} className={catCls('claw')} onClick={() => setCategory('claw')}>
          <Smartphone className="h-4 w-4 shrink-0 opacity-70" strokeWidth={1.75} />
          {t('claw')}
        </button>
        <button type="button" data-sidebar-hover-target data-sidebar-active={category === 'guiUpdate' ? 'true' : undefined} className={catCls('guiUpdate')} onClick={() => setCategory('guiUpdate')}>
          <RefreshCw className="h-4 w-4 shrink-0 opacity-70" strokeWidth={1.75} />
          {t('guiUpdate')}
        </button>
      </nav>
      <div className="ds-no-drag mt-auto border-t border-ds-border p-3">
        <div className="flex items-center gap-2 rounded-xl px-2 py-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-ds-subtle text-ds-muted">
            <Settings className="h-4 w-4" strokeWidth={1.75} />
          </div>
          <div className="min-w-0 text-[12px] text-ds-muted">
            <div className="truncate font-medium text-ds-ink">legalwork</div>
            <div className="truncate">{t('settingsFooter')}</div>
          </div>
        </div>
      </div>
    </aside>
  )
}
