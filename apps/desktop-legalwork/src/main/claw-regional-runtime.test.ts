import { describe, expect, it } from 'vitest'
import type { ClawImChannelV1, ClawImPlatformCredentialV1 } from '../shared/app-settings'
import {
  createQqMarkdownReplyPayload,
  createQqPlainTextReplyPayload,
  formatQqPlainTextFallback,
  isRegionalChannel,
  REGIONAL_CHANNEL_MARKDOWN_DEFAULTS,
  regionalChannelKey,
  replyQqMarkdownWithFallback
} from './claw-regional-runtime'

function channel(
  provider: ClawImChannelV1['provider'],
  platformCredential?: ClawImPlatformCredentialV1
): ClawImChannelV1 {
  return {
    id: `${provider}-channel`,
    provider,
    label: provider,
    enabled: true,
    model: 'auto',
    threadId: '',
    workspaceRoot: '',
    agentProfile: {
      name: 'legalwork',
      description: '',
      identity: '',
      personality: '',
      userContext: '',
      replyRules: ''
    },
    ...(platformCredential ? { platformCredential } : {}),
    conversations: [],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z'
  }
}

describe('claw regional channel runtime', () => {
  it('enables Markdown by default for every supported regional channel', () => {
    expect(REGIONAL_CHANNEL_MARKDOWN_DEFAULTS).toEqual({
      qq: true,
      dingtalk: true,
      wecom: true
    })
  })

  it('sends QQ Markdown by default', async () => {
    const replies: string[] = []

    await replyQqMarkdownWithFallback(
      async () => {
        replies.push('markdown')
      },
      async () => {
        replies.push('plain')
      },
      () => {
        throw new Error('fallback should not run')
      }
    )

    expect(replies).toEqual(['markdown'])
  })

  it('falls back to QQ plain text when Markdown is rejected', async () => {
    const replies: string[] = []
    const fallbackErrors: unknown[] = []

    await replyQqMarkdownWithFallback(
      async () => {
        replies.push('markdown')
        throw new Error('markdown permission missing')
      },
      async () => {
        replies.push('plain')
      },
      (error) => {
        fallbackErrors.push(error)
      }
    )

    expect(replies).toEqual(['markdown', 'plain'])
    expect(fallbackErrors).toHaveLength(1)
  })

  it('builds QQ native Markdown without the SDK null template fields', () => {
    expect(createQqMarkdownReplyPayload('**已完成**', 'msg-1', {}, 7)).toEqual({
      markdown: { content: '**已完成**' },
      msg_type: 2,
      msg_id: 'msg-1',
      msg_seq: 7
    })
  })

  it('builds QQ template Markdown when the bot requires an approved template', () => {
    expect(createQqMarkdownReplyPayload('**已完成**', 'msg-1', {
      markdownTemplateId: 'template-1',
      markdownTemplateKey: 'content'
    }, 8)).toEqual({
      markdown: {
        custom_template_id: 'template-1',
        params: [{ key: 'content', values: ['**已完成**'] }]
      },
      msg_type: 2,
      msg_id: 'msg-1',
      msg_seq: 8
    })
  })

  it('removes Markdown source markers from the QQ text fallback', () => {
    expect(formatQqPlainTextFallback([
      '### 标题',
      '---',
      '**加粗**',
      '[链接](https://example.com)'
    ].join('\n'))).toBe('标题\n\n加粗\n链接：https://example.com')
    expect(createQqPlainTextReplyPayload('**已完成**', 'msg-2', 9)).toEqual({
      content: '已完成',
      msg_type: 0,
      msg_id: 'msg-2',
      msg_seq: 9
    })
  })

  it('accepts only providers with matching complete credential kinds', () => {
    expect(isRegionalChannel(channel('qq', {
      kind: 'qq',
      appId: 'qq-app',
      appSecret: 'qq-secret',
      createdAt: '2026-07-29T00:00:00.000Z'
    }))).toBe(true)
    expect(isRegionalChannel(channel('dingtalk', {
      kind: 'dingtalk',
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
      createdAt: '2026-07-29T00:00:00.000Z'
    }))).toBe(true)
    expect(isRegionalChannel(channel('wecom', {
      kind: 'wecom',
      botId: 'wecom-bot',
      secret: 'wecom-secret',
      createdAt: '2026-07-29T00:00:00.000Z'
    }))).toBe(true)
    expect(isRegionalChannel(channel('qq'))).toBe(false)
    expect(isRegionalChannel(channel('qq', {
      kind: 'dingtalk',
      clientId: 'wrong',
      clientSecret: 'wrong',
      createdAt: '2026-07-29T00:00:00.000Z'
    }))).toBe(false)
  })

  it('changes the bridge identity when credentials change', () => {
    const first = channel('qq', {
      kind: 'qq',
      appId: 'qq-app',
      appSecret: 'secret-a',
      createdAt: '2026-07-29T00:00:00.000Z'
    })
    const second = channel('qq', {
      kind: 'qq',
      appId: 'qq-app',
      appSecret: 'secret-b',
      createdAt: '2026-07-29T00:00:00.000Z'
    })
    expect(isRegionalChannel(first)).toBe(true)
    expect(isRegionalChannel(second)).toBe(true)
    if (!isRegionalChannel(first) || !isRegionalChannel(second)) return
    expect(regionalChannelKey(first)).not.toBe(regionalChannelKey(second))
  })
})
