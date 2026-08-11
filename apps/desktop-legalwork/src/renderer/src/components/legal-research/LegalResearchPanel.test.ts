import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReturnUseLegalResearch } from './useLegalResearch'
import {
  LegalResearchPanel,
  nextSmoothResearchScrollTop,
  scrollLegalResearchToLatest,
  shouldFollowLatestResearchContent
} from './LegalResearchPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string): string => ({
      legalResearch: '法律调研',
      legalResearchReasoning: '调研规划',
      legalResearchPlanHint: '拟核验的问题、检索方向与来源安排',
      legalResearchPlanReady: '已形成',
      legalResearchUpdatesTitle: '阶段播报',
      legalResearchSummaryTitle: '调研总结',
      legalResearchStepDone: '完成'
    })[key] ?? key
  })
}))

vi.mock('../chat/AssistantMarkdown', () => ({
  AssistantMarkdown: ({ text }: { text: string }) => `markdown-rendered:${text}`
}))

describe('LegalResearchPanel section order', () => {
  it('scrolls the research viewport to the newest content when following is active', () => {
    const element = { scrollTop: 120, scrollHeight: 960, clientHeight: 240 } as HTMLDivElement
    scrollLegalResearchToLatest(element)
    expect(element.scrollTop).toBe(720)
  })

  it('moves toward a changing latest-content target without jumping or overshooting', () => {
    const firstFrame = nextSmoothResearchScrollTop(100, 500)
    const retargetedFrame = nextSmoothResearchScrollTop(firstFrame, 620)
    const slowerFrame = nextSmoothResearchScrollTop(100, 500, 8)
    const delayedFrame = nextSmoothResearchScrollTop(100, 500, 32)

    expect(firstFrame).toBeGreaterThan(100)
    expect(firstFrame).toBeLessThan(500)
    expect(retargetedFrame).toBeGreaterThan(firstFrame)
    expect(retargetedFrame).toBeLessThan(620)
    expect(slowerFrame).toBeLessThan(delayedFrame)
    expect(delayedFrame).toBeLessThan(500)
    expect(nextSmoothResearchScrollTop(619.5, 620)).toBe(620)
  })

  it('pauses following while the user reads above and resumes near the latest content', () => {
    expect(shouldFollowLatestResearchContent({
      scrollHeight: 1_200,
      scrollTop: 420,
      clientHeight: 600
    })).toBe(false)

    expect(shouldFollowLatestResearchContent({
      scrollHeight: 1_200,
      scrollTop: 590,
      clientHeight: 600
    })).toBe(true)
  })

  it('renders the plan before stage updates and the final summary', () => {
    const activeRecord = {
      id: 'research-1',
      query: '跨境收养如何适用法律？',
      timestamp: '2026/8/1 18:00:00',
      status: 'done' as const,
      blocks: [],
      steps: [],
      updates: [
        { id: 'update-1', text: '已核验主体资格。', createdAt: '2026-08-01T10:00:00Z', completed: true },
        { id: 'report', text: '最终报告', createdAt: '2026-08-01T10:01:00Z', completed: true }
      ],
      summary: '调研总结正文',
      reasoning: '1. **核验主体与国籍**：比对适用法\n2. 检索跨境收养程序',
      threadId: 'thread-1'
    }
    const legalResearch = {
      records: [activeRecord],
      activeRecord,
      activeRecordId: activeRecord.id,
      setActiveRecordId: vi.fn(),
      isResearching: false,
      runResearch: vi.fn(),
      stopResearch: vi.fn(),
      saveEditedSummary: vi.fn(),
      deleteRecord: vi.fn(),
      clearHistory: vi.fn()
    } as unknown as ReturnUseLegalResearch

    const html = renderToStaticMarkup(createElement(LegalResearchPanel, { legalResearch }))
    const planIndex = html.indexOf('调研规划')
    const updatesIndex = html.indexOf('阶段播报')
    const summaryIndex = html.indexOf('调研总结')

    expect(planIndex).toBeGreaterThanOrEqual(0)
    expect(planIndex).toBeLessThan(updatesIndex)
    expect(updatesIndex).toBeLessThan(summaryIndex)
    expect(html).toContain('>01<')
    expect(html).toContain('>02<')
    expect(html).toContain('markdown-rendered:**核验主体与国籍**：比对适用法')
    expect(html).not.toContain('legalResearchExpand')
  })
})
