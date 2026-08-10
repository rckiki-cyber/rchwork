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

  it('filters internal process files (events.jsonl, metadata.jsonl, exporter scripts, kg_page pngs, batch_cmds.json)', () => {
    const blocks: ChatBlock[] = [
      { kind: 'tool', id: 't1', summary: '生成报告', status: 'success', toolKind: 'file_change', filePath: '/case/报告.docx' },
      { kind: 'tool', id: 't2', summary: '写事件', status: 'success', toolKind: 'file_change', filePath: '/.legalwork/threads/thr_1/events.jsonl' },
      { kind: 'tool', id: 't3', summary: '写元数据', status: 'success', toolKind: 'file_change', filePath: '/.legalwork/threads/thr_1/metadata.jsonl' },
      { kind: 'tool', id: 't4', summary: '导出', status: 'success', toolKind: 'file_change', filePath: '/workspace/export_traj.py' },
      { kind: 'tool', id: 't5', summary: '截图', status: 'success', toolKind: 'file_change', filePath: '/workspace/kg_page-1.png' },
      { kind: 'tool', id: 't6', summary: '暂存命令', status: 'success', toolKind: 'file_change', filePath: '/tmp/batch_cmds.json' }
    ]

    const files = deriveConversationFiles(blocks)
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual(expect.objectContaining({ kind: 'workspace', name: '报告.docx' }))
  })

  it('shows only explicitly delivered outputs when a turn also creates process files', () => {
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'u1', text: '整理案例并生成表格和报告' },
      { kind: 'tool', id: 't1', summary: '写导出脚本', status: 'success', toolKind: 'file_change', filePath: '/case/export_food_cases.py' },
      { kind: 'tool', id: 't2', summary: '写论文草稿', status: 'success', toolKind: 'file_change', filePath: '/case/paper_draft.txt' },
      { kind: 'tool', id: 't3', summary: '写最终草稿', status: 'success', toolKind: 'file_change', filePath: '/case/_final_draft.txt' },
      { kind: 'tool', id: 't4', summary: '生成表格', status: 'success', toolKind: 'file_change', filePath: '/case/食品安全犯罪宽严相济典型案例.xlsx' },
      { kind: 'tool', id: 't5', summary: '生成报告', status: 'success', toolKind: 'file_change', filePath: '/case/刑事政策视野下食药犯罪两法衔接机制.pdf' },
      {
        kind: 'assistant',
        id: 'a1',
        text: '已完成：[案例表格](/case/食品安全犯罪宽严相济典型案例.xlsx)；[研究报告](/case/刑事政策视野下食药犯罪两法衔接机制.pdf)。'
      }
    ]

    expect(deriveConversationFiles(blocks).map((file) => file.name)).toEqual([
      '食品安全犯罪宽严相济典型案例.xlsx',
      '刑事政策视野下食药犯罪两法衔接机制.pdf'
    ])
  })

  it('filters helper scripts and drafts when tool events are the only output source', () => {
    const blocks: ChatBlock[] = [
      { kind: 'tool', id: 't1', summary: '写导出脚本', status: 'success', toolKind: 'file_change', filePath: '/case/export_food_cases.py' },
      { kind: 'tool', id: 't2', summary: '写论文草稿', status: 'success', toolKind: 'file_change', filePath: '/case/paper_draft.txt' },
      { kind: 'tool', id: 't3', summary: '写最终草稿', status: 'success', toolKind: 'file_change', filePath: '/case/_final_draft.txt' },
      { kind: 'tool', id: 't4', summary: '生成表格', status: 'success', toolKind: 'file_change', filePath: '/case/食品安全犯罪宽严相济典型案例.xlsx' }
    ]

    expect(deriveConversationFiles(blocks).map((file) => file.name)).toEqual([
      '食品安全犯罪宽严相济典型案例.xlsx'
    ])
  })

  it('does not treat reads, failed writes, or running writes as agent outputs', () => {
    const blocks: ChatBlock[] = [
      { kind: 'tool', id: 't1', summary: '读取来源', status: 'success', toolKind: 'tool_call', filePath: '/case/来源.pdf' },
      { kind: 'tool', id: 't2', summary: '读取文件', status: 'success', toolKind: 'file_change', filePath: '/case/材料.docx', meta: { toolName: 'read_file' } },
      { kind: 'tool', id: 't3', summary: '写入失败', status: 'error', toolKind: 'file_change', filePath: '/case/失败稿.docx' },
      { kind: 'tool', id: 't4', summary: '正在写入', status: 'running', toolKind: 'file_change', filePath: '/case/未完成稿.docx' }
    ]

    expect(deriveConversationFiles(blocks)).toEqual([])
  })

  it('keeps user-like traj and knowledge files that only share a prefix', () => {
    const blocks: ChatBlock[] = [
      { kind: 'tool', id: 't1', summary: '生成', status: 'success', toolKind: 'file_change', filePath: '/case/traj_数字行政法综述_20260801.jsonl' },
      { kind: 'tool', id: 't2', summary: '知识页', status: 'success', toolKind: 'file_change', filePath: '/case/kg_知识库页面_01.png' }
    ]

    const files = deriveConversationFiles(blocks)
    expect(files).toHaveLength(2)
  })

  it('dedups the same produced file referenced with different path spellings, keeping the latest', () => {
    const blocks: ChatBlock[] = [
      { kind: 'tool', id: 't1', summary: '生成', status: 'success', toolKind: 'file_change', filePath: '/workspace/行政法选题建议.docx' },
      { kind: 'assistant', id: 'a1', text: '已生成：`/Users/xiangyang/Desktop/行政法选题建议.docx`' }
    ]

    const files = deriveConversationFiles(blocks)
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual(expect.objectContaining({
      kind: 'workspace',
      name: '行政法选题建议.docx'
    }))
  })

  it('replaces an older named version with the latest version of the same deliverable', () => {
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'u1', text: '先生成初稿' },
      { kind: 'assistant', id: 'a1', text: '初稿：[研究报告](/case/算法行政研究报告_v1.docx)' },
      { kind: 'user', id: 'u2', text: '修正格式并给我新版' },
      { kind: 'assistant', id: 'a2', text: '新版：[研究报告](/case/算法行政研究报告_格式修正版.docx)' }
    ]

    const files = deriveConversationFiles(blocks)
    expect(files).toHaveLength(1)
    expect(files[0]).toEqual(expect.objectContaining({
      kind: 'workspace',
      name: '算法行政研究报告_格式修正版.docx',
      path: '/case/算法行政研究报告_格式修正版.docx'
    }))
  })

  it('keeps different final formats as separate deliverables', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'assistant',
        id: 'a1',
        text: '[Word](/case/算法行政研究报告_最终版.docx) [PDF](/case/算法行政研究报告_最终版.pdf)'
      }
    ]

    expect(deriveConversationFiles(blocks).map((file) => file.name)).toEqual([
      '算法行政研究报告_最终版.docx',
      '算法行政研究报告_最终版.pdf'
    ])
  })
})
