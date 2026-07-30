import type { ReactElement } from 'react'
import { BookOpen, Eye, ShieldCheck } from 'lucide-react'
import { AstryxSegmentedControl } from '../astryx/AstryxSegmentedControl'

export interface WorkspaceModeTabsProps {
  activeView: 'chat' | 'dataCompliance' | 'desensitize' | 'claw' | 'schedule' | 'documentWriting' | 'write' | 'legalResearch'
  onCodeOpen: () => void
  onDataComplianceOpen: () => void
  onDesensitizeOpen?: () => void
  onWriteOpen?: () => void
}

export function WorkspaceModeTabs({
  activeView,
  onCodeOpen,
  onDataComplianceOpen,
  onDesensitizeOpen
}: WorkspaceModeTabsProps): ReactElement {
  const tabs = [
    {
      value: 'chat',
      label: '工作',
      icon: <BookOpen className="h-4 w-4" strokeWidth={1.8} />
    },
    ...(onDesensitizeOpen
      ? [{
          value: 'desensitize' as const,
          label: '脱敏',
          icon: <Eye className="h-4 w-4" strokeWidth={1.8} />
        }]
      : []),
    {
      value: 'dataCompliance',
      label: '合规',
      icon: <ShieldCheck className="h-4 w-4" strokeWidth={1.8} />
    }
  ] as const

  return (
    <AstryxSegmentedControl
      value={activeView}
      items={tabs}
      onChange={(next) => {
        if (next === 'chat') onCodeOpen()
        else if (next === 'desensitize') onDesensitizeOpen?.()
        else if (next === 'dataCompliance') onDataComplianceOpen()
      }}
      onReselect={(current) => {
        // Agent subfeatures keep Work visually selected. Clicking it again is
        // an explicit return to the existing conversation, never a new chat.
        if (current === 'chat') onCodeOpen()
      }}
      ariaLabel="work / 脱敏 / 合规"
      className="apple-mode-tabs flex flex-row rounded-[16px] bg-[#f1f5f9] p-1 dark:bg-white/[0.06]"
      buttonClassName="apple-mode-tab inline-flex min-h-[32px] min-w-fit flex-1 items-center justify-center gap-1.5 rounded-[12px] px-3 text-left text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-black/10 dark:focus-visible:ring-white/20"
      indicatorClassName="rounded-[12px] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] dark:bg-white/[0.12] dark:shadow-[0_1px_4px_rgba(0,0,0,0.2)]"
      activeClassName="font-semibold text-[#1f2937] dark:text-white"
      inactiveClassName="font-medium text-[#6b7280] hover:text-[#374151] dark:text-white/55 dark:hover:text-white/80"
    />
  )
}
