import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { describeRuntimeError, formatRuntimeError, getRuntimeErrorCode } from './format-runtime-error'

describe('format runtime error', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('uses code fields for localized summaries and settings actions', () => {
    const error = new Error(JSON.stringify({
      code: 'missing_api_key',
      message: 'api-key=sk-test is missing',
      details: { Authorization: 'Bearer runtime-token' }
    }))

    const view = describeRuntimeError(error)

    expect(view.summary).toBe(i18n.t('common:runtimeMissingApiKey'))
    expect(view.code).toBe('missing_api_key')
    expect(view.settingsAction).toBe('agents')
    expect(view.detail).toContain('<redacted>')
    expect(view.detail).not.toContain('sk-test')
    expect(view.detail).not.toContain('runtime-token')
  })

  it('supports legacy error envelopes and Electron IPC prefixes', () => {
    const error = new Error(
      `Error invoking remote method 'runtime:request': Error: ${JSON.stringify({
        error: 'fetch_failed',
        message: 'fetch failed'
      })}`
    )

    expect(getRuntimeErrorCode(error)).toBe('fetch_failed')
    expect(formatRuntimeError(error)).toBe(i18n.t('common:runtimeFetchFailed'))
  })

  it('detects insufficient balance from code field and shows localized summary', () => {
    const error = new Error(JSON.stringify({
      code: 'insufficient_balance',
      message: 'model API 余额不足或配额已耗尽 (HTTP 402): Insufficient Balance'
    }))

    expect(getRuntimeErrorCode(error)).toBe('insufficient_balance')
    expect(formatRuntimeError(error)).toBe(i18n.t('common:runtimeInsufficientBalance'))
  })

  it('detects insufficient balance from plain HTTP 402 message without code', () => {
    const error = new Error('model request failed with status 402: Insufficient Balance')

    expect(getRuntimeErrorCode(error)).toBe('insufficient_balance')
    expect(formatRuntimeError(error)).toBe(i18n.t('common:runtimeInsufficientBalance'))
  })
})
