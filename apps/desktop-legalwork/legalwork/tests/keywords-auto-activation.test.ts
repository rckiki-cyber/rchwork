import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { SkillRuntime } from '../src/skills/skill-runtime.js'

describe('keywords auto-activation', () => {
  let root: string
  let userRoot: string
  let skillDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kw-auto-test-'))
    // 模拟 ~/.legalwork/skills（homedir 下，isUnderUserSkillRoot 判定用）
    userRoot = join(homedir(), '.legalwork', 'skills')
    skillDir = join(userRoot, 'kw-auto-contract')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: kw-auto-contract',
      'description: 审查合同的合规风险与法律条款',
      '---',
      '',
      '# 合同审查',
      '当用户要求审查合同时执行。'
    ].join('\n'), 'utf8')
    writeFileSync(join(skillDir, 'skill.json'), JSON.stringify({
      name: 'kw-auto-contract',
      description: '审查合同的合规风险与法律条款'
    }), 'utf8')
  })

  afterEach(() => {
    rmSync(skillDir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('auto-activates user skill on keyword match', async () => {
    const runtime = await SkillRuntime.create({
      enabled: true,
      roots: [userRoot, root],
      legacySkillMd: true,
      autoActivateUserSkills: true
    })
    const resolution = runtime.resolveTurn({
      prompt: '帮我审查这份合同的合规风险',
      workspace: root
    })
    expect(resolution.activeSkillIds).toContain('kw-auto-contract')
  })

  it('does not auto-activate when switch is off', async () => {
    const runtime = await SkillRuntime.create({
      enabled: true,
      roots: [userRoot, root],
      legacySkillMd: true,
      autoActivateUserSkills: false
    })
    const resolution = runtime.resolveTurn({
      prompt: '帮我审查这份合同的合规风险',
      workspace: root
    })
    expect(resolution.activeSkillIds).not.toContain('kw-auto-contract')
  })
})
