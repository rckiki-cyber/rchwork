import { describe, expect, it } from 'vitest'
import {
  normalizeRateLimitedToolOutput,
  parseRateLimitedToolResult
} from '../src/adapters/tool/tool-rate-limit.js'

describe('tool rate limit detection', () => {
  it('flags a short structured error message', () => {
    const normalized = normalizeRateLimitedToolOutput({
      error: { code: 'fetch_failed', message: 'HTTP 429' }
    })

    expect(normalized.rateLimited).toBe(true)
    expect(normalized.isError).toBe(true)
    expect(normalized.output).toMatchObject({ code: 'rate_limited' })
  })

  it('flags a top-level short error string', () => {
    const parsed = parseRateLimitedToolResult('429 Too Many Requests')

    expect(parsed?.rateLimited).toBe(true)
  })

  it('flags a numeric http status', () => {
    const normalized = normalizeRateLimitedToolOutput({ status: 429 })

    expect(normalized.rateLimited).toBe(true)
  })

  it('does not flag a successful bash result whose stdout mentions 429', () => {
    // 回归：导出轮 analyze_errors.py 成功执行（exit_code 0），但 stdout 里打印了
    // 其他请求的 "HTTP 429" 错误文本，曾被整体误标为 rate_limited。
    const normalized = normalizeRateLimitedToolOutput({
      command: 'cd /Users/xiangyang/Desktop/政治理论 && python3 analyze_errors.py',
      cwd: '/Users/xiangyang/Desktop/政治理论',
      shell: 'bash',
      exit_code: 0,
      output: 'code: fetch_failed message: HTTP 429 provider: fetch url: https://zh.wikipedia.org/...',
      status: 'completed'
    })

    expect(normalized.rateLimited).toBe(false)
    expect(normalized.isError).toBe(false)
  })

  it('does not flag data payloads that merely mention rate-limit words', () => {
    // 回归：thread_read 返回的对话记录里嵌有历史 "HTTP 429" 报错，属于数据正文，
    // 不是本次调用被限流。
    const normalized = normalizeRateLimitedToolOutput({
      id: 'thr_xxx',
      title: 'demo',
      conversation: '--- 轮次 ---\n[工具结果] code: fetch_failed message: HTTP 429 ...'
    })

    expect(normalized.rateLimited).toBe(false)
    expect(normalized.isError).toBe(false)
  })

  it('does not flag long free-text outputs that mention quota wording', () => {
    const longOutput = 'line\n'.repeat(50) + 'quota exceeded appears only as data here\n'

    const normalized = normalizeRateLimitedToolOutput({ output: longOutput, status: 'completed' })

    expect(normalized.rateLimited).toBe(false)
  })
})
