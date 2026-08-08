#!/usr/bin/env node
/**
 * 导出所有知识库相关对话 thread 为单个整合 traj（JSONL），供外部 AI 分析。
 *
 * 筛选：thread 标题含 知识库/knowledge/检索/调研/法律/案/合同/文书/案例/ima
 * 输出：{outputDir}/traj_知识库全量_{date}.jsonl
 *
 * 每个 thread 转成统一事件类型：
 *   meta / user_message / tool_call / tool_result / assistant_message
 * 所有 thread 按创建时间合并，带 threadId 前缀便于区分。
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const THREADS_DIR = process.env.LEGALWORK_THREADS_DIR || '/Users/xiangyang/.legalwork/legalwork/threads'
const OUTPUT_DIR = process.env.LEGALWORK_TRAJ_OUTPUT || '/Users/xiangyang/Desktop/legalwork'
const KEYWORDS = ['知识库', 'knowledge', '检索', '调研', '法律', '案', '合同', '文书', '案例', 'ima']

function threadTitle(tid) {
  try {
    const lines = readFileSync(join(THREADS_DIR, tid, 'metadata.jsonl'), 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      const e = JSON.parse(line)
      if (e.kind === 'thread_metadata' && e.thread?.title) return e.thread.title
    }
  } catch { /* ignore */ }
  return ''
}

function isKnowledgeThread(title) {
  const lower = title.toLowerCase()
  return KEYWORDS.some((k) => lower.includes(k))
}

function summarizeText(text, max = 600) {
  const s = String(text ?? '')
  return s.length > max ? s.slice(0, max) + `…[截断 ${s.length - max} 字符]` : s
}

function outputForItem(item) {
  const out = item.output
  if (typeof out === 'string') return out
  if (out && typeof out === 'object') {
    if (typeof out.contextText === 'string') return out.contextText
    if (typeof out.error === 'string') return `ERROR: ${out.error}`
    if (typeof out.summary === 'string') return out.summary
    return JSON.stringify(out)
  }
  return JSON.stringify(out ?? '')
}

function buildTrajForThread(tid) {
  const title = threadTitle(tid)
  const eventsPath = join(THREADS_DIR, tid, 'events.jsonl')
  let events
  try {
    events = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return null
  }
  // 找创建时间
  let createdAt = null
  for (const e of events) {
    if (e.kind === 'thread_created' && e.timestamp) { createdAt = e.timestamp; break }
  }

  const rows = []
  const itemsBySeq = new Map()
  for (const e of events) {
    if (e.kind !== 'item_created') continue
    const item = e.item || {}
    itemsBySeq.set(e.seq, { item, ts: e.timestamp })
  }

  // 按 seq 排序输出
  const sorted = [...itemsBySeq.entries()].sort((a, b) => a[0] - b[0])
  for (const [, { item, ts }] of sorted) {
    const kind = item.kind
    const prefix = `[${tid}]`
    if (kind === 'user_message') {
      rows.push({ type: 'user_message', threadId: tid, threadTitle: title, timestamp: ts, content: summarizeText(item.text) })
    } else if (kind === 'assistant_text') {
      rows.push({ type: 'assistant_message', threadId: tid, threadTitle: title, timestamp: ts, content: summarizeText(item.text) })
    } else if (kind === 'assistant_reasoning') {
      rows.push({ type: 'reasoning', threadId: tid, threadTitle: title, timestamp: ts, content: summarizeText(item.text, 300) })
    } else if (kind === 'tool_call') {
      rows.push({
        type: 'tool_call',
        threadId: tid,
        threadTitle: title,
        timestamp: ts,
        tool: item.toolName || 'unknown',
        params: summarizeText(JSON.stringify(item.arguments ?? {}), 400)
      })
    } else if (kind === 'tool_result') {
      rows.push({
        type: 'tool_result',
        threadId: tid,
        threadTitle: title,
        timestamp: ts,
        tool: item.toolName || 'unknown',
        isError: item.isError === true,
        output: summarizeText(outputForItem(item), 800)
      })
    }
  }
  return { tid, title, createdAt, rows }
}

const threadDirs = readdirSync(THREADS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
const knowledgeThreads = threadDirs
  .map((tid) => buildTrajForThread(tid))
  .filter((t) => t && isKnowledgeThread(t.title))
  .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))

const date = new Date().toISOString().slice(0, 10)
const outPath = join(OUTPUT_DIR, `traj_知识库全量_${date}.jsonl`)
mkdirSync(OUTPUT_DIR, { recursive: true })

const lines = []
lines.push(JSON.stringify({
  type: 'meta',
  session: 'legalwork 知识库相关对话全量导出',
  date,
  threadCount: knowledgeThreads.length,
  purpose: '供外部 AI 分析知识库功能的使用模式、问题与效率'
}))

let seq = 0
for (const t of knowledgeThreads) {
  for (const row of t.rows) {
    lines.push(JSON.stringify({ ...row, seq: ++seq }))
  }
}
writeFileSync(outPath, lines.join('\n') + '\n')

console.log(`知识库相关 thread: ${knowledgeThreads.length}`)
console.log(`输出: ${outPath}`)
console.log(`总事件: ${seq}`)
