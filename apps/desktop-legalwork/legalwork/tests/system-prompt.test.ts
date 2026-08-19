import { describe, expect, it } from 'vitest'
import { LEGALWORK_SYSTEM_PROMPT } from '../src/prompt/legalwork-system-prompt.js'

describe('LEGALWORK_SYSTEM_PROMPT', () => {
  it('uses renderable Mermaid for genuinely visual connected structures', () => {
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('valid Mermaid diagram')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('ASCII arrows')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('do not add a diagram when prose or a short list is clearer')
  })

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

  it('defines automatic, confirmed, secret, update, and forget memory behavior', () => {
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('confidence >= 0.8')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('memory_search')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('"confirmed"')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('matter/client facts')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('Never store credentials')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('forget a memory')
  })

  it('uses configured legal databases and keeps official sites browser-free', () => {
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('北大法宝 (PKULaw) / 元典 / 威科先行 (WK)')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('Never open a browser to verify law')
  })

  it('keeps Legalwork native capabilities ahead of supplemental skills', () => {
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('Capability routing is Legalwork-native first')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('Supplemental skills are fallback extensions, not replacements')
    expect(LEGALWORK_SYSTEM_PROMPT).toContain('An installed Word/Office skill must not displace that path')
    expect(LEGALWORK_SYSTEM_PROMPT).not.toContain('user-installed skills take priority on their keywords')
  })
})
