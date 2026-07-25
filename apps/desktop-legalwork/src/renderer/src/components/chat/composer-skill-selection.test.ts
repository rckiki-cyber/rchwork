import { describe, expect, it } from 'vitest'
import { buildSelectedSkillPrompt } from './composer-skill-selection'

describe('buildSelectedSkillPrompt', () => {
  it('adds the selected Skill command only when building the runtime prompt', () => {
    expect(buildSelectedSkillPrompt(
      { id: 'contract-risk-review', name: '合同风险审查' },
      '请审查这份采购合同'
    )).toBe('/skill:contract-risk-review 请审查这份采购合同')
  })

  it('returns the task unchanged when no Skill is selected', () => {
    expect(buildSelectedSkillPrompt(null, '普通对话任务')).toBe('普通对话任务')
  })
})
