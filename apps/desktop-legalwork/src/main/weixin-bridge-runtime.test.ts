import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { weixinBridgeRuntimeInternals } from './weixin-bridge-runtime'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/legalwork-test-user-data',
    getVersion: () => '0.2.0-test'
  }
}))

const requireFromTest = createRequire(import.meta.url)

describe('weixin bridge runtime', () => {
  it('builds WeChat base_info from the bundled WeChat plugin package', () => {
    const pkg = requireFromTest('@tencent-weixin/openclaw-weixin/package.json') as {
      version: string
    }
    const baseInfo = weixinBridgeRuntimeInternals.buildBaseInfo()

    expect(baseInfo).toMatchObject({
      channel_version: pkg.version,
      bot_agent: 'DeepSeekGUI/0.2.0-test'
    })
  })

  it('keeps OpenClaw-compatible account id normalization for existing WeChat state files', () => {
    const { normalizeAccountId } = weixinBridgeRuntimeInternals

    expect(normalizeAccountId('b0f5860fdecb@im.bot')).toBe('b0f5860fdecb-im-bot')
    expect(normalizeAccountId('ABC@IM.WECHAT')).toBe('abc-im-wechat')
    expect(normalizeAccountId('')).toBe('default')
    expect(normalizeAccountId('__proto__')).toBe('default')
  })

  it('keeps supported WeChat Markdown while removing unsupported source markers', () => {
    const { formatWeixinMarkdown } = weixinBridgeRuntimeInternals

    expect(formatWeixinMarkdown([
      '### 文件概览',
      '',
      '> 引用内容',
      '',
      '| 名称 | 状态 |',
      '| --- | --- |',
      '| **合同** | 完成 |',
      '',
      '##### 补充说明',
      '~~已删除~~，*中文斜体*，*italic*',
      '![preview](https://example.com/image.png)'
    ].join('\n'))).toBe([
      '### 文件概览',
      '',
      '引用内容',
      '',
      '| 名称 | 状态 |',
      '| --- | --- |',
      '| **合同** | 完成 |',
      '',
      '补充说明',
      '已删除，中文斜体，*italic*'
    ].join('\n'))
  })

  it('does not expose the removed OpenClaw adapter builders', () => {
    expect(Object.keys(weixinBridgeRuntimeInternals)).not.toContain('buildGuiManagedOpenClawConfig')
    expect(Object.keys(weixinBridgeRuntimeInternals)).not.toContain('buildWeixinBridgeAdapterSource')
    expect(Object.keys(weixinBridgeRuntimeInternals)).not.toContain('parseNodeVersion')
  })
})
