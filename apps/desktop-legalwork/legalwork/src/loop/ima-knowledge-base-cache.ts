import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type ImaKnowledgeBaseEntry = {
  id: string
  name: string
}

export type ImaKnowledgeBaseCache = {
  captured_at?: string
  count?: number
  knowledge_bases: ImaKnowledgeBaseEntry[]
}

function candidateCachePaths(): string[] {
  const paths: string[] = []
  const explicit = process.env.IMA_KNOWLEDGE_BASES_FILE
  if (explicit) paths.push(explicit)
  // IMA 凭证同目录（若 runtime 进程能拿到 IMA_CREDS_FILE）
  const creds = process.env.IMA_CREDS_FILE
  if (creds) paths.push(join(creds, '..', 'ima-knowledge-bases.json'))
  // macOS 默认 userData（开发版）
  paths.push(join(homedir(), 'Library', 'Application Support', 'legalwork', 'ima-knowledge-bases.json'))
  return paths
}

/**
 * 读取 IMA 知识库列表缓存（由 ima-mcp-server.py 在 list/research 后写入）。
 * 供 agent 在 turn 开始时知道 IMA 有哪些知识库，从而主动调用 IMA 补充
 * 文献/规范。读取失败或缓存缺失时返回 null，不阻塞任务。
 */
export function readImaKnowledgeBaseCache(): ImaKnowledgeBaseCache | null {
  for (const path of candidateCachePaths()) {
    try {
      if (!existsSync(path)) continue
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw) as ImaKnowledgeBaseCache
      if (!Array.isArray(parsed.knowledge_bases)) continue
      const entries = parsed.knowledge_bases.filter((kb) => kb?.id)
      if (entries.length === 0) continue
      return { ...parsed, knowledge_bases: entries }
    } catch {
      continue
    }
  }
  return null
}

/**
 * 生成注入给 agent 的 IMA 知识库概览指令。列出用户账号下的实际知识库，
 * 并提示涉及文献/规范/案例时优先调用 research_ima（内部自动路由选库）。
 */
export function imaKnowledgeBaseInstruction(cache: ImaKnowledgeBaseCache): string {
  const names = cache.knowledge_bases
    .map((kb) => (kb.name || kb.id).trim())
    .filter(Boolean)
  const list = names.length ? names.join('、') : '（当前未获取到知识库名称）'
  return [
    '<ima_knowledge_bases>',
    `当前 IMA 账号可用知识库（${cache.knowledge_bases.length} 个）：${list}。`,
    '涉及文献、学术观点、法律规范、案例资料补充时，主动调用 `mcp_ima_knowledge_base_research_ima`（它内部自动按库名/简介/文档标签路由选库），或用 `mcp_ima_knowledge_base_search_ima_catalog` 查看候选库。不要因为不确定 IMA 有哪些库而跳过 IMA。',
    '</ima_knowledge_bases>'
  ].join('\n')
}
