import { describe, expect, it } from 'vitest'
import type { ChatBlock } from '../agent/types'
import { deriveConversationFiles } from './conversation-files'

describe('deriveConversationFiles', () => {
  it('collects uploaded attachments and agent-produced files without duplicates', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'u1',
        text: '请审查',
        meta: {
          attachmentIds: ['att-1'],
          attachments: [{ id: 'att-1', name: '合同.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }]
        }
      },
      { kind: 'tool', id: 't1', summary: '生成文件', status: 'success', toolKind: 'file_change', filePath: '/case/审查报告.docx' },
      { kind: 'assistant', id: 'a1', text: '已完成：[审查报告](/case/审查报告.docx)' }
    ]

    expect(deriveConversationFiles(blocks)).toEqual([
      expect.objectContaining({ kind: 'attachment', name: '合同.docx', attachmentId: 'att-1' }),
      expect.objectContaining({ kind: 'workspace', name: '审查报告.docx', path: '/case/审查报告.docx' })
    ])
  })

  it('ignores web links and paths without a file extension', () => {
    const blocks: ChatBlock[] = [
      { kind: 'assistant', id: 'a1', text: '[法规](https://example.com/rules) 和 `/case/folder`' }
    ]
    expect(deriveConversationFiles(blocks)).toEqual([])
  })

  it('filters date-like and bare-host tokens that are not real files', () => {
    const blocks: ChatBlock[] = [
      { kind: 'assistant', id: 'a1', text: '2025.03.07 和 2026.03.20 都发布在 beian.cac.gov.cn,详见 v2.0.1' }
    ]
    expect(deriveConversationFiles(blocks)).toEqual([])
  })

  it('does not duplicate a user-uploaded file when the agent only references it', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'u1',
        text: '帮我读一下',
        meta: {
          attachmentIds: ['att-1'],
          attachments: [{ id: 'att-1', name: 'traj_数字行政法综述_20260801.jsonl', mimeType: 'application/json' }]
        }
      },
      { kind: 'tool', id: 't1', summary: '读取文件', status: 'success', toolKind: 'tool_call', filePath: '/workspace/traj_数字行政法综述_20260801.jsonl' },
      { kind: 'assistant', id: 'a1', text: '我读了 `traj_数字行政法综述_20260801.jsonl`,其中提到……' }
    ]

    const files = deriveConversationFiles(blocks)
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual(expect.objectContaining({ kind: 'attachment', name: 'traj_数字行政法综述_20260801.jsonl', attachmentId: 'att-1' }))
  })

  it('filters internal process files (events.jsonl, metadata.jsonl, exporter scripts, kg_page pngs)', () => {
    const blocks: ChatBlock[] = [
      { kind: 'tool', id: 't1', summary: '生成报告', status: 'success', toolKind: 'file_change', filePath: '/case/报告.docx' },
      { kind: 'tool', id: 't2', summary: '写事件', status: 'success', toolKind: 'file_change', filePath: '/.legalwork/threads/thr_1/events.jsonl' },
      { kind: 'tool', id: 't3', summary: '写元数据', status: 'success', toolKind: 'file_change', filePath: '/.legalwork/threads/thr_1/metadata.jsonl' },
      { kind: 'tool', id: 't4', summary: '导出', status: 'success', toolKind: 'file_change', filePath: '/workspace/export_traj.py' },
      { kind: 'tool', id: 't5', summary: '截图', status: 'success', toolKind: 'file_change', filePath: '/workspace/kg_page-1.png' }
    ]

    const files = deriveConversationFiles(blocks)
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual(expect.objectContaining({ kind: 'workspace', name: '报告.docx' }))
  })

  it('keeps user-like traj and knowledge files that only share a prefix', () => {
    const blocks: ChatBlock[] = [
      { kind: 'tool', id: 't1', summary: '生成', status: 'success', toolKind: 'file_change', filePath: '/case/traj_数字行政法综述_20260801.jsonl' },
      { kind: 'tool', id: 't2', summary: '知识页', status: 'success', toolKind: 'file_change', filePath: '/case/kg_知识库页面_01.png' }
    ]

    const files = deriveConversationFiles(blocks)
    expect(files).toHaveLength(2)
  })
})
