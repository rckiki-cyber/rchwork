import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildFlintChartMcpConfig,
  buildPkulawMcpConfig,
  buildWkMcpConfig,
  buildQccMcpConfig,
  buildTycMcpConfig,
  buildMcpConfig,
  customMcpConfigFragment,
  ImaConfigPanel,
  inferMarketplaceCategory,
  mcpConfigHasServer,
  mcpMarketplaceItemsFromConfigAndDiagnostics,
  mergeMarketplaceCatalogItems,
  mergeMcpJsonConfig,
  upsertMcpJsonConfig,
  skillMarketplaceItemsFromDiscoveredSkills,
  skillMarketplaceItemsFromSkillHub
} from './PluginMarketplaceView'

const mcpLabels = {
  configured: 'Configured',
  connected: 'Connected',
  connecting: 'Connecting',
  error: 'Error',
  network: 'Network required',
  disabled: 'Disabled',
  statusSummary: (status: string) => `Status: ${status}`,
  toolsSummary: (count: number) => `${count} tools`,
  errorSummary: (message: string) => `Error: ${message}`,
  pkulawTitle: 'PKULaw',
  pkulawSummary: (values: {
    total: number
    connected: number
    tools: number
    errors: number
    disabled: number
    lastError: string
  }) =>
    `${values.total} sub-services · ${values.connected} connected · ${values.tools} tools · ${values.errors} errors · ${values.disabled} disabled${values.lastError ? ` · ${values.lastError}` : ''}`,
  yuandianTitle: 'Yuandian Legal Intelligence',
  yuandianSummary: (values: {
    total: number
    connected: number
    tools: number
    errors: number
    disabled: number
    lastError: string
  }) =>
    `${values.total} sub-services · ${values.connected} connected · ${values.tools} tools · ${values.errors} errors · ${values.disabled} disabled${values.lastError ? ` · ${values.lastError}` : ''}`,
  wkTitle: 'Wolters Kluwer (WK)',
  wkSummary: (values: {
    total: number
    connected: number
    tools: number
    errors: number
    disabled: number
    lastError: string
  }) =>
    `${values.total} sub-services · ${values.connected} connected · ${values.tools} tools · ${values.errors} errors · ${values.disabled} disabled${values.lastError ? ` · ${values.lastError}` : ''}`,
  qccTitle: 'Qichacha',
  qccSummary: (values: {
    total: number
    connected: number
    tools: number
    errors: number
    disabled: number
    lastError: string
  }) =>
    `${values.total} sub-services · ${values.connected} connected · ${values.tools} tools · ${values.errors} errors · ${values.disabled} disabled${values.lastError ? ` · ${values.lastError}` : ''}`,
  tycTitle: 'Tianyancha',
  tycSummary: (values: {
    total: number
    connected: number
    tools: number
    errors: number
    disabled: number
    lastError: string
  }) =>
    `${values.total} sub-services · ${values.connected} connected · ${values.tools} tools · ${values.errors} errors · ${values.disabled} disabled${values.lastError ? ` · ${values.lastError}` : ''}`,
  tokenRequired: 'Token required',
  tokenRequiredSummary: 'Configure an access token to enable this MCP source.'
}

