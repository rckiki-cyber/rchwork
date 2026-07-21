import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultLegalworkRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1
} from '@shared/app-settings'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { createAppActions } from './chat-store-app-actions'
import type { ChatState } from './chat-store-types'

function settings(): AppSettingsV1 {
  const provider = defaultModelProviderSettings()
  return {
    version: 1,
    locale: 'zh',
    theme: 'system',
    uiFontScale: 'small',
    provider: {
      ...provider,
      providers: provider.providers.map((profile) => profile.id === 'openai'
        ? { ...profile, apiKey: 'sk-openai' }
        : profile)
    },
    agents: {
      legalwork: {
        ...defaultLegalworkRuntimeSettings(),
        providerId: 'deepseek',
        model: 'deepseek-chat'
      }
    },
    workspaceRoot: '/tmp/legalwork',
    log: { enabled: false, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    guiUpdate: { channel: 'stable' }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('composer model provider switching', () => {
  it('switches runtime credentials before marking a cross-provider model ready', async () => {
    const currentSettings = settings()
    const switchedSettings = {
      ...currentSettings,
      agents: {
        legalwork: {
          ...currentSettings.agents.legalwork,
          providerId: 'openai',
          model: 'gpt-5.2'
        }
      }
    }
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue(currentSettings)
    const setSettings = vi.spyOn(rendererRuntimeClient, 'setSettings').mockResolvedValue(switchedSettings)
    const reconnectRuntime = vi.spyOn(rendererRuntimeClient, 'reconnectRuntime').mockResolvedValue(switchedSettings)

    let state = {
      composerModel: 'deepseek-chat',
      composerModelGroups: [
        { providerId: 'deepseek', label: 'DeepSeek', modelIds: ['deepseek-chat'] },
        { providerId: 'openai', label: 'GPT / OpenAI', modelIds: ['gpt-5.2'] }
      ],
      runtimeConnection: 'ready'
    } as ChatState
    const persistComposerModel = vi.fn()
    const actions = createAppActions({
      set: (partial) => {
        state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) }
      },
      get: () => state,
      i18n: { t: (_key: string, options?: { message?: string }) => options?.message ?? '' } as never,
      persistComposerModel,
      readStoredComposerModel: () => '',
      mergeComposerPickList: (_ok, ids) => ids,
      getComposerModelLoadPromise: () => null,
      setComposerModelLoadPromise: () => undefined,
      applyTheme: () => undefined,
      applyUiFontScale: () => undefined,
      applyDocumentLocale: () => undefined,
      workspaceLabelFromPath: (path) => path,
      normalizeWorkspaceRoot: (path) => path ?? ''
    })

    actions.setComposerModel('gpt-5.2', 'openai')

    expect(state.composerModel).toBe('gpt-5.2')
    expect(state.runtimeConnection).toBe('checking')
    expect(persistComposerModel).toHaveBeenCalledWith('gpt-5.2')
    await vi.waitFor(() => expect(reconnectRuntime).toHaveBeenCalledOnce())
    expect(setSettings).toHaveBeenCalledWith({
      agents: { legalwork: { providerId: 'openai', model: 'gpt-5.2' } }
    })
    expect(state.runtimeConnection).toBe('ready')
  })
})
