import { describe, expect, it } from 'vitest'
import { KEYBOARD_SHORTCUT_COMMANDS } from '@shared/app-settings'
import enSettings from './en/settings.json'
import zhSettings from './zh/settings.json'

const shortcutInterfaceKeys = [
  'shortcutSearchPlaceholder',
  'shortcutCommandColumn',
  'shortcutBindingColumn',
  'shortcutCaptureHint',
  'shortcutRecording',
  'shortcutUnassigned',
  'shortcutReset',
  'shortcutConflict'
] as const

describe('keyboard shortcut translations', () => {
  it('provides Chinese names and descriptions for every shortcut command', () => {
    const translations = zhSettings as Record<string, string>

    for (const command of KEYBOARD_SHORTCUT_COMMANDS) {
      expect(translations[command.labelKey]).toMatch(/[\u3400-\u9fff]/)
      expect(translations[command.descriptionKey]).toMatch(/[\u3400-\u9fff]/)
    }
  })

  it('provides all shortcut interface text in both supported languages', () => {
    const dictionaries = [
      zhSettings as Record<string, string>,
      enSettings as Record<string, string>
    ]

    for (const translations of dictionaries) {
      for (const key of shortcutInterfaceKeys) {
        expect(translations[key]).toBeTruthy()
      }
      for (const command of KEYBOARD_SHORTCUT_COMMANDS) {
        expect(translations[command.labelKey]).toBeTruthy()
        expect(translations[command.descriptionKey]).toBeTruthy()
      }
    }
  })
})