describe('PluginMarketplaceView MCP config helpers', () => {
  it('shows a separate re-login action for an authenticated IMA connection', () => {
    const labels: Record<string, string> = {
      pluginMcpImaTitle: 'IMA Knowledge Base',
      pluginMcpImaLoggedIn: 'Logged In',
      pluginMcpImaDesc: 'Description',
      pluginMcpImaReloginHint: 'Replace old cookies after login.',
      pluginMcpPkulawCancel: 'Cancel',
      pluginMcpImaRelogin: 'Re-login',
      pluginMcpImaReconnect: 'Reconnect'
    }
    const html = renderToStaticMarkup(createElement(ImaConfigPanel, {
      loggedIn: true,
      loggingIn: false,
      reloggingIn: false,
      onLogin: () => undefined,
      onRelogin: () => undefined,
      onCancel: () => undefined,
      t: (key: string) => labels[key] ?? key
    }))

    expect(html).toContain('Re-login')
    expect(html).toContain('Reconnect')
    expect(html).toContain('Replace old cookies after login.')
  })

  it('shows an expired IMA credential instead of reporting it as connected', () => {
    const labels: Record<string, string> = {
      pluginMcpImaTitle: 'IMA Knowledge Base',
      pluginMcpImaExpired: 'Login expired',
      pluginMcpImaDesc: 'Description',
      pluginMcpImaLoginHint: 'Scan to login.',
      pluginMcpPkulawCancel: 'Cancel',
      pluginMcpImaLogin: 'Login IMA'
    }
    const html = renderToStaticMarkup(createElement(ImaConfigPanel, {
      loggedIn: false,
      status: 'expired',
      statusMessage: 'Token expired',
      knowledgeBaseCount: 0,
      loggingIn: false,
      reloggingIn: false,
      onLogin: () => undefined,
      onRelogin: () => undefined,
      onCancel: () => undefined,
      t: (key: string) => labels[key] ?? key
    }))

    expect(html).toContain('Login expired')
    expect(html).toContain('Token expired')
    expect(html).not.toContain('pluginMcpImaLoggedIn')
  })

  it('builds Flint Chart as an optional pinned npx MCP without bundling it', () => {
    const config = buildFlintChartMcpConfig() as {
      servers: Record<string, Record<string, unknown>>
    }

    expect(config.servers['flint-chart']).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: [
        '--yes',
        'flint-chart-mcp@0.3.0',
        '--transport',
        'stdio',
        '--disable-file-reference'
      ],
      trustScope: 'user',
      timeoutMs: 180000
    })
  })

  it('merges recommended MCP servers into JSON config without dropping existing fields', () => {
    const existing = JSON.stringify({
      timeouts: { read_timeout: 120 },
      servers: {
        legalwork_schedule: { command: '/Applications/legalwork.app' }
      }
    })

    const merged = mergeMcpJsonConfig(
      existing,
      buildMcpConfig('playwright', 'npx', ['-y', '@playwright/mcp@latest'])
    )
    const parsed = JSON.parse(merged.text) as Record<string, any>

    expect(merged.alreadyExists).toBe(false)
    expect(parsed.timeouts).toEqual({ read_timeout: 120 })
    expect(parsed.servers.legalwork_schedule).toEqual({ command: '/Applications/legalwork.app' })
    expect(parsed.servers.playwright).toMatchObject({
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      trustScope: 'user'
    })
    expect(mcpConfigHasServer(merged.text, 'playwright')).toBe(true)
  })

  it('treats PKULaw endpoint servers as the single PKULaw install', () => {
    const content = JSON.stringify({
      servers: {
        'pkulaw-law-keyword': {
          transport: 'streamable-http',
          url: 'https://apim-gateway.pkulaw.com/mcp-law'
        }
      }
    })

    expect(mcpConfigHasServer(content, 'pkulaw')).toBe(true)
  })

  it('enables every PKULaw endpoint in the token config', () => {
    const config = buildPkulawMcpConfig('token')
    const servers = config.servers as Record<string, any>

    expect(Object.keys(servers)).toHaveLength(9)
    expect(Object.values(servers).every((server) => server.enabled === true)).toBe(true)
  })

  it('can install every PKULaw endpoint without persisting an Authorization header', () => {
    const config = buildPkulawMcpConfig('')
    const servers = config.servers as Record<string, any>

    expect(Object.keys(servers)).toHaveLength(9)
    expect(Object.values(servers).every((server) =>
      Object.keys(server.headers).length === 0
    )).toBe(true)
  })

  it('can re-enable previously disabled PKULaw endpoints when refreshing the token config', () => {
    const existing = JSON.stringify({
      servers: {
        'pkulaw-law-search': {
          enabled: false,
          transport: 'streamable-http',
          url: 'https://apim-gateway.pkulaw.com/mcp-law-search-service'
        }
      }
    })

    const next = JSON.parse(
      upsertMcpJsonConfig(existing, buildPkulawMcpConfig('new-token'), { preserveDisabled: false })
    ) as Record<string, any>

    expect(next.servers['pkulaw-law-search'].enabled).toBe(true)
  })

  it('treats Yuandian endpoint servers as the single Yuandian install', () => {
    const content = JSON.stringify({
      servers: {
        'yuandian-law': {
          transport: 'streamable-http',
          url: 'https://open.chineselaw.com/mcp/law/stream'
        }
      }
    })

    expect(mcpConfigHasServer(content, 'yuandian')).toBe(true)
  })

  it('treats Wolters Kluwer endpoint servers as the single WK install', () => {
    const content = JSON.stringify({
      servers: {
        'wk-integrated': {
          transport: 'streamable-http',
          url: 'https://mcp.wkinfo.com.cn/mcp-servers/integrated/'
        }
      }
    })

    expect(mcpConfigHasServer(content, 'wk')).toBe(true)
  })

  it('builds Wolters Kluwer MCP config with a Bearer token', () => {
    const config = buildWkMcpConfig('secret')
    const server = (config.servers as Record<string, any>)['wk-integrated']

    expect(server).toMatchObject({
      enabled: true,
      transport: 'streamable-http',
      url: 'https://mcp.wkinfo.com.cn/mcp-servers/integrated/',
      headers: { Authorization: 'Bearer secret' },
      trustScope: 'user'
    })
  })

  it('treats Qichacha endpoint servers as the single QCC install', () => {
    const content = JSON.stringify({
      servers: {
        'qcc-company': {
          transport: 'streamable-http',
          url: 'https://agent.qcc.com/mcp/company/stream'
        }
      }
    })

    expect(mcpConfigHasServer(content, 'qcc')).toBe(true)
  })

  it('builds Qichacha MCP config with a Bearer token on every server', () => {
    const config = buildQccMcpConfig('secret')
    const servers = config.servers as Record<string, any>

    expect(Object.keys(servers)).toEqual([
      'qcc-company',
      'qcc-risk',
      'qcc-legal-regulation',
      'qcc-legal-case',
      'qcc-tender'
    ])
    expect(servers['qcc-risk']).toMatchObject({
      enabled: true,
      transport: 'streamable-http',
      url: 'https://agent.qcc.com/mcp/risk/stream',
      headers: { Authorization: 'Bearer secret' },
      trustScope: 'user'
    })
  })

  it('treats Tianyancha endpoint servers as the single TYC install', () => {
    const content = JSON.stringify({
      servers: {
        'tyc-mcp': {
          transport: 'streamable-http',
          url: 'https://mcp.tianyancha.com/mcp'
        }
      }
    })

    expect(mcpConfigHasServer(content, 'tyc')).toBe(true)
  })

  it('builds Tianyancha MCP config with a raw Authorization header', () => {
    const config = buildTycMcpConfig('tyc_secret')
    const server = (config.servers as Record<string, any>)['tyc-mcp']

    expect(server).toMatchObject({
      enabled: true,
      transport: 'streamable-http',
      url: 'https://mcp.tianyancha.com/mcp',
      headers: { Authorization: 'tyc_secret' },
      trustScope: 'user'
    })
  })

  it('detects duplicate MCP servers instead of appending old-style snippets', () => {
    const fragment = buildMcpConfig('context7', 'npx', ['-y', '@upstash/context7-mcp@latest'])
    const first = mergeMcpJsonConfig('', fragment)
    const second = mergeMcpJsonConfig(first.text, fragment)

    expect(first.alreadyExists).toBe(false)
    expect(second.alreadyExists).toBe(true)
    expect(JSON.parse(second.text).servers.context7).toMatchObject({ command: 'npx' })
  })

  it('accepts custom JSON as either a single server or a Legalwork config fragment', () => {
    expect(customMcpConfigFragment(
      'docs',
      '{"transport":"stdio","command":"npx","args":["-y","docs-mcp"]}',
      {}
    )).toEqual({
      servers: {
        docs: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'docs-mcp']
        }
      }
    })

    expect(customMcpConfigFragment(
      'github',
      '{"capabilities":{"mcp":{"servers":{"github":{"transport":"stdio","command":"github-mcp"}}}}}',
      {}
    )).toEqual({
      servers: {
        github: {
          transport: 'stdio',
          command: 'github-mcp'
        }
      }
    })
  })

  it('detects MCP servers from full Legalwork capability config', () => {
    const content = JSON.stringify({
      capabilities: {
        mcp: {
          servers: {
            github: {
              transport: 'stdio',
              command: 'github-mcp'
            }
          }
        }
      }
    })

    expect(mcpConfigHasServer(content, 'github')).toBe(true)
  })

  it('turns configured MCP servers into personal marketplace items', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      '{"servers":{"docs":{"transport":"stdio","command":"docs-mcp"}}}',
      null,
      mcpLabels
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'docs',
        kind: 'mcp',
        group: 'personal',
        title: 'docs',
        description: expect.stringContaining('docs-mcp'),
        sourceLabel: 'Configured',
        statusTone: 'default'
      })
    ])
  })

  it('infers practical categories for MCP marketplace items', () => {
    expect(inferMarketplaceCategory({
      id: 'pkulaw',
      kind: 'mcp',
      title: 'PKULaw',
      description: 'Legal database and case search'
    })).toBe('legal')
    expect(inferMarketplaceCategory({
      id: 'playwright',
      kind: 'mcp',
      title: 'Playwright',
      description: 'Browser automation'
    })).toBe('browser')
  })

  it('merges installed and recommended legal MCP entries into one capability catalog', () => {
    const items = mergeMarketplaceCatalogItems([
      {
        id: 'pkulaw',
        kind: 'mcp',
        title: 'PKULaw catalog',
        description: 'Catalog description',
        group: 'recommended',
        category: 'legal'
      },
      {
        id: 'pkulaw',
        kind: 'mcp',
        title: 'PKULaw runtime',
        description: '9 connected services',
        group: 'personal',
        category: 'legal',
        sourceLabel: 'Connected',
        statusTone: 'success'
      },
      {
        id: 'yuandian',
        kind: 'mcp',
        title: 'Yuandian',
        description: 'Legal research source',
        group: 'recommended',
        category: 'legal'
      }
    ])

    expect(items).toHaveLength(2)
    expect(items.map((item) => item.id)).toEqual(['pkulaw', 'yuandian'])
    expect(items.every((item) => item.category === 'legal')).toBe(true)
    expect(items[0]).toMatchObject({
      title: 'PKULaw catalog',
      description: '9 connected services',
      sourceLabel: 'Connected',
      statusTone: 'success'
    })
  })

  it('overlays MCP runtime diagnostics onto configured marketplace items', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      JSON.stringify({
        servers: {
          github: {
            transport: 'stdio',
            command: 'github-mcp'
          },
          disabled_docs: {
            transport: 'stdio',
            command: 'docs-mcp',
            enabled: false
          }
        }
      }),
      {
        mcpServers: [
          { id: 'github', status: 'connected', toolCount: 12 },
          { id: 'bad', status: 'error', lastError: 'missing token' }
        ]
      },
      mcpLabels
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'bad',
        sourceLabel: 'Error',
        statusTone: 'error',
        description: expect.stringContaining('missing token')
      }),
      expect.objectContaining({
        id: 'disabled_docs',
        sourceLabel: 'Disabled',
        statusTone: 'warning'
      }),
      expect.objectContaining({
        id: 'github',
        sourceLabel: 'Connected',
        statusTone: 'success',
        description: expect.stringContaining('github-mcp')
      })
    ])
  })

  it('localizes MCP status and tool-count summaries while preserving technical values', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      JSON.stringify({
        servers: {
          playwright: {
            transport: 'stdio',
            command: '/opt/homebrew/bin/npx'
          }
        }
      }),
      {
        mcpServers: [{ id: 'playwright', status: 'connected', toolCount: 24 }]
      },
      {
        ...mcpLabels,
        configured: '已配置',
        connected: '已连接',
        connecting: '连接中',
        error: '异常',
        disabled: '未启用',
        statusSummary: (status) => `状态：${status}`,
        toolsSummary: (count) => `${count} 个工具`,
        errorSummary: (message) => `错误：${message}`
      }
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'playwright',
        sourceLabel: '已连接',
        description: '状态：已连接 · stdio · /opt/homebrew/bin/npx · 24 个工具'
      })
    ])
  })

  it('shows lenient servers (context7/playwright) as connected even when the runtime reports errors', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      JSON.stringify({
        servers: {
          context7: { transport: 'stdio', command: '/opt/homebrew/bin/npx' },
          playwright: { transport: 'stdio', command: '/opt/homebrew/bin/npx' }
        }
      }),
      {
        mcpServers: [
          { id: 'context7', status: 'error', lastError: 'MCP error -32001: Request timed out' },
          { id: 'playwright', status: 'error', lastError: 'MCP error -32001: Request timed out' }
        ]
      },
      mcpLabels
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'context7',
        sourceLabel: 'Connected',
        statusTone: 'success',
        description: expect.not.stringContaining('timed out')
      }),
      expect.objectContaining({
        id: 'playwright',
        sourceLabel: 'Connected',
        statusTone: 'success',
        description: expect.not.stringContaining('timed out')
      })
    ])
  })

  it('shows a github network failure as "network required" instead of a red error', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      JSON.stringify({
        servers: {
          github: { transport: 'stdio', command: 'github-mcp' }
        }
      }),
      {
        mcpServers: [
          { id: 'github', status: 'error', lastError: 'MCP error -32001: Request timed out' }
        ]
      },
      mcpLabels
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'github',
        sourceLabel: 'Network required',
        statusTone: 'warning',
        description: expect.not.stringContaining('timed out')
      })
    ])
  })

  it('keeps a github auth error as a red error', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      JSON.stringify({
        servers: {
          github: { transport: 'stdio', command: 'github-mcp' }
        }
      }),
      {
        mcpServers: [
          { id: 'github', status: 'error', lastError: 'HTTP 401 unauthorized' }
        ]
      },
      mcpLabels
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'github',
        sourceLabel: 'Error',
        statusTone: 'error',
        description: expect.stringContaining('401')
      })
    ])
  })

  it('groups PKULaw child endpoints into one marketplace item', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      JSON.stringify({
        servers: {
          'pkulaw-law-keyword': {
            enabled: true,
            transport: 'streamable-http',
            url: 'https://apim-gateway.pkulaw.com/mcp-law'
          },
          'pkulaw-case-keyword': {
            enabled: true,
            transport: 'streamable-http',
            url: 'https://apim-gateway.pkulaw.com/mcp-case'
          },
          docs: {
            transport: 'stdio',
            command: 'docs-mcp'
          }
        }
      }),
      {
        mcpServers: [
          { id: 'pkulaw-law-keyword', status: 'connected', toolCount: 3 },
          { id: 'pkulaw-case-keyword', status: 'error', lastError: '401' }
        ]
      },
      mcpLabels
    )

    expect(items).toEqual([
      expect.objectContaining({ id: 'docs' }),
      expect.objectContaining({
        id: 'pkulaw',
        title: 'PKULaw',
        needsToken: true,
        sourceLabel: 'Error',
        statusTone: 'error',
        description: expect.stringContaining('401')
      })
    ])
    expect(items.some((item) => item.id === 'pkulaw-law-keyword')).toBe(false)
    expect(items.some((item) => item.id === 'pkulaw-case-keyword')).toBe(false)
  })

  it('groups Yuandian child endpoints into one marketplace item', () => {
    const items = mcpMarketplaceItemsFromConfigAndDiagnostics(
      JSON.stringify({
        servers: {
          'yuandian-law': {
            enabled: true,
            transport: 'streamable-http',
            url: 'https://open.chineselaw.com/mcp/law/stream'
          },
          'yuandian-case': {
            enabled: true,
            transport: 'streamable-http',
            url: 'https://open.chineselaw.com/mcp/case/stream'
          }
        }
      }),
      {
        mcpServers: [
          { id: 'yuandian-law', status: 'connected', toolCount: 8 },
          { id: 'yuandian-case', status: 'connected', toolCount: 12 }
        ]
      },
      mcpLabels
    )

    expect(items).toEqual([
      expect.objectContaining({
        id: 'yuandian',
        title: 'Yuandian Legal Intelligence',
        needsToken: true,
        sourceLabel: 'Token required',
        statusTone: 'warning',
        description: 'Configure an access token to enable this MCP source.'
      })
    ])
    expect(items.some((item) => item.id === 'yuandian-law')).toBe(false)
    expect(items.some((item) => item.id === 'yuandian-case')).toBe(false)
  })
})

