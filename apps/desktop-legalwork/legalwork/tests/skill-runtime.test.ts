import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../src/adapters/tool/local-tool-host.js'
import { LegalworkCapabilitiesConfig, type SkillsCapabilityConfig } from '../src/contracts/capabilities.js'
import type { ModelClient, ModelRequest } from '../src/ports/model-client.js'
import { SkillRuntime } from '../src/skills/skill-runtime.js'
import { bootstrapThread, makeHarness } from './loop-test-harness.js'

describe('SkillRuntime', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'legalwork-skills-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('loads manifests, legacy SKILL.md packages, and validation diagnostics', async () => {
    await writeSkill('review', {
      name: 'Review Skill',
      description: 'Review changes in the current workspace',
      version: '1.0.0',
      entry: 'REVIEW.md',
      triggers: { commands: ['/review'] }
    }, 'Review instructions')
    await mkdir(join(root, 'legacy'), { recursive: true })
    await writeFile(join(root, 'legacy', 'SKILL.md'), '# Legacy\n\nLegacy instructions', 'utf8')
    await mkdir(join(root, 'bad'), { recursive: true })
    await writeFile(join(root, 'bad', 'skill.json'), JSON.stringify({ id: 'bad' }), 'utf8')

    const runtime = await createRuntime()
    const diagnostics = runtime.diagnostics()

    expect(diagnostics.skills.map((skill) => skill.id).sort()).toEqual(['legacy', 'review-skill'])
    expect(diagnostics.skills.find((skill) => skill.id === 'review-skill')).toMatchObject({
      description: 'Review changes in the current workspace',
      version: '1.0.0'
    })
    expect(diagnostics.skills.find((skill) => skill.id === 'legacy')?.legacy).toBe(true)
    expect(diagnostics.validationErrors[0]?.message).toMatch(/expected string/i)
  })

  it('prefers an operational document Skill over an earlier incomplete duplicate', async () => {
    const brokenRoot = join(root, 'broken-root')
    const healthyRoot = join(root, 'healthy-root')
    for (const skillRoot of [brokenRoot, healthyRoot]) {
      await mkdir(skillRoot, { recursive: true })
      await writeFile(join(skillRoot, 'skill.json'), JSON.stringify({
        id: 'legal-document-formatting',
        name: 'Document',
        entry: 'SKILL.md',
        triggers: { promptPatterns: ['Word'] }
      }), 'utf8')
      await writeFile(join(skillRoot, 'SKILL.md'), 'Create Word documents.', 'utf8')
    }
    await mkdir(join(healthyRoot, 'scripts'), { recursive: true })
    await writeFile(join(healthyRoot, 'scripts', 'skill_runner.py'), 'print("ok")\n', 'utf8')

    const runtime = await SkillRuntime.create(LegalworkCapabilitiesConfig.parse({
      skills: {
        enabled: true,
        roots: [brokenRoot, healthyRoot],
        legacySkillMd: true
      }
    }).skills)

    expect(runtime.load('legal-document-formatting')?.root).toBe(healthyRoot)
    expect(runtime.diagnostics().validationErrors).toContainEqual(expect.objectContaining({
      root: brokenRoot,
      message: expect.stringContaining('incomplete duplicate')
    }))
  })

  it('uses Chinese legacy frontmatter names for diagnostics without changing folder ids', async () => {
    const skillRoot = join(root, 'tdd')
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(skillRoot, 'SKILL.md'), [
      '---',
      'name: 测试驱动开发(TDD)',
      'description: 用测试先行推进实现。',
      '---',
      '',
      '# TDD',
      '',
      '先写失败测试，再实现。'
    ].join('\n'), 'utf8')

    const runtime = await createRuntime()
    const diagnostics = runtime.diagnostics()

    expect(diagnostics.skills).toContainEqual(expect.objectContaining({
      id: 'tdd',
      name: '测试驱动开发(TDD)',
      description: '用测试先行推进实现。',
      legacy: true
    }))
  })

  it('keeps skill.json manifests with Chinese names from collapsing to one id', async () => {
    await writeSkill('review-cn', {
      name: '代码审查',
      triggers: { commands: ['/review-cn'] }
    }, 'review instructions')
    await writeSkill('requirements-cn', {
      name: '需求分析',
      triggers: { commands: ['/requirements-cn'] }
    }, 'requirements instructions')

    const runtime = await createRuntime()
    const diagnostics = runtime.diagnostics()

    expect(diagnostics.skills.map((skill) => skill.id).sort()).toEqual(['代码审查', '需求分析'])
    expect(diagnostics.validationErrors).toEqual([])
  })

  it('matches triggers deterministically and respects injection budgets', async () => {
    await writeSkill('big', {
      id: 'big',
      name: 'Big',
      priority: 10,
      triggers: { promptPatterns: ['typescript'] }
    }, 'x'.repeat(2_000))
    await writeSkill('small', {
      id: 'small',
      name: 'Small',
      triggers: { fileTypes: ['.ts'] }
    }, 'small instructions')
    const runtime = await createRuntime({ instructionBudgetBytes: 1_200 })

    const resolution = runtime.resolveTurn({
      prompt: 'Please handle TypeScript in src/app.ts',
      workspace: root
    })

    expect(resolution.activations.map((activation) => activation.skillId)).toEqual(['big', 'small'])
    expect(resolution.activeSkillIds).toEqual(['small'])
    expect(resolution.instructions[0]).toContain('small instructions')
  })

  it('matches the real document Skill for natural Chinese Word drafting requests', async () => {
    const manifestPath = fileURLToPath(new URL('../../../../skills/legal_document_formatting/skill.json', import.meta.url))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      triggers: { promptPatterns: string[] }
    }
    const matches = (prompt: string) => manifest.triggers.promptPatterns.some(
      (pattern) => new RegExp(pattern, 'i').test(prompt)
    )

    expect(matches('写一篇文献综述word')).toBe(true)
    expect(matches('请撰写法律调研报告并给我Word文档')).toBe(true)
    expect(matches('你怎么还不给我word？')).toBe(true)
  })

  it('activates only the unified PPT Skill for presentation creation', async () => {
    const openKimiRoot = fileURLToPath(new URL('../../../../skills/open-kimi-ppt', import.meta.url))
    const genericDocumentRoot = fileURLToPath(new URL('../../../../skills/legal_document_formatting', import.meta.url))
    const config = LegalworkCapabilitiesConfig.parse({
      skills: {
        enabled: true,
        roots: [openKimiRoot, genericDocumentRoot],
        legacySkillMd: true,
        autoActivateUserSkills: true
      }
    })
    const runtime = await SkillRuntime.create(config.skills, { instructionBudgetBytes: 24_000 })

    const resolution = runtime.resolveTurn({
      prompt: '请制作民法典解读 PPT 演示文稿',
      workspace: root
    })

    expect(resolution.activations.map((activation) => activation.skillId)).toEqual(['open-kimi-ppt'])
    expect(resolution.activeSkillIds).toEqual(['open-kimi-ppt'])
    expect(resolution.instructions.join('\n')).toContain('PPTD')
    expect(resolution.instructions.join('\n')).toContain(openKimiRoot)
    expect(resolution.instructions.join('\n')).toContain('never guess ~/.legalwork/skills')
  })

  it('declares retrieval, IMA, and Word delivery tools in the real contract review Skill', async () => {
    const manifestPath = fileURLToPath(new URL('../../../../skills/contract_risk_review/skill.json', import.meta.url))
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { allowedTools: string[] }

    expect(manifest.allowedTools).toEqual(expect.arrayContaining([
      'knowledge_auto_retrieve',
      'knowledge_search',
      'knowledge_read_file',
      'mcp_search',
      'mcp_call',
      'mcp_ima_knowledge_base_research_ima',
      'document_skill_execute'
    ]))
  })

  it('injects allowed tool constraints and blocks omitted tools', async () => {
    await writeSkill('readonly', {
      id: 'readonly',
      name: 'Readonly',
      triggers: { commands: ['/readonly'] },
      allowedTools: ['read']
    }, 'Use read only')
    await writeSkill('mutating', {
      id: 'mutating',
      name: 'Mutating',
      triggers: { commands: ['/mutating'] },
      allowedTools: ['bash']
    }, 'Use bash')
    const runtime = await createRuntime()
    const resolution = runtime.resolveTurn({
      prompt: '/readonly inspect',
      workspace: root
    })

    expect(resolution.allowedToolNames).toEqual(['read'])
    expect(runtime.diagnostics().lastInjection?.blockedToolNames).toEqual(expect.arrayContaining(['bash']))

    const readTool = LocalToolHost.defineTool({
      name: 'read',
      description: 'read',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const bashTool = LocalToolHost.defineTool({
      name: 'bash',
      description: 'bash',
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async () => ({ output: { ok: true } })
    })
    const host = new LocalToolHost({
      registry: new CapabilityRegistry([
        { id: 'builtin', kind: 'built-in', enabled: true, available: true, tools: [readTool, bashTool] }
      ])
    })
    const context = {
      threadId: 'thr',
      turnId: 'turn',
      workspace: root,
      approvalPolicy: 'auto' as const,
      abortSignal: new AbortController().signal,
      awaitApproval: async () => 'allow' as const,
      allowedToolNames: resolution.allowedToolNames
    }

    expect((await host.listTools(context)).map((tool) => tool.name)).toEqual(['read'])
    await expect(
      host.execute({ callId: 'call_1', toolName: 'bash', arguments: {} }, context)
    ).rejects.toThrow(/active tool policy/)
  })

  it('refreshes Skill roots without recreating the runtime', async () => {
    const runtime = await createRuntime()
    expect(runtime.count()).toBe(0)

    await writeSkill('new-skill', {
      id: 'new',
      name: 'New',
      triggers: { commands: ['/new'] }
    }, 'new instructions')
    await runtime.refresh()

    expect(runtime.count()).toBe(1)
    expect(runtime.resolveTurn({ prompt: '/new run', workspace: root }).activeSkillIds).toEqual(['new'])
  })

  it('uses keyword matching for on-demand search without auto-injecting legacy Skills', async () => {
    await mkdir(join(root, 'capital-markets', 'prepare-ipo-risk-factors'), { recursive: true })
    await writeFile(join(root, 'capital-markets', 'prepare-ipo-risk-factors', 'SKILL.md'), [
      '---',
      'name: prepare-ipo-risk-factors',
      'description: Drafts IPO risk factors and securities offering disclosure.',
      '---',
      '',
      '# IPO Risk Factors',
      '',
      'Draft risk-factor disclosure.'
    ].join('\n'), 'utf8')
    const runtime = await createRuntime()

    const matches = runtime.search({ query: 'prepare IPO risk factors for a securities offering' })
    const resolution = runtime.resolveTurn({
      prompt: 'prepare IPO risk factors for a securities offering',
      workspace: root
    })

    expect(matches[0]).toMatchObject({
      id: 'prepare-ipo-risk-factors',
      reason: 'keywords'
    })
    expect(resolution.activeSkillIds).toEqual([])
    expect(runtime.load('prepare-ipo-risk-factors')?.instructions).toContain('Draft risk-factor disclosure.')
  })

  it('injects active Skills into AgentLoop context and turn metadata', async () => {
    await writeSkill('review', {
      id: 'review',
      name: 'Review',
      triggers: { promptPatterns: ['review'] },
      allowedTools: ['read']
    }, 'Always inspect the diff first.')
    const skillRuntime = await createRuntime()
    let seenRequest: ModelRequest | undefined
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequest = request
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      skillRuntime,
      tools: [
        LocalToolHost.defineTool({
          name: 'read',
          description: 'read',
          inputSchema: { type: 'object' },
          policy: 'auto',
          execute: async () => ({ output: {} })
        }),
        LocalToolHost.defineTool({
          name: 'bash',
          description: 'bash',
          inputSchema: { type: 'object' },
          policy: 'auto',
          execute: async () => ({ output: {} })
        })
      ]
    })
    await bootstrapThread(h, { workspace: root, request: { prompt: 'please review this change' } })

    await h.loop.runTurn(h.threadId, h.turnId)

    expect([
      ...(seenRequest?.prefixInstructions ?? []),
      ...(seenRequest?.contextInstructions ?? [])
    ].join('\n')).toContain('Always inspect the diff first.')
    expect(seenRequest?.tools.map((tool) => tool.name)).toEqual(['read'])
    const turn = await h.turns.getTurn(h.threadId, h.turnId)
    expect(turn?.activeSkillIds).toEqual(['review'])
    expect(turn?.skillInjectionBytes).toBeGreaterThan(0)
  })

  it('does not fail the turn when a requested document executor is skipped', async () => {
    await writeSkill('document', {
      id: 'legal-document-formatting',
      name: 'Document',
      triggers: { promptPatterns: ['写.*word'] }
    }, 'Create the file with document_skill_execute.')
    const skillRuntime = await createRuntime()
    let seenRequest: ModelRequest | undefined
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequest = request
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      skillRuntime,
      tools: [
        LocalToolHost.defineTool({
          name: 'document_skill_execute',
          description: 'create a document',
          inputSchema: { type: 'object' },
          policy: 'auto',
          execute: async () => ({ output: { status: 'ok', operation: 'from-markdown' } })
        })
      ]
    })
    await bootstrapThread(h, { workspace: root, request: { prompt: '写一篇文献综述word' } })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(seenRequest?.requiredToolName).toBe('document_skill_execute')
    expect(seenRequest?.tools.map((tool) => tool.name)).toEqual(['document_skill_execute'])
  })

  it('does not auto-activate file formatting for inline document-writing UI prompts', async () => {
    await writeSkill('document', {
      id: 'legal-document-formatting',
      name: 'Document',
      triggers: { promptPatterns: ['撰写.*法律意见书'] }
    }, 'Create the file with document_skill_execute.')
    const skillRuntime = await createRuntime()

    const resolution = skillRuntime.resolveTurn({
      workspace: root,
      prompt: '<inline_document_response>请撰写法律意见书</inline_document_response>'
    })

    expect(resolution.activeSkillIds).not.toContain('legal-document-formatting')
  })

  it('hands PPT-only creation to open-kimi-ppt instead of forcing the generic document executor', async () => {
    const requests: ModelRequest[] = []
    let bashCalls = 0
    const executedBashCommands: string[] = []
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        requests.push(request)
        if (request.requiredToolName === 'bash') {
          bashCalls += 1
          if (bashCalls === 1) {
            yield {
              kind: 'assistant_text_delta',
              text: [
                '<｜｜DSML｜｜tool_calls>',
                '<｜｜DSML｜｜invoke name="bash">',
                '<｜｜DSML｜｜parameter name="command" string="true">node --version</｜｜DSML｜｜parameter>',
                '</｜｜DSML｜｜invoke>',
                '<｜｜DSML｜｜invoke name="bash">',
                '<｜｜DSML｜｜parameter name="command" string="true">python3 /opt/legalwork/skills/open-kimi-ppt/scripts/skill_runner.py check /tmp/deck/deck.pptd --scenario education-training</｜｜DSML｜｜parameter>',
                '</｜｜DSML｜｜invoke>',
                '</｜｜DSML｜｜tool_calls>'
              ].join('\n')
            }
            yield { kind: 'completed', stopReason: 'stop' }
            return
          }
          yield {
            kind: 'tool_call_complete',
            callId: `call_ppt_${bashCalls}`,
            toolName: 'bash',
            arguments: {
              command: [
                'python3 /opt/legalwork/skills/open-kimi-ppt/scripts/skill_runner.py export',
                '/tmp/deck/deck.pptd --scenario education-training --output /tmp/deck/deck.pptx'
              ].join(' ')
            }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: 'PPTD 项目和 PPTX 已生成。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const define = (name: string) => LocalToolHost.defineTool({
      name,
      description: name,
      inputSchema: { type: 'object' },
      policy: 'auto',
      execute: async (args) => {
        if (name === 'bash') executedBashCommands.push(String(args.command))
        return { output: name === 'bash' && String(args.command).includes('skill_runner.py export')
          ? {
              exit_code: 0,
              output: JSON.stringify({
                engine: 'open-kimi-ppt',
                exporter: 'local-python-pptx',
                styleValidated: true,
                scenario: 'education-training',
                slides: 12,
                bytes: 48_000,
                output: '/tmp/deck/deck.pptx'
              })
            }
          : { exit_code: 0, output: String(args.command).includes('skill_runner.py check') ? '{"styleValidated":true}' : 'v22.0.0' }
        }
      }
    })
    const h = makeHarness(model, {
      skillRuntime: {
        resolveTurn: () => ({
          activeSkillIds: ['open-kimi-ppt'],
          activations: [],
          instructions: ['Use the PPTD specialist workflow.'],
          allowedToolNames: ['document_skill_execute'],
          injectedBytes: 100
        })
      } as never,
      tools: ['read', 'write', 'edit', 'bash', 'document_skill_execute'].map(define)
    })
    await bootstrapThread(h, {
      workspace: root,
      request: { prompt: '请制作一份民法典解读 PPT 演示文稿并交付 .pptx' }
    })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(requests).toHaveLength(3)
    expect(requests[0]?.requiredToolName).toBe('bash')
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['bash']))
    expect(requests[1]?.requiredToolName).toBe('bash')
    expect(requests[1]?.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['bash']))
    expect(requests[2]?.tools).toEqual([])
    expect(executedBashCommands).toHaveLength(3)
    expect(executedBashCommands[0]).toBe('node --version')
    expect(executedBashCommands[1]).toContain('skill_runner.py check')
    expect(executedBashCommands[2]).toContain('skill_runner.py export')
    expect(requests.every((request) =>
      !request.tools.some((tool) => tool.name === 'document_skill_execute')
    )).toBe(true)
    expect(requests[0]?.contextInstructions?.join('\n')).toContain('open-kimi-ppt / PPTD')
    expect(requests[1]?.contextInstructions?.join('\n')).toContain('scripts/skill_runner.py')
    expect(requests[1]?.contextInstructions?.join('\n')).toContain('--scenario education-training')
  })

  it('finishes immediately after one successful Word artifact generation', async () => {
    await writeSkill('document', {
      id: 'legal-document-formatting',
      name: 'Document',
      triggers: { promptPatterns: ['写.*word'] }
    }, 'Create the file with document_skill_execute.')
    const skillRuntime = await createRuntime()
    const requests: ModelRequest[] = []
    let executions = 0
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        requests.push(request)
        if (requests.length === 1) {
          yield {
            kind: 'tool_call_complete',
            callId: 'call_document',
            toolName: 'document_skill_execute',
            arguments: {
              kind: 'docx',
              operation: 'from-markdown',
              content: '# 完整文献综述\n\n'.concat('正文。'.repeat(5_000)),
              outputPath: '综述.docx'
            }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: '文档已生成。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      skillRuntime,
      tools: [LocalToolHost.defineTool({
        name: 'document_skill_execute',
        description: 'create a document',
        inputSchema: { type: 'object' },
        policy: 'auto',
        execute: async () => {
          executions += 1
          return { output: { status: 'ok', operation: 'from-markdown', output: '综述.docx' } }
        }
      })]
    })
    await bootstrapThread(h, { workspace: root, request: { prompt: '写一篇文献综述word' } })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(executions).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(['document_skill_execute'])
    const items = await h.sessionStore.loadItems(h.threadId)
    expect(items.at(-1)).toMatchObject({
      kind: 'assistant_text',
      text: 'Word 文档已生成：\n\n综述.docx'
    })
  })

  it('keeps the document executor available without failing when Skill activation is unavailable', async () => {
    const requests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        requests.push(request)
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      tools: [LocalToolHost.defineTool({
        name: 'document_skill_execute',
        description: 'create a document',
        inputSchema: { type: 'object' },
        policy: 'auto',
        execute: async () => ({ output: { status: 'ok', operation: 'from-markdown' } })
      })]
    })
    await bootstrapThread(h, { workspace: root, request: { prompt: '写一篇文献综述word' } })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(requests[0]?.requiredToolName).toBe('document_skill_execute')
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(['document_skill_execute'])
  })

  it('does not force document creation for an informational Word-format question', async () => {
    await writeSkill('document', {
      id: 'legal-document-formatting',
      name: 'Document',
      triggers: { promptPatterns: ['Word'] }
    }, 'Use document_skill_execute only when an artifact is requested.')
    const skillRuntime = await createRuntime()
    let seenRequest: ModelRequest | undefined
    const model: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request) {
        seenRequest = request
        yield { kind: 'assistant_text_delta', text: '一般使用标准页边距。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const h = makeHarness(model, {
      skillRuntime,
      tools: [LocalToolHost.defineTool({
        name: 'document_skill_execute',
        description: 'create a document',
        inputSchema: { type: 'object' },
        policy: 'auto',
        execute: async () => ({ output: { status: 'ok', operation: 'from-markdown' } })
      })]
    })
    await bootstrapThread(h, { workspace: root, request: { prompt: '如何设置 Word 的页边距？' } })

    const status = await h.loop.runTurn(h.threadId, h.turnId)

    expect(status).toBe('completed')
    expect(seenRequest?.requiredToolName).toBeUndefined()
  })

  async function createRuntime(options: Parameters<typeof SkillRuntime.create>[1] = {}) {
    const config = LegalworkCapabilitiesConfig.parse({
      skills: {
        enabled: true,
        roots: [root],
        legacySkillMd: true,
        autoActivateUserSkills: true
      }
    })
    return SkillRuntime.create(config.skills as SkillsCapabilityConfig, options)
  }

  async function writeSkill(
    folder: string,
    manifest: Record<string, unknown>,
    entry: string
  ): Promise<void> {
    const dir = join(root, folder)
    await mkdir(dir, { recursive: true })
    const entryName = typeof manifest.entry === 'string' ? manifest.entry : 'SKILL.md'
    await writeFile(join(dir, 'skill.json'), JSON.stringify(manifest), 'utf8')
    await writeFile(join(dir, entryName), entry, 'utf8')
  }
})
