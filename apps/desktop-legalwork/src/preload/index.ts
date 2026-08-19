import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DsGuiApi } from '../shared/ds-gui-api'

const api = {
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) =>
    ipcRenderer.invoke('settings:set', partial),
  getLocalFilePath: (file) => webUtils.getPathForFile(file),
  runtimeRequest: (path, method, body) =>
    ipcRenderer.invoke('runtime:request', { path, method, body }),
  reconnectRuntime: () => ipcRenderer.invoke('runtime:reconnect'),
  getCodexAuthStatus: (refreshToken) =>
    ipcRenderer.invoke('codex:auth-status', { refreshToken: refreshToken === true }),
  loginCodexWithChatGpt: () => ipcRenderer.invoke('codex:auth-login'),
  logoutCodex: () => ipcRenderer.invoke('codex:auth-logout'),
  getDataComplianceStatus: () =>
    ipcRenderer.invoke('data-compliance:status'),
  installDataCompliance: () =>
    ipcRenderer.invoke('data-compliance:install'),
  dataComplianceRequest: (path, method, body) =>
    ipcRenderer.invoke('data-compliance:request', { path, method, body }),
  submitDataComplianceTask: (payload) =>
    ipcRenderer.invoke('data-compliance:submit', payload),
  downloadDataComplianceFile: (taskId, fileKey) =>
    ipcRenderer.invoke('data-compliance:download-file', { taskId, fileKey }),
  fetchUpstreamModels: () => ipcRenderer.invoke('upstream:models'),
  fetchEndpointModels: (baseUrl, apiKey, options) =>
    ipcRenderer.invoke('upstream:models-for-endpoint', { baseUrl, apiKey, ...options }),
  getClawStatus: () => ipcRenderer.invoke('claw:status'),
  runClawTask: (taskId) =>
    ipcRenderer.invoke('claw:task:run', taskId),
  getScheduleStatus: () => ipcRenderer.invoke('schedule:status'),
  runScheduleTask: (taskId) =>
    ipcRenderer.invoke('schedule:task:run', taskId),
  getLearningIterationStatus: () =>
    ipcRenderer.invoke('learning-iteration:status'),
  listLearningIterations: () =>
    ipcRenderer.invoke('learning-iteration:list'),
  getLearningIteration: (id) =>
    ipcRenderer.invoke('learning-iteration:get', id),
  queueLearningIteration: () =>
    ipcRenderer.invoke('learning-iteration:queue'),
  cancelLearningIteration: () =>
    ipcRenderer.invoke('learning-iteration:cancel'),
  rollbackLearningIteration: (id) =>
    ipcRenderer.invoke('learning-iteration:rollback', id),
  startClawImInstallQr: (provider, options) =>
    ipcRenderer.invoke('claw:im-install:qrcode', { provider, isLark: options?.isLark }),
  pollClawImInstall: (provider, deviceCode) =>
    ipcRenderer.invoke('claw:im-install:poll', { provider, deviceCode }),
  pickWorkspaceDirectory: (defaultPath) =>
    ipcRenderer.invoke('workspace:pick-directory', defaultPath),
  listSkills: (workspaceRoot) =>
    ipcRenderer.invoke('skill:list', { workspaceRoot }),
  readSkillFile: (rootPath, entryPath) =>
    ipcRenderer.invoke('skill:read-file', { rootPath, entryPath }),
  saveSkillFile: (rootPath, skillName, content) =>
    ipcRenderer.invoke('skill:save-file', { rootPath, skillName, content }),
  importSkill: () =>
    ipcRenderer.invoke('skill:import'),
  listSkillHubSkills: (request) =>
    ipcRenderer.invoke('skillhub:list', request),
  installSkillHubSkill: (request) =>
    ipcRenderer.invoke('skillhub:install', request),
  openSkillRoot: (rootPath) =>
    ipcRenderer.invoke('skill:open-root', rootPath),
  getDeepseekConfigFile: () =>
    ipcRenderer.invoke('deepseek:config:read'),
  setDeepseekConfigFile: (content) =>
    ipcRenderer.invoke('deepseek:config:write', content),
  installOptionalMcpPackage: (packageId) =>
    ipcRenderer.invoke('mcp:install-optional-package', packageId),
  openDeepseekConfigDir: () =>
    ipcRenderer.invoke('deepseek:config:open-dir'),
  getGitBranches: (workspaceRoot) =>
    ipcRenderer.invoke('git:branches', workspaceRoot),
  switchGitBranch: (workspaceRoot, branch) =>
    ipcRenderer.invoke('git:switch-branch', { workspaceRoot, branch }),
  createAndSwitchGitBranch: (workspaceRoot, branch) =>
    ipcRenderer.invoke('git:create-and-switch-branch', { workspaceRoot, branch }),
  listEditors: () => ipcRenderer.invoke('editor:list'),
  openEditorPath: (options) =>
    ipcRenderer.invoke('editor:open-path', options),
  listWorkspaceDirectory: (options) =>
    ipcRenderer.invoke('file:list-workspace-directory', options),
  resolveWorkspaceFile: (options) =>
    ipcRenderer.invoke('file:resolve-workspace', options),
  readWorkspaceFile: (options) =>
    ipcRenderer.invoke('file:read-workspace', options),
  readWorkspaceBinary: (options) =>
    ipcRenderer.invoke('file:read-workspace-binary', options),
  readWorkspaceImage: (options) =>
    ipcRenderer.invoke('file:read-workspace-image', options),
  writeWorkspaceFile: (payload) =>
    ipcRenderer.invoke('file:write-workspace', payload),
  createWorkspaceFile: (payload) =>
    ipcRenderer.invoke('file:create-workspace', payload),
  createWorkspaceDirectory: (payload) =>
    ipcRenderer.invoke('file:create-workspace-directory', payload),
  saveWorkspaceClipboardImage: (payload) =>
    ipcRenderer.invoke('file:save-workspace-clipboard-image', payload),
  readClipboardImage: () =>
    ipcRenderer.invoke('clipboard:read-image'),
  renameWorkspaceEntry: (payload) =>
    ipcRenderer.invoke('file:rename-workspace-entry', payload),
  deleteWorkspaceEntry: (payload) =>
    ipcRenderer.invoke('file:delete-workspace-entry', payload),
  watchWorkspaceFile: (payload) =>
    ipcRenderer.invoke('file:watch-workspace', payload),
  unwatchWorkspaceFile: (watchId) =>
    ipcRenderer.invoke('file:unwatch-workspace', watchId),
  onWorkspaceFileChanged: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('file:workspace-changed', wrapped)
    return () => ipcRenderer.removeListener('file:workspace-changed', wrapped)
  },
  exportWriteDocument: (payload) =>
    ipcRenderer.invoke('write:export', payload),
  copyWriteDocumentAsRichText: (payload) =>
    ipcRenderer.invoke('write:copy-rich-text', payload),
  exportLegalResearchToWord: (payload) =>
    ipcRenderer.invoke('legal-research:export-word', payload),
  exportMarkdownDocument: (payload) =>
    ipcRenderer.invoke('document:export-markdown', payload),
  requestWriteInlineCompletion: (payload) =>
    ipcRenderer.invoke('write:inline-completion', payload),
  generateDocument: (payload) =>
    ipcRenderer.invoke('document:generate', payload),
  listUserTemplates: () =>
    ipcRenderer.invoke('templates:list'),
  saveUserTemplate: (template) =>
    ipcRenderer.invoke('templates:save', template),
  saveUserTemplateSource: (payload) =>
    ipcRenderer.invoke('templates:save-source', payload),
  deleteUserTemplate: (id) =>
    ipcRenderer.invoke('templates:delete', id),
  learnTemplateFromFile: (payload) =>
    ipcRenderer.invoke('templates:learn', payload),
  generateDocumentFromTemplate: (payload) =>
    ipcRenderer.invoke('templates:generate', payload),
  extractDocumentMaterial: (payload) =>
    ipcRenderer.invoke('document:material:extract', payload),
  listDocumentHistory: () =>
    ipcRenderer.invoke('history:list'),
  getDocumentHistoryRecord: (id) =>
    ipcRenderer.invoke('history:get', id),
  saveDocumentHistoryRecord: (record) =>
    ipcRenderer.invoke('history:save', record),
  deleteDocumentHistoryRecord: (id) =>
    ipcRenderer.invoke('history:delete', id),
  clearDocumentHistory: () =>
    ipcRenderer.invoke('history:clear'),
  listWriteInlineCompletionDebugEntries: () =>
    ipcRenderer.invoke('write:inline-completion-debug:list'),
  clearWriteInlineCompletionDebugEntries: () =>
    ipcRenderer.invoke('write:inline-completion-debug:clear'),
  startSse: (threadId, sinceSeq, streamId) =>
    ipcRenderer.invoke('runtime:sse:start', { threadId, sinceSeq, streamId }),
  stopSse: (streamId) => ipcRenderer.invoke('runtime:sse:stop', streamId),
  onSseEvent: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('runtime:sse-event', wrapped)
    return () => ipcRenderer.removeListener('runtime:sse-event', wrapped)
  },
  onSseEnd: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('runtime:sse-end', wrapped)
    return () => ipcRenderer.removeListener('runtime:sse-end', wrapped)
  },
  onSseError: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('runtime:sse-error', wrapped)
    return () => ipcRenderer.removeListener('runtime:sse-error', wrapped)
  },
  onClawChannelActivity: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('claw:channel-activity', wrapped)
    return () => ipcRenderer.removeListener('claw:channel-activity', wrapped)
  },
  mirrorClawChannelMessage: (threadId, text, direction) =>
    ipcRenderer.invoke('claw:channel:mirror', { threadId, text, direction }),
  mirrorClawChannelMessageToFeishu: (threadId, text, direction) =>
    ipcRenderer.invoke('claw:channel:mirror-to-feishu', { threadId, text, direction }),
  createClawTaskFromText: (text, options) =>
    ipcRenderer.invoke('claw:task:create-from-text', {
      text,
      channelId: options?.channelId,
      modelHint: options?.modelHint,
      mode: options?.mode
    }),
  createScheduleTaskFromText: (text, options) =>
    ipcRenderer.invoke('schedule:task:create-from-text', {
      text,
      workspaceRoot: options?.workspaceRoot,
      modelHint: options?.modelHint,
      mode: options?.mode
    }),
  runDesktopCommand: (command) =>
    ipcRenderer.invoke('desktop:command', command),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  openLocalPath: (path) => ipcRenderer.invoke('shell:open-path', path),
  openKnowledgeFile: (path) => ipcRenderer.invoke('knowledge:open-file', { path }),
  uploadKnowledgeFile: (file, targetPath) => {
    const sourcePath = webUtils.getPathForFile(file)
    if (!sourcePath) {
      return Promise.resolve({ ok: false as const, message: '无法读取所选文件路径' })
    }
    return ipcRenderer.invoke('knowledge:upload-file', { sourcePath, targetPath })
  },
  uploadAttachmentFile: (file, payload) => {
    const sourcePath = webUtils.getPathForFile(file)
    if (!sourcePath) {
      return Promise.resolve({ ok: false, status: 400, body: '无法读取所选文件路径' })
    }
    return ipcRenderer.invoke('runtime:request', {
      path: '/v1/attachments/from-file',
      method: 'POST',
      body: JSON.stringify({ ...payload, sourcePath })
    })
  },
  showTurnCompleteNotification: (payload) => ipcRenderer.invoke('notification:turn-complete', payload),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getGuiUpdateState: () => ipcRenderer.invoke('gui:update-state'),
  checkGuiUpdate: (channel) =>
    ipcRenderer.invoke('gui:update-check', channel),
  downloadGuiUpdate: (channel) =>
    ipcRenderer.invoke('gui:update-download', channel),
  installGuiUpdate: () => ipcRenderer.invoke('gui:update-install'),
  onGuiUpdateState: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('gui:update-state', wrapped)
    return () => ipcRenderer.removeListener('gui:update-state', wrapped)
  },
  onDataComplianceInstallProgress: (handler) => {
    const wrapped = (
      _: Electron.IpcRendererEvent,
      payload: Parameters<typeof handler>[0]
    ) => handler(payload)
    ipcRenderer.on('data-compliance:install-progress', wrapped)
    return () => ipcRenderer.removeListener('data-compliance:install-progress', wrapped)
  },
  logError: (category, message, detail) =>
    ipcRenderer.invoke('log:error', { category, message, detail }),
  getLogPath: () => ipcRenderer.invoke('log:get-path'),
  openLogDir: () => ipcRenderer.invoke('log:open-dir'),

  // IMA 知识库认证
  imaAuthStatus: () => ipcRenderer.invoke('ima:auth-status'),
  imaLogin: () => ipcRenderer.invoke('ima:auth-login'),
  imaRelogin: () => ipcRenderer.invoke('ima:auth-relogin'),
  imaLogout: () => ipcRenderer.invoke('ima:auth-logout'),
  imaGetConfig: () => ipcRenderer.invoke('ima:get-config'),
  imaGetMcpConfig: () => ipcRenderer.invoke('ima:get-mcp-config'),
  imaRefresh: () => ipcRenderer.invoke('ima:auth-refresh'),

  // 北大法宝内置控制台
  openPkulawConsole: () => ipcRenderer.invoke('pkulaw:open-console'),
  claimPkulawToken: () => ipcRenderer.invoke('pkulaw:claim-token'),
  getPkulawAutoClaim: () => ipcRenderer.invoke('pkulaw:auto-claim-state'),
  setPkulawAutoClaim: (enabled: boolean) => ipcRenderer.invoke('pkulaw:auto-claim-set', enabled),

  // 元典内置控制台
  openYuandianConsole: () => ipcRenderer.invoke('yuandian:open-console'),

  // 威科先行内置控制台
  openWkConsole: () => ipcRenderer.invoke('wk:open-console'),

  // 天眼查 / 企查查 内置控制台
  openTycConsole: () => ipcRenderer.invoke('tyc:open-console'),
  openQccConsole: () => ipcRenderer.invoke('qcc:open-console'),
} satisfies DsGuiApi

contextBridge.exposeInMainWorld('dsGui', api)
