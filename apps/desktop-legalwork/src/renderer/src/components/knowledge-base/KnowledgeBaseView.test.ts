import { describe, expect, it } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import {
  findKnowledgeFileForChatContext,
  knowledgeChatHistoryFromBlocks,
  stripRepeatedKnowledgeQuestionLead
} from './knowledge-chat-history'

describe('knowledgeChatHistoryFromBlocks', () => {
  it('restores the visible user question from a stored global RAG prompt', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user-1',
        text: `你是一个专业的法律知识助手。请基于以下从知识库中检索到的相关内容回答用户的问题。

## RAG 检索上下文
内部检索内容

## 可引用来源
[来源 1] 文档

## 用户问题
这份材料的核心结论是什么？

请基于检索到的内容给出准确、专业的回答。`
      },
      {
        kind: 'assistant',
        id: 'assistant-1',
        text: '## 结论\n\n核心结论如下。'
      }
    ]

    const history = knowledgeChatHistoryFromBlocks(blocks)

    expect(history.context).toEqual({ kind: 'global' })
    expect(history.messages[0]).toMatchObject({
      role: 'user',
      content: '这份材料的核心结论是什么？'
    })
    expect(history.messages[1]).toMatchObject({
      role: 'assistant',
      content: '## 结论\n\n核心结论如下。'
    })
  })

  it('extracts the file context from a stored file chat prompt', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user-1',
        text: `你是一个专业的法律知识助手。请基于当前打开文件的内容回答用户的问题。

## 当前文件
党员、党权与党争（社科文献学术文库·文史哲研究系列）.md（MD）

## 当前打开文件的正文（优先依据）
# 《党员、党权与党争》

## 用户问题
总结一下划线内容。

请基于当前文件给出回答。`
      }
    ]

    const history = knowledgeChatHistoryFromBlocks(blocks)

    expect(history.context).toEqual({
      kind: 'file',
      fileName: '党员、党权与党争（社科文献学术文库·文史哲研究系列）.md'
    })
    expect(history.messages[0]).toMatchObject({
      role: 'user',
      content: '总结一下划线内容。'
    })
  })

  it('extracts a durable file path from newer file chat prompts', () => {
    const blocks: ChatBlock[] = [{
      kind: 'user',
      id: 'user-1',
      text: `## 当前文件
合同审查.md（MD）

## 当前文件路径
案件/甲公司/合同审查.md

## 用户问题
有哪些主要风险？`
    }]

    expect(knowledgeChatHistoryFromBlocks(blocks).context).toEqual({
      kind: 'file',
      fileName: '合同审查.md',
      filePath: '案件/甲公司/合同审查.md'
    })
  })

  it('does not expose legacy file-chat instructions in the restored user message', () => {
    const blocks: ChatBlock[] = [{
      kind: 'user',
      id: 'user-1',
      text: `你是一个专业的法律知识助手。

## 当前文件
第一次跟委托人见面要不要主动递名片或加微信.md（MD）

## 用户问题
?

请优先依据“当前打开文件的正文”回答；知识库补充检索结果只能用于交叉参考或补充背景，不能把其他文件内容误认为当前文件内容。如果当前文件正文不足以回答问题，请明确说明缺口。`
    }]

    expect(knowledgeChatHistoryFromBlocks(blocks).messages[0]).toMatchObject({
      role: 'user',
      content: '?'
    })
  })

  it('restores only the user question from prompts with a separate answer-requirements section', () => {
    const blocks: ChatBlock[] = [{
      kind: 'user',
      id: 'user-1',
      text: `你是一个专业的法律知识助手。

## 用户问题
请比较这两份材料。

需要分别说明共同点和差异。

## 回答要求
请基于检索到的内容给出准确、专业的回答。`
    }]

    expect(knowledgeChatHistoryFromBlocks(blocks).messages[0]).toMatchObject({
      role: 'user',
      content: '请比较这两份材料。\n\n需要分别说明共同点和差异。'
    })
  })

  it('attaches a stored reasoning block to its assistant answer', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'reasoning',
        id: 'reasoning-1',
        text: '先读取当前文件，再提取关键信息。'
      },
      {
        kind: 'assistant',
        id: 'assistant-1',
        text: '## 结论\n\n这是最终回答。'
      }
    ]

    expect(knowledgeChatHistoryFromBlocks(blocks).messages[0]).toMatchObject({
      role: 'assistant',
      reasoning: '先读取当前文件，再提取关键信息。',
      content: '## 结论\n\n这是最终回答。'
    })
  })

  it('removes a repeated user question used as the answer heading', () => {
    expect(stripRepeatedKnowledgeQuestionLead(
      '# 这是什么\n\n这是一个实务经验分享文档。',
      '这是什么'
    )).toBe('这是一个实务经验分享文档。')
  })

  it('removes a repeated user question used as bold lead text', () => {
    expect(stripRepeatedKnowledgeQuestionLead(
      '**问题：这是什么？**\n\n这是一个实务经验分享文档。',
      '这是什么'
    )).toBe('这是一个实务经验分享文档。')
  })

  it('preserves a useful answer heading that is not the user question', () => {
    const answer = '## 核心内容\n\n这是一份实务经验分享文档。'
    expect(stripRepeatedKnowledgeQuestionLead(answer, '这是什么')).toBe(answer)
  })

  it('cleans repeated question headings when restoring stored answers', () => {
    const blocks: ChatBlock[] = [
      {
        kind: 'user',
        id: 'user-1',
        text: '这是什么'
      },
      {
        kind: 'assistant',
        id: 'assistant-1',
        text: '# 这是什么\n\n这是一个实务经验分享文档。'
      }
    ]

    expect(knowledgeChatHistoryFromBlocks(blocks).messages[1]).toMatchObject({
      role: 'assistant',
      content: '这是一个实务经验分享文档。'
    })
  })

  it('finds the linked file by path and falls back to a unique file name for old chats', () => {
    const nodes = [{
      name: '案件',
      path: '案件',
      kind: 'folder' as const,
      children: [
        { name: '合同审查.md', path: '案件/甲公司/合同审查.md', kind: 'file' as const },
        { name: '合同审查.md', path: '案件/乙公司/合同审查.md', kind: 'file' as const },
        { name: '庭审笔记.md', path: '案件/庭审笔记.md', kind: 'file' as const }
      ]
    }]

    expect(findKnowledgeFileForChatContext(nodes, {
      kind: 'file',
      fileName: '合同审查.md',
      filePath: '案件/乙公司/合同审查.md'
    })?.path).toBe('案件/乙公司/合同审查.md')
    expect(findKnowledgeFileForChatContext(nodes, {
      kind: 'file',
      fileName: '庭审笔记.md'
    })?.path).toBe('案件/庭审笔记.md')
    expect(findKnowledgeFileForChatContext(nodes, {
      kind: 'file',
      fileName: '合同审查.md'
    })).toBeNull()
  })
})
