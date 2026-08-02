import { useEffect, useState, type ReactElement } from 'react'
import {
  BUILTIN_MODEL_PROVIDER_PRESETS,
  DEFAULT_MODEL_PROVIDER_ID,
  getBuiltinModelProviderPreset,
  getModelProviderProfile,
  inferEndpointFormatFromBaseUrl,
  legalworkSettingsPatch
} from '@shared/app-settings'
import type { CodexAuthStatus } from '@shared/ds-gui-api'
import { CheckCircle2, Loader2, LogIn, LogOut, RefreshCw } from 'lucide-react'
import {
  SettingsCard,
  SettingRow,
  SecretInput
} from './settings-controls'
import { ModelListPicker } from './settings-model-list-picker'

/**
 * Model configuration: authentication mode (API key vs ChatGPT account),
 * the active provider, its credentials/endpoint/protocol/model list, and the
 * model used by the composer. Centralizes everything model-related that used
 * to live split across "通用" and "AI 助手".
 */
export function ModelSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const {
    t,
    form,
    provider,
    legalwork,
    update,
    updateLegalwork,
    updateSharedCredential,
    sharedApiKey,
    sharedBaseUrl,
    showApiKey,
    setShowApiKey,
    selectControlClass
  } = ctx

  const activeProviderId = legalwork.providerId || DEFAULT_MODEL_PROVIDER_ID
  const activeProvider = getModelProviderProfile(form, activeProviderId)
  const activeProviderPreset = getBuiltinModelProviderPreset(activeProvider.id)

  // ── Provider profile helpers (mirrors settings-section-general) ──
  const buildProviderProfiles = (nextProvider: typeof activeProvider): typeof provider.providers => (
    provider.providers.some((item: typeof activeProvider) => item.id === nextProvider.id)
      ? provider.providers.map((item: typeof activeProvider) => item.id === nextProvider.id ? nextProvider : item)
      : [...provider.providers, nextProvider]
  )
  const updateProviderProfiles = (nextProvider: typeof activeProvider): void => {
    const nextProfiles = buildProviderProfiles(nextProvider)
    update({
      provider: nextProvider.id === DEFAULT_MODEL_PROVIDER_ID
        ? {
            apiKey: nextProvider.apiKey,
            baseUrl: nextProvider.baseUrl,
            providers: nextProfiles
          }
        : { providers: nextProfiles }
    })
  }
  const updateActiveProviderProfile = (patch: Partial<typeof activeProvider>): void => {
    updateProviderProfiles({ ...activeProvider, ...patch })
  }
  const selectModelProvider = (providerId: string): void => {
    const preset = getBuiltinModelProviderPreset(providerId)
    const current = getModelProviderProfile(form, providerId)
    const nextProvider = {
      ...current,
      id: preset?.id ?? current.id,
      name: preset?.name ?? current.name,
      baseUrl: current.baseUrl || preset?.baseUrl || '',
      endpointFormat: current.endpointFormat || preset?.endpointFormat || 'chat_completions',
      models: current.models.length > 0 ? current.models : preset?.models ?? []
    }
    update({
      provider: nextProvider.id === DEFAULT_MODEL_PROVIDER_ID
        ? {
            apiKey: nextProvider.apiKey,
            baseUrl: nextProvider.baseUrl,
            providers: buildProviderProfiles(nextProvider)
          }
        : { providers: buildProviderProfiles(nextProvider) },
      agents: legalworkSettingsPatch({
        providerId: nextProvider.id,
        model: nextProvider.models[0] || legalwork.model,
        endpointFormat: nextProvider.endpointFormat
      })
    })
  }

  // ── ChatGPT-account auth status (mirrors settings-section-agents) ──
  const [codexAuthStatus, setCodexAuthStatus] = useState<CodexAuthStatus | null>(null)
  const [codexAuthBusy, setCodexAuthBusy] = useState(false)
  const [codexAuthError, setCodexAuthError] = useState('')
  const refreshCodexAuth = async (refreshToken = false): Promise<CodexAuthStatus | null> => {
    if (typeof window.dsGui?.getCodexAuthStatus !== 'function') {
      setCodexAuthError(t('codexAuthUnavailable'))
      return null
    }
    setCodexAuthBusy(true)
    setCodexAuthError('')
    try {
      const status = await window.dsGui.getCodexAuthStatus(refreshToken)
      setCodexAuthStatus(status)
      if (status.message) setCodexAuthError(status.message)
      return status
    } catch (error) {
      setCodexAuthError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setCodexAuthBusy(false)
    }
  }
  useEffect(() => {
    if (legalwork.authMode !== 'chatgpt') return
    void refreshCodexAuth(false)
  }, [legalwork.authMode, legalwork.codexBinaryPath])
  const loginCodex = async (): Promise<void> => {
    setCodexAuthBusy(true)
    setCodexAuthError('')
    try {
      const result = await window.dsGui.loginCodexWithChatGpt()
      if (!result.ok) {
        setCodexAuthError(result.message)
        return
      }
      setCodexAuthStatus(result.status)
      const defaultModel = result.status.models.find((model) => model.isDefault)?.id ?? result.status.models[0]?.id
      if (defaultModel && !result.status.models.some((model) => model.id === legalwork.model)) {
        updateLegalwork({ model: defaultModel })
      }
    } catch (error) {
      setCodexAuthError(error instanceof Error ? error.message : String(error))
    } finally {
      setCodexAuthBusy(false)
    }
  }
  const logoutCodex = async (): Promise<void> => {
    setCodexAuthBusy(true)
    setCodexAuthError('')
    try {
      const result = await window.dsGui.logoutCodex()
      if (result.ok) setCodexAuthStatus(result.status)
      else setCodexAuthError(result.message)
    } catch (error) {
      setCodexAuthError(error instanceof Error ? error.message : String(error))
    } finally {
      setCodexAuthBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <SettingsCard title={t('sectionModelConfig')}>
        {/* Authentication mode */}
        <SettingRow
          title={t('legalworkAuthMode')}
          description={t('legalworkAuthModeDesc')}
          wideControl
          control={
            <div className="grid w-full gap-3">
              <div className="inline-flex w-fit rounded-2xl border border-ds-border bg-ds-main/60 p-1">
                <button
                  type="button"
                  onClick={() => updateLegalwork({ authMode: 'api_key' })}
                  className={`rounded-xl px-3 py-2 text-[12.5px] font-semibold transition ${
                    legalwork.authMode !== 'chatgpt'
                      ? 'bg-ds-card text-ds-ink shadow-sm ring-1 ring-ds-border-muted'
                      : 'text-ds-muted hover:text-ds-ink'
                  }`}
                >
                  {t('legalworkAuthApiKey')}
                </button>
                <button
                  type="button"
                  onClick={() => updateLegalwork({ authMode: 'chatgpt' })}
                  className={`rounded-xl px-3 py-2 text-[12.5px] font-semibold transition ${
                    legalwork.authMode === 'chatgpt'
                      ? 'bg-ds-card text-ds-ink shadow-sm ring-1 ring-ds-border-muted'
                      : 'text-ds-muted hover:text-ds-ink'
                  }`}
                >
                  {t('legalworkAuthChatGpt')}
                </button>
              </div>
              {legalwork.authMode === 'chatgpt' ? (
                <div className="rounded-xl border border-ds-border-muted bg-ds-main/35 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-[13px] font-semibold text-ds-ink">
                        {codexAuthStatus?.loggedIn ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                        ) : null}
                        {codexAuthStatus?.loggedIn
                          ? t('codexAuthConnected')
                          : t('codexAuthNotConnected')}
                      </div>
                      {codexAuthStatus?.loggedIn ? (
                        <p className="mt-1 text-[12px] text-ds-muted">
                          {[
                            codexAuthStatus.email,
                            codexAuthStatus.planType,
                            t(codexAuthStatus.credentialSource === 'local'
                              ? 'codexAuthSourceLocal'
                              : 'codexAuthSourceLegalwork')
                          ].filter(Boolean).join(' · ')}
                        </p>
                      ) : (
                        <p className="mt-1 text-[12px] leading-5 text-ds-muted">{t('codexAuthHint')}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={codexAuthBusy}
                        onClick={() => void refreshCodexAuth(true)}
                        className="inline-flex h-9 items-center gap-2 rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${codexAuthBusy ? 'animate-spin' : ''}`} />
                        {t('codexAuthRefresh')}
                      </button>
                      {codexAuthStatus?.loggedIn ? (
                        <button
                          type="button"
                          disabled={codexAuthBusy}
                          onClick={() => void logoutCodex()}
                          className="inline-flex h-9 items-center gap-2 rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50"
                        >
                          <LogOut className="h-3.5 w-3.5" />
                          {t('codexAuthLogout')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={codexAuthBusy || codexAuthStatus?.available === false}
                          onClick={() => void loginCodex()}
                          className="inline-flex h-9 items-center gap-2 rounded-full border border-accent/20 bg-accent-soft px-4 text-[12.5px] font-semibold text-accent shadow-sm transition hover:bg-accent/20 disabled:opacity-50"
                        >
                          {codexAuthBusy
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : <LogIn className="h-3.5 w-3.5" />}
                          {t('codexAuthLogin')}
                        </button>
                      )}
                    </div>
                  </div>
                  {codexAuthError ? (
                    <p className="mt-3 text-[12px] leading-5 text-red-700 dark:text-red-300">{codexAuthError}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          }
        />

        {/* Provider */}
        <SettingRow
          title={t('modelProvider')}
          description={t('modelProviderDesc')}
          control={
            <div className="w-full min-w-0 md:max-w-md">
              <select
                className={selectControlClass}
                value={activeProvider.id}
                onChange={(e) => selectModelProvider(e.target.value)}
              >
                {BUILTIN_MODEL_PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name}
                  </option>
                ))}
              </select>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {BUILTIN_MODEL_PROVIDER_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => selectModelProvider(preset.id)}
                    className={`rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition ${
                      activeProvider.id === preset.id
                        ? 'border-accent/35 bg-accent/10 text-accent'
                        : 'border-ds-border bg-ds-card text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                    }`}
                  >
                    {preset.name}
                  </button>
                ))}
              </div>
            </div>
          }
        />

        {/* API key + base URL + protocol (only relevant in API-key mode) */}
        {legalwork.authMode !== 'chatgpt' ? (
          <>
            <SettingRow
              title={t('apiKey')}
              description={t('apiKeySharedDesc')}
              control={
                <SecretInput
                  value={activeProvider.apiKey}
                  onChange={(value) => updateActiveProviderProfile({ apiKey: value })}
                  visible={showApiKey}
                  onToggleVisibility={() => setShowApiKey((value: boolean) => !value)}
                  placeholder={activeProviderPreset?.apiKeyPlaceholder ?? 'sk-...'}
                  autoComplete="off"
                  showLabel={t('showSecret')}
                  hideLabel={t('hideSecret')}
                  className="md:max-w-md"
                />
              }
            />
            <SettingRow
              title={t('baseUrl')}
              description={t('baseUrlSharedDesc')}
              control={
                <input
                  className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30 md:max-w-md"
                  placeholder={t('baseUrlPlaceholder')}
                  value={activeProvider.baseUrl}
                  onChange={(e) => {
                    const nextBaseUrl = e.target.value
                    // Auto-infer the protocol from the endpoint unless the user
                    // has manually chosen a protocol that differs from what the
                    // previous base URL implied.
                    const inferredFromPrevious = inferEndpointFormatFromBaseUrl(
                      activeProvider.baseUrl,
                      activeProvider.id
                    )
                    const userPickedManually =
                      activeProvider.endpointFormat &&
                      activeProvider.endpointFormat !== inferredFromPrevious
                    updateActiveProviderProfile({
                      baseUrl: nextBaseUrl,
                      ...(userPickedManually ? {} : {
                        endpointFormat: inferEndpointFormatFromBaseUrl(nextBaseUrl, activeProvider.id)
                      })
                    })
                  }}
                />
              }
            />
            <SettingRow
              title={t('endpointFormat')}
              description={t('endpointFormatDesc')}
              control={
                <select
                  className={selectControlClass}
                  value={activeProvider.endpointFormat || 'chat_completions'}
                  onChange={(e) => updateActiveProviderProfile({ endpointFormat: e.target.value })}
                >
                  <option value="chat_completions">{t('endpointFormatChat')}</option>
                  <option value="responses">{t('endpointFormatResponses')}</option>
                  <option value="messages">{t('endpointFormatMessages')}</option>
                </select>
              }
            />
          </>
        ) : null}

        {/* Model list */}
        <SettingRow
          title={t('modelProviderModels')}
          description={t('modelProviderModelsDesc')}
          control={
            <ModelListPicker
              providerId={activeProvider.id}
              endpointFormat={activeProvider.endpointFormat}
              baseUrl={activeProvider.baseUrl}
              apiKey={activeProvider.apiKey}
              models={activeProvider.models}
              onChange={(models) => updateActiveProviderProfile({ models })}
              t={t}
            />
          }
        />

        {/* Current model (composer) */}
        <SettingRow
          title={t('legalworkModel')}
          description={t('legalworkModelDesc')}
          control={
            legalwork.authMode === 'chatgpt' && codexAuthStatus?.models.length ? (
              <select
                className={`${selectControlClass} md:max-w-md`}
                value={legalwork.model}
                onChange={(e) => updateLegalwork({ model: e.target.value })}
              >
                {!codexAuthStatus.models.some((model) => model.id === legalwork.model) ? (
                  <option value={legalwork.model}>{legalwork.model}</option>
                ) : null}
                {codexAuthStatus.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}{model.isDefault ? ` · ${t('codexModelDefault')}` : ''}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30 md:max-w-md"
                value={legalwork.model}
                onChange={(e) => updateLegalwork({ model: e.target.value })}
              />
            )
          }
        />
      </SettingsCard>
    </div>
  )
}