describe('skillMarketplaceItemsFromDiscoveredSkills', () => {
  it('turns discovered project and global skills into personal marketplace items', () => {
    const items = skillMarketplaceItemsFromDiscoveredSkills([
      {
        id: 'openspec-apply-change',
        name: 'Openspec Apply Change',
        description: 'Implement tasks from an OpenSpec change.',
        root: '/workspace/.codex/skills/openspec-apply-change',
        entryPath: '/workspace/.codex/skills/openspec-apply-change/SKILL.md',
        scope: 'project',
        legacy: true
      },
      {
        id: 'frontend-polish',
        name: 'Frontend Polish',
        description: 'Improve React UI details and responsive CSS.',
        root: '/Users/demo/.agents/skills/frontend-polish',
        entryPath: '/Users/demo/.agents/skills/frontend-polish/SKILL.md',
        scope: 'global',
        legacy: true
      },
      {
        id: 'legal-draft',
        name: 'Legal Draft',
        description: 'Draft legal documents.',
        root: '/Users/demo/.legalwork/skills/legal-draft',
        entryPath: '/Users/demo/.legalwork/skills/legal-draft/SKILL.md',
        scope: 'global',
        legacy: true,
        userInstalled: true
      }
    ], { project: 'Project', global: 'Global', builtin: 'Builtin', userInstalled: 'User installed' })

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'openspec-apply-change',
        group: 'personal',
        title: 'Openspec Apply Change',
        sourceLabel: 'Project',
        skillRoot: '/workspace/.codex/skills/openspec-apply-change',
        skillEntryPath: '/workspace/.codex/skills/openspec-apply-change/SKILL.md'
      }),
      expect.objectContaining({
        id: 'frontend-polish',
        group: 'personal',
        title: 'Frontend Polish',
        sourceLabel: 'Global',
        category: 'frontend'
      }),
      expect.objectContaining({
        id: 'legal-draft',
        sourceLabel: 'User installed',
        userInstalled: true
      })
    ]))
  })

  it('automatically categorizes newly discovered coding skills', () => {
    const items = skillMarketplaceItemsFromDiscoveredSkills([
      {
        id: 'bug-hunt',
        name: 'Bug Hunt',
        description: 'Debug TypeScript regressions and add focused tests.',
        root: '/Users/demo/.agents/skills/bug-hunt',
        entryPath: '/Users/demo/.agents/skills/bug-hunt/SKILL.md',
        scope: 'global',
        legacy: true
      }
    ], { project: 'Project', global: 'Global', builtin: 'Builtin', userInstalled: 'User installed' })

    expect(items[0]).toEqual(expect.objectContaining({
      id: 'bug-hunt',
      category: 'coding'
    }))
  })
})

