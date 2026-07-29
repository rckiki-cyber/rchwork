import type { ReactElement } from 'react'
import { Check, ChevronDown, ChevronUp, Circle, Loader2, SearchCheck, X } from 'lucide-react'
import { useDocumentWriting, type DocumentWritingStageStatus } from './DocumentWritingContext'

function StageMark({ status }: { status: DocumentWritingStageStatus }): ReactElement {
  if (status === 'done') {
    return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-white"><Check className="h-3 w-3" strokeWidth={2.6} /></span>
  }
  if (status === 'running') {
    return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white"><Loader2 className="h-3 w-3 animate-spin" strokeWidth={2.2} /></span>
  }
  if (status === 'error') {
    return <span className="flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white"><X className="h-3 w-3" strokeWidth={2.6} /></span>
  }
  return <span className="flex h-5 w-5 items-center justify-center rounded-full border border-ds-border bg-ds-subtle text-ds-faint"><Circle className="h-2 w-2 fill-current" /></span>
}

export function DocumentWritingWorkflowPanel(): ReactElement | null {
  const { workflow, workflowVisibility, setWorkflowVisibility } = useDocumentWriting()
  if (workflow.status === 'idle' || workflowVisibility === 'hidden') return null

  if (workflowVisibility === 'minimized') {
    return (
      <button
        type="button"
        onClick={() => setWorkflowVisibility('expanded')}
        className="ds-no-drag fixed bottom-5 right-5 z-40 inline-flex items-center gap-2 rounded-full border border-ds-border bg-ds-card/95 px-3 py-2 text-[12px] font-semibold text-ds-ink shadow-[0_14px_34px_rgba(15,23,42,0.16)] backdrop-blur-xl"
        title="展开文书工作流"
      >
        {workflow.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : <SearchCheck className="h-3.5 w-3.5 text-emerald-500" />}
        {workflow.status === 'running' ? '文书研究进行中' : '文书研究已完成'}
        <ChevronUp className="h-3.5 w-3.5 text-ds-faint" />
      </button>
    )
  }

  const activeStage = workflow.stages.find((stage) => stage.status === 'running')
  return (
    <aside className="ds-no-drag fixed bottom-5 right-5 z-40 w-[min(360px,calc(100vw-2.5rem))] overflow-hidden rounded-[18px] border border-ds-border bg-ds-card/95 shadow-[0_22px_58px_rgba(15,23,42,0.2)] backdrop-blur-xl dark:shadow-[0_28px_72px_rgba(0,0,0,0.42)]">
      <div className="flex items-start gap-3 border-b border-ds-border-muted px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent/12 text-accent">
          {workflow.status === 'running' ? <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} /> : <SearchCheck className="h-4 w-4" strokeWidth={2} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-ds-ink">AI 文书工作流</div>
          <div className="mt-0.5 truncate text-[11px] text-ds-faint">
            {workflow.status === 'running'
              ? activeStage?.detail || '正在准备文书'
              : workflow.status === 'error'
                ? workflow.error || '本次生成未完成'
                : '材料、调研与文书已完成'}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => setWorkflowVisibility('minimized')} className="rounded-[7px] p-1.5 text-ds-faint hover:bg-ds-hover hover:text-ds-ink" title="最小化流程">
            <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
          <button type="button" onClick={() => setWorkflowVisibility('hidden')} className="rounded-[7px] p-1.5 text-ds-faint hover:bg-ds-hover hover:text-ds-ink" title="关闭流程">
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>

      <ol className="px-4 py-3">
        {workflow.stages.map((stage, index) => (
          <li key={stage.id} className="relative flex gap-2.5 pb-3 last:pb-0">
            {index < workflow.stages.length - 1 ? <span aria-hidden="true" className="absolute left-[9px] top-5 h-[calc(100%-12px)] w-px bg-ds-border-muted" /> : null}
            <span className="relative z-[1]"><StageMark status={stage.status} /></span>
            <span className="min-w-0 pt-0.5">
              <span className={`block text-[12px] font-medium ${stage.status === 'pending' ? 'text-ds-faint' : 'text-ds-ink'}`}>{stage.label}</span>
              <span className="mt-0.5 block text-[10.5px] leading-4 text-ds-faint">{stage.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      {workflow.lastTool ? <div className="border-t border-ds-border-muted px-4 py-2 text-[10.5px] text-ds-faint">已调用：{workflow.lastTool}</div> : null}
    </aside>
  )
}
