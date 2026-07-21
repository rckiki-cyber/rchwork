import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultLegalworkRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1
} from '../../shared/app-settings'
import { importGuiSkillFromPath, listGuiSkills, shouldSkipSkillScanEntry } from './skill-service'

describe('skill-service', () => {
  let tempRoot = ''

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'gui-skills-'))
  })

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true })
  })

  it('discovers project Codex skills from the active workspace', async () => {
    const workspaceRoot = join(tempRoot, 'workspace')
    const skillRoot = join(workspaceRoot, '.codex', 'skills', 'openspec-apply-change')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), [
      '---',
      'name: openspec-apply-change',
      'description: Implement tasks from an OpenSpec change.',
      '---',
      '',
      'Implement tasks from an OpenSpec change.'
    ].join('\n'), 'utf8')

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'openspec-apply-change',
      name: 'Openspec Apply Change',
      description: 'Implement tasks from an OpenSpec change.',
      scope: 'project'
    }))
  })

  it('keeps legacy SKILL.md entries with Chinese frontmatter names distinct', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-cn')
    const skillRoot = join(workspaceRoot, '.agents', 'skills')
    const tddRoot = join(skillRoot, 'tdd')
    const reviewRoot = join(skillRoot, 'code-review')
    await mkdir(tddRoot, { recursive: true })
    await mkdir(reviewRoot, { recursive: true })
    await writeFile(join(tddRoot, 'SKILL.md'), [
      '---',
      'name: 测试驱动开发(TDD)',
      'description: 用测试先行推进实现。',
      '---',
      '',
      '# TDD',
      '',
      '先写失败测试，再实现。'
    ].join('\n'), 'utf8')
    await writeFile(join(reviewRoot, 'SKILL.md'), [
      '---',
      'name: 代码审查',
      'description: 检查回归风险。',
      '---',
      '',
      '# Review',
      '',
      '关注正确性和测试。'
    ].join('\n'), 'utf8')

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const projectSkills = result.skills.filter((skill) => skill.root.startsWith(skillRoot))
    expect(projectSkills).toHaveLength(2)
    expect(projectSkills).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'tdd',
        name: '测试驱动开发(TDD)',
        description: '用测试先行推进实现。'
      }),
      expect.objectContaining({
        id: 'code-review',
        name: '代码审查',
        description: '检查回归风险。'
      })
    ]))
    expect(projectSkills.map((skill) => skill.id)).not.toContain('skill')
  })

  it('lists nested Harvey-style skills from project skill roots', async () => {
    const workspaceRoot = join(tempRoot, 'workspace-harvey')
    const skillRoot = join(
      workspaceRoot,
      'skills',
      'awesome-legal-aiagent-skills',
      'capital-markets',
      'prepare-ipo-risk-factors'
    )
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), [
      '---',
      'name: prepare-ipo-risk-factors',
      'task_id: capital-markets/prepare-ipo-risk-factors',
      'description: Drafts IPO risk factors and capital-markets disclosure sections for securities offerings.',
      'activates_for: [planner, solver, checker]',
      '---',
      '',
      '# Skill: IPO Risk Factors'
    ].join('\n'), 'utf8')

    const result = await listGuiSkills(createSettings(workspaceRoot), workspaceRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skills).toContainEqual(expect.objectContaining({
      id: 'capital-markets-prepare-ipo-risk-factors',
      name: 'Prepare Ipo Risk Factors',
      description: 'Drafts IPO risk factors and capital-markets disclosure sections for securities offerings.',
      scope: 'project',
      legacy: true
    }))
  })

  it('imports a local Skill folder into the user Skill root', async () => {
    const sourceRoot = join(tempRoot, 'source-skill')
    const targetRoot = join(tempRoot, 'user-skills')
    await mkdir(sourceRoot, { recursive: true })
    await writeFile(join(sourceRoot, 'SKILL.md'), [
      '---',
      'name: Source Skill',
      'description: Imported from disk.',
      '---',
      '',
      'Use this imported workflow.'
    ].join('\n'), 'utf8')

    const result = await importGuiSkillFromPath(sourceRoot, targetRoot)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.userSkillRoot).toBe(targetRoot)
    expect(result.installed).toEqual([
      expect.objectContaining({
        name: 'source-skill',
        path: join(targetRoot, 'source-skill'),
        replaced: false
      })
    ])
    await expect(readFile(join(targetRoot, 'source-skill', 'SKILL.md'), 'utf8'))
      .resolves.toContain('Imported from disk.')
  })

  it('skips macOS TCC-protected media locations during skill scans', () => {
    const home = homedir()
    // 家目录下一级媒体文件夹（读取会触发相册 / 媒体库权限弹窗）
    expect(shouldSkipSkillScanEntry(home, 'Pictures')).toBe(true)
    expect(shouldSkipSkillScanEntry(home, 'Music')).toBe(true)
    expect(shouldSkipSkillScanEntry(home, 'Movies')).toBe(true)
    // 任意深度的系统媒体库包（读取包内文件会触发 kTCCServicePhotos 等授权）
    expect(shouldSkipSkillScanEntry(home, 'Photos Library.photoslibrary')).toBe(true)
    expect(shouldSkipSkillScanEntry('/some/nested/dir', 'Photos Library.photoslibrary')).toBe(true)
    expect(shouldSkipSkillScanEntry('/some/nested/dir', 'iTunes Library.itlibrary')).toBe(true)
    expect(shouldSkipSkillScanEntry('/some/nested/dir', 'Photo Library.photolibrary')).toBe(true)
    // 正常目录不受影响
    expect(shouldSkipSkillScanEntry(home, 'Projects')).toBe(false)
    expect(shouldSkipSkillScanEntry(home, 'skills')).toBe(false)
    expect(shouldSkipSkillScanEntry('/some/nested/dir', 'my-skills')).toBe(false)
  })

  function createSettings(workspaceRoot: string): AppSettingsV1 {
    return {
      version: 1,
      locale: 'en',
      theme: 'system',
      uiFontScale: 'small',
      provider: defaultModelProviderSettings(),
      agents: { legalwork: defaultLegalworkRuntimeSettings() },
      workspaceRoot,
      log: { enabled: false, retentionDays: 7 },
      notifications: { turnComplete: true },
      appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
      keyboardShortcuts: defaultKeyboardShortcuts(),
      write: defaultWriteSettings(),
      claw: defaultClawSettings(),
      schedule: defaultScheduleSettings(),
      guiUpdate: { channel: 'stable' }
    }
  }
})