describe('skillMarketplaceItemsFromSkillHub', () => {
  it('turns hot-list entries into one-click install cards and deduplicates slugs', () => {
    const items = skillMarketplaceItemsFromSkillHub([
      {
        slug: 'legal-research',
        name: 'Legal Research',
        description: '检索法规、案例与学术观点。',
        category: 'legal',
        downloads: 439000,
        installs: 12000,
        stars: 42,
        score: 100,
        version: '1.2.0',
        namespace: 'publisher_a',
        namespaceDisplayName: 'Publisher A',
        tags: ['law', 'research']
      },
      {
        slug: 'legal-research',
        name: 'Duplicate',
        description: '',
        category: 'other',
        downloads: 1,
        installs: 0,
        stars: 0,
        score: 0,
        version: '1.0.0',
        namespace: 'publisher_b',
        namespaceDisplayName: 'Publisher B',
        tags: []
      }
    ])

    expect(items).toEqual([expect.objectContaining({
      id: 'legal-research',
      title: 'Legal Research',
      group: 'recommended',
      sourceLabel: 'SkillHub',
      category: 'legal',
      skillHubNamespace: 'publisher_a',
      skillHubVersion: '1.2.0',
      downloads: 439000,
      stars: 42
    })])
  })

  it('maps the curated catalog tabs to legal, office, and learning presentation groups', () => {
    const base = {
      slug: 'generic-skill',
      name: 'Generic Skill',
      description: 'Generic description',
      category: 'professional',
      downloads: 10,
      installs: 1,
      stars: 1,
      score: 1,
      version: '1.0.0',
      namespace: 'publisher',
      namespaceDisplayName: 'Publisher',
      tags: []
    }

    expect(skillMarketplaceItemsFromSkillHub([base], 'legal')[0]?.category).toBe('legal')
    expect(skillMarketplaceItemsFromSkillHub([base], 'office')[0]?.category).toBe('productivity')
    expect(skillMarketplaceItemsFromSkillHub([base], 'learning')[0]?.category).toBe('research')
  })
})
