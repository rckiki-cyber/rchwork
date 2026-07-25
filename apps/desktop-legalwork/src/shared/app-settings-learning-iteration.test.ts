import { describe, expect, it } from 'vitest'
import {
  defaultLearningIterationSettings,
  mergeLearningIterationSettings,
  normalizeLearningIterationSettings
} from './app-settings-learning-iteration'

describe('learning iteration settings', () => {
  it('defaults to daily background learning with tray residency', () => {
    expect(defaultLearningIterationSettings()).toEqual({
      enabled: true,
      cadence: 'daily',
      idleMinutes: 15,
      keepRunningInTray: true,
      initialBackfill: 'full',
      applyPolicy: 'auto-with-rollback'
    })
  })

  it('normalizes unsafe values and keeps fixed policy fields stable', () => {
    expect(normalizeLearningIterationSettings({
      enabled: false,
      idleMinutes: 999,
      keepRunningInTray: false
    })).toMatchObject({
      enabled: false,
      idleMinutes: 240,
      keepRunningInTray: false,
      cadence: 'daily',
      initialBackfill: 'full',
      applyPolicy: 'auto-with-rollback'
    })
  })

  it('merges a partial toggle without losing other defaults', () => {
    expect(mergeLearningIterationSettings(
      defaultLearningIterationSettings(),
      { enabled: false }
    )).toEqual({
      ...defaultLearningIterationSettings(),
      enabled: false
    })
  })
})
