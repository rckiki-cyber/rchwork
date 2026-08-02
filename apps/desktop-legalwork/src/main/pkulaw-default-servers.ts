import type { McpServerConfig } from '../../legalwork/src/contracts/capabilities.js'

/**
 * 北大法宝 MCP 默认预装的 9 个端点。
 *
 * id/url 与插件市场 PluginMarketplaceView.tsx 的 PKULAW_MCP_ENDPOINTS 保持一致
 * （URL 同时命中 runtime pkulaw-fallback-auth.ts 的端点白名单）。
 * headers 留空：runtime 检测到无 Authorization 头时自动注入随包 fallback token，
 * 实现"装好即用、免配置 token"。用户填自己的 token 时，插件市场流程会覆盖。
 */
export const PKULAW_MCP_ENDPOINTS: ReadonlyArray<{ id: string; url: string }> = [
  { id: 'pkulaw-law-keyword', url: 'https://apim-gateway.pkulaw.com/mcp-law' },
  { id: 'pkulaw-case-keyword', url: 'https://apim-gateway.pkulaw.com/mcp-case' },
  { id: 'pkulaw-law-search', url: 'https://apim-gateway.pkulaw.com/mcp-law-search-service' },
  { id: 'pkulaw-case-semantic-search', url: 'https://apim-gateway.pkulaw.com/mcp-case-search-service' },
  { id: 'pkulaw-law-item-keyword', url: 'https://apim-gateway.pkulaw.com/mcp-fatiao' },
  { id: 'pkulaw-law-recognition', url: 'https://apim-gateway.pkulaw.com/law_recognition' },
  { id: 'pkulaw-case-number-recognition', url: 'https://apim-gateway.pkulaw.com/case_number_recognition' },
  { id: 'pkulaw-citation-validator', url: 'https://apim-gateway.pkulaw.com/pku_citation_validator' },
  { id: 'pkulaw-doc-link', url: 'https://apim-gateway.pkulaw.com/add-doc-link' }
]

export const DEFAULT_PKULAW_MCP_SERVERS: Record<string, McpServerConfig> = Object.fromEntries(
  PKULAW_MCP_ENDPOINTS.map(({ id, url }) => [
    id,
    {
      enabled: true,
      transport: 'streamable-http',
      url,
      headers: {},
      env: {},
      args: [],
      trustedWorkspaceRoots: [],
      trustScope: 'user',
      timeoutMs: 30_000
    } satisfies McpServerConfig
  ])
)

/**
 * mcp.json 缺失时返回的默认配置文本，供插件市场展示"北大法宝已预装"。
 * 不写盘，仅作为展示种子；runtime 侧由 readGuiManagedMcpServers 补齐生效。
 */
export const DEFAULT_PKULAW_MCP_CONFIG_TEXT = `${JSON.stringify({ servers: DEFAULT_PKULAW_MCP_SERVERS }, null, 2)}\n`
