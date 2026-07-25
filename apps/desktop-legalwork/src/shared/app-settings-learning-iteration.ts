import type {
  LearningIterationSettingsPatchV1,
  LearningIterationSettingsV1
} from './app-settings-types'

export function defaultLearningIterationSettings(): LearningIterationSettingsV1 {
  return {
    enabled: true,
    cadence: 'daily',
    idleMinutes: 15,
    keepRunningInTray: true,
    initialBackfill: 'full',
    applyPolicy: 'auto-with-rollback'
  }
}

export function normalizeLearningIterationSettings(
  input: LearningIterationSettingsPatchV1 | undefined
): LearningIterationSettingsV1 {
  const defaults = defaultLearningIterationSettings()
  return {
    enabled: input?.enabled !== false,
    cadence: 'daily',
    idleMinutes: clampInteger(input?.idleMinutes, defaults.idleMinutes, 5, 240),
    keepRunningInTray: input?.keepRunningInTray !== false,
    initialBackfill: 'full',
    applyPolicy: 'auto-with-rollback'
  }
}

export function mergeLearningIterationSettings(
  current: LearningIterationSettingsV1,
  patch: LearningIterationSettingsPatchV1 | undefined
): LearningIterationSettingsV1 {
  return normalizeLearningIterationSettings({
    ...current,
    ...(patch ?? {})
  })
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)))
}
