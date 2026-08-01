import { describe, expect, it } from 'vitest'
import {
  extractResearchPlanItems,
  extractStageNumber,
  formatResearchPlanIndex,
  isResearchPlanMessage
} from './legal-research-plan'

describe('legal research plan extraction', () => {
  it('keeps the first complete numbered plan and drops later execution logs', () => {
    const reasoning = `先规划需要核验的问题：
1. 英国出生孩子的国籍问题
2. 领养人与被领养孩子的关系
3. 跨境收养程序及法律适用
4. 可能涉及的中国法、英国法与跨国公约
1. 先调用北大法宝检索法规与案例
2. 检查北大法宝 MCP 工具是否可用
3. 用户提到已经配置北大法宝。`

    expect(extractResearchPlanItems(reasoning)).toEqual([
      '英国出生孩子的国籍问题',
      '领养人与被领养孩子的关系',
      '跨境收养程序及法律适用',
      '可能涉及的中国法、英国法与跨国公约'
    ])
  })

  it('updates a partial final item without truncating its content', () => {
    expect(extractResearchPlanItems('1. 核验主体资格\n2. 检索跨境收养程序与冲突法适用')).toEqual([
      '核验主体资格',
      '检索跨境收养程序与冲突法适用'
    ])
  })

  it('normalizes inline numbering and supplies stable display numbers', () => {
    expect(extractResearchPlanItems('1. 核验国籍 2. 确认收养关系 3. 检索适用法律')).toEqual([
      '核验国籍',
      '确认收养关系',
      '检索适用法律'
    ])
    expect(formatResearchPlanIndex(0)).toBe('01')
    expect(formatResearchPlanIndex(8)).toBe('09')
    expect(formatResearchPlanIndex(9)).toBe('10')
  })

  it('rejects requirement summaries and selects the later actionable plan', () => {
    const reasoning = `根据系统指示：
1. 需要先形成调研规划（编号列表）
2. 以北大法宝作为法规和案例的主检索来源
3. 使用链接增强与引证核验工具
4. 每完成一个检索阶段，用简短独立消息说明
5. 最终报告作为最后一条独立回复

先检查可用的技能。active skill 是 web-access，我应该：
1. 先搜索可用 skills
2. 检索知识库
3. 使用北大法宝 MCP 工具检索法规和案例
4. 最终整理报告

调研规划：
1. 核验抢号软件行为可能触及的罪名及构成要件
2. 检索抢票、挂号软件相关法规和司法解释
3. 检索相似事实案例并提炼裁判规则
4. 比较不同定性路径所需的主观明知与客观行为
5. 复核核心引证并综合形成结论`

    expect(extractResearchPlanItems(reasoning)).toEqual([
      '核验抢号软件行为可能触及的罪名及构成要件',
      '检索抢票、挂号软件相关法规和司法解释',
      '检索相似事实案例并提炼裁判规则',
      '比较不同定性路径所需的主观明知与客观行为',
      '复核核心引证并综合形成结论'
    ])
  })

  it('shows no plan when reasoning contains only formatting and reporting requirements', () => {
    expect(extractResearchPlanItems(`根据用户要求：
1. 需要先形成调研规划（编号列表）
2. 每完成一个检索阶段，用简短独立消息说明
    3. 最终报告作为最后一条独立回复`)).toEqual([])
  })

  it('identifies a visible planning reply without treating stage reports as plans', () => {
    expect(isResearchPlanMessage(`## 调研规划

1. 核验鉴定机构资质与执业范围
2. 检索智能驾驶事故鉴定相关规范
3. 检索典型案例并复核来源`)).toBe(true)

    expect(isResearchPlanMessage(`**第一阶段完成**

主要结果：已完成调研规划所列法规检索。

下一步：检索案例。`)).toBe(false)
  })
})

describe('extractStageNumber', () => {
  it('extracts Chinese and Arabic stage numbers from announcements', () => {
    expect(extractStageNumber('**阶段四（案例检索）已完成**。已获取……')).toBe(4)
    expect(extractStageNumber('阶段五（责任条款核验）已完成。已核验……')).toBe(5)
    expect(extractStageNumber('阶段七（引证核验）开始。现将……')).toBe(7)
    expect(extractStageNumber('第8阶段：汇总报告')).toBe(8)
  })

  it('returns null when no stage number is present', () => {
    expect(extractStageNumber('先输出规划，然后开始调用工具。')).toBeNull()
    expect(extractStageNumber('# 调研规划')).toBeNull()
    expect(extractStageNumber('')).toBeNull()
  })
})
