import { describe, expect, it } from 'vitest'
import { normalizeClawSettings, type ClawSettingsPatchV1 } from './app-settings'

describe('regional Claw channel settings', () => {
  it('normalizes QQ, DingTalk, and WeCom channels without dropping credentials', () => {
    const claw = normalizeClawSettings({
      enabled: true,
      im: { enabled: true, provider: 'qq' },
      channels: [
        {
          id: 'qq-1',
          provider: 'qq',
          platformCredential: {
            kind: 'qq',
            appId: '  qq-app  ',
            appSecret: '  qq-secret  ',
            markdownTemplateId: '  md-template  ',
            markdownTemplateKey: '  content  '
          }
        },
        {
          id: 'ding-1',
          provider: 'dingtalk',
          platformCredential: {
            kind: 'dingtalk',
            clientId: '  ding-client  ',
            clientSecret: '  ding-secret  '
          }
        },
        {
          id: 'wecom-1',
          provider: 'wecom',
          platformCredential: {
            kind: 'wecom',
            botId: '  wecom-bot  ',
            secret: '  wecom-secret  '
          }
        }
      ]
    } as unknown as ClawSettingsPatchV1)

    expect(claw.channels.map((channel) => channel.provider)).toEqual([
      'qq',
      'dingtalk',
      'wecom'
    ])
    expect(claw.channels[0].platformCredential).toMatchObject({
      kind: 'qq',
      appId: 'qq-app',
      appSecret: 'qq-secret',
      markdownTemplateId: 'md-template',
      markdownTemplateKey: 'content'
    })
    expect(claw.channels[1].platformCredential).toMatchObject({
      kind: 'dingtalk',
      clientId: 'ding-client',
      clientSecret: 'ding-secret'
    })
    expect(claw.channels[2].platformCredential).toMatchObject({
      kind: 'wecom',
      botId: 'wecom-bot',
      secret: 'wecom-secret'
    })
  })
})
