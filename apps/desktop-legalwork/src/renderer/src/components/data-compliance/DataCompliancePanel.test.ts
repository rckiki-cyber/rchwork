import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  DataCompliancePanel,
  DataComplianceSidebarNav,
  DesensitizeSidebarNav
} from './DataCompliancePanel'

describe('data compliance history navigation', () => {
  it('renders compliance history as an expandable sidebar group', () => {
    const html = renderToStaticMarkup(
      createElement(DataComplianceSidebarNav, {
        activeSection: 'history',
        onSectionChange: vi.fn()
      })
    )

    expect(html).toContain('历史任务')
    expect(html).toContain('0 项任务')
    expect(html).toContain('暂无历史任务')
    expect(html).toContain('结果查询')
  })

  it('uses the same expandable history hierarchy for desensitization', () => {
    const html = renderToStaticMarkup(
      createElement(DesensitizeSidebarNav, {
        activeSection: 'results',
        onSectionChange: vi.fn()
      })
    )

    expect(html).toContain('材料脱敏')
    expect(html).toContain('脱敏记录')
    expect(html).toContain('0 项任务')
    expect(html).toContain('暂无历史任务')
  })

  it('shows privacy-aware standard and Agent-enhanced choices before submission', () => {
    const html = renderToStaticMarkup(
      createElement(DataCompliancePanel, {
        activeSection: 'review',
        onSectionChange: vi.fn(),
        modeScope: 'desensitize',
        desensitizeKind: 'material'
      })
    )

    expect(html).toContain('标准脱敏')
    expect(html).toContain('Agent 增强')
    expect(html).toContain('不读取完整原文')
    expect(html).toContain('PDF 文档 (.pdf)')
  })
})
