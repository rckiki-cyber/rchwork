import { describe, expect, it } from 'vitest'
import { LEGALWORK_SYSTEM_PROMPT } from '../src/prompt/legalwork-system-prompt.js'

describe('LEGALWORK_SYSTEM_PROMPT', () => {
  it('defaults visible reasoning and answers to Chinese', () => {
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('visible process/reasoning text')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('Default to Simplified Chinese for internal reasoning/thinking')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('short English greetings')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('默认使用简体中文回答')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('内部思考过程也必须默认使用简体中文组织')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('reasoning_content、reasoning 或 thinking')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('选择工具、判断工具结果、排查错误和续跑任务')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('只有当用户明确要求英文输出')
  })

  it('defaults generated office documents to SimSun unless the user overrides it', () => {
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('Word, PowerPoint, PDF')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('use SimSun (宋体) as the default font for all text')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('user explicitly requests another font')
  })
})
