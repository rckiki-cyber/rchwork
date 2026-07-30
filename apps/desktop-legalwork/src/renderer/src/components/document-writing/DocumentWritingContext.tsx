import type { ReactElement, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  builtInTemplates,
  type LegalTemplate,
  type TemplateCategory,
  withInferredTemplateFields
} from './legal-templates'
import type { DocumentHistoryRecord } from '../../../../shared/document-history'
import type { UserTemplate } from '../../../../shared/user-templates'
import { getProvider } from '../../agent/registry'
import type { ThreadDeltaEvent, ThreadEventSink, ToolEventPayload } from '../../agent/types'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { normalizeWorkspaceRoot } from '../../lib/workspace-path'
import {
  advanceDocumentWritingStage,
  buildDocumentWritingAgentPrompt,
  completeDocumentWritingStages,
  createDocumentWritingStages,
  documentWritingStageForTool,
  updateDocumentWritingStages,
  type DocumentWritingStage
} from './document-writing-agent'

export type UploadedMaterial = {
  id: string
  file: File
  name: string
  content: string
  loaded: boolean
  error?: string
}

export type DocumentWritingWorkflow = {
  status: 'idle' | 'running' | 'done' | 'error'
  stages: DocumentWritingStage[]
  toolCount: number
  reasoning: string
  lastTool?: string
  error?: string
}

export type DocumentWritingWorkflowVisibility = 'expanded' | 'minimized' | 'hidden'

function idleWorkflow(): DocumentWritingWorkflow {
  return {
    status: 'idle',
    stages: createDocumentWritingStages(0).map((stage) => ({ ...stage, status: 'pending' })),
    toolCount: 0,
    reasoning: ''
  }
}

type DocumentWritingContextValue = {
  leftTab: 'templates' | 'history'
  setLeftTab: (tab: 'templates' | 'history') => void
  historyRefreshSignal: number
  activeCategory: TemplateCategory | 'all'
  activeTemplateId: string | null
  searchQuery: string
  setSearchQuery: (query: string) => void
  fieldValues: Record<string, string>
  generatedContent: string | null
  generating: boolean
  error: string | null
  uploaderOpen: boolean
  setUploaderOpen: (open: boolean) => void
  userTemplates: LegalTemplate[]
  loadingTemplates: boolean
  deletingTemplateId: string | null
  uploadedMaterials: UploadedMaterial[]
  instruction: string
  setInstruction: (value: string) => void
  workflow: DocumentWritingWorkflow
  workflowVisibility: DocumentWritingWorkflowVisibility
  setWorkflowVisibility: (visibility: DocumentWritingWorkflowVisibility) => void
  knowledgePanelOpen: boolean
  setKnowledgePanelOpen: (open: boolean) => void
  knowledgePanelWidth: number
  setKnowledgePanelWidth: (width: number) => void
  showUserTemplates: boolean
  allTemplates: LegalTemplate[]
  activeTemplate: LegalTemplate | null
  handleSelectTemplate: (template: LegalTemplate) => void
  handleFieldChange: (fieldId: string, value: string) => void
  handleGeneratedContentChange: (content: string) => void
  handleGenerate: () => Promise<void>
  handleNewDocument: () => void
  handleUpload: (file: File) => Promise<void>
  handleRestoreHistory: (record: DocumentHistoryRecord) => void
  handleDeleteUserTemplate: (templateId: string) => Promise<void>
  handleAddMaterial: (file: File) => Promise<void>
  handleRemoveMaterial: (index: number) => void
  handleCategoryChange: (category: TemplateCategory | 'all') => void
  handleKnowledgeToggle: () => void
}

const DocumentWritingContext = createContext<DocumentWritingContextValue | null>(null)

function userTemplateToLegalTemplate(ut: UserTemplate): LegalTemplate {
  return withInferredTemplateFields({
    id: ut.id,
    name: ut.name,
    category: ut.category,
    description: ut.description,
    content: ut.content,
    fields: ut.fields.map((f) => ({
      ...f,
      type: f.type as LegalTemplate['fields'][number]['type']
    })),
    legalBasis: ut.legalBasis,
    icon: '📄',
    learningStatus: (ut.learningStatus || 'idle') as LegalTemplate['learningStatus']
  })
}

function explicitRequiredFieldMissing(template: LegalTemplate, fieldValues: Record<string, string>): string[] {
  return template.fields
    .filter((field) => field.required && field.type === 'select' && !fieldValues[field.id]?.trim())
    .map((field) => field.label)
}

function missingRequiredFields(template: LegalTemplate, fieldValues: Record<string, string>): string[] {
  return template.fields
    .filter((field) => field.required && !fieldValues[field.id]?.trim())
    .map((field) => field.label)
}

function loadedMaterials(materials: UploadedMaterial[]): Array<{ fileName: string; content: string }> {
  return materials
    .filter((material) => material.loaded && material.content.trim())
    .map((material) => ({ fileName: material.name, content: material.content }))
}

const TEMPLATE_CONTENT_MAX_CHARS = 50_000
const TEMPLATE_OPERATION_TIMEOUT_MS = 30_000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

async function extractMaterialText(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (['txt', 'md', 'markdown', 'csv', 'json', 'html', 'xml'].includes(ext)) {
    return file.text()
  }
  if (typeof window.dsGui?.extractDocumentMaterial === 'function') {
    const dataBase64 = await fileToBase64(file)
    const result = await window.dsGui.extractDocumentMaterial({
      fileName: file.name,
      mimeType: file.type || undefined,
      dataBase64
    })
    if (result.ok) return result.content
    throw new Error(result.message)
  }
  throw new Error('当前版本无法读取该材料格式，请先转换为 txt 或 md。')
}

async function extractTemplateText(file: File): Promise<string> {
  const content = await withTimeout(
    extractMaterialText(file),
    TEMPLATE_OPERATION_TIMEOUT_MS,
    '读取模板文件超时，请确认文件可正常打开后重试。'
  )
  const normalized = content.split('\u0000').join('').trim()
  if (!normalized) throw new Error('未能从模板文件中提取到文字。')
  return normalized.slice(0, TEMPLATE_CONTENT_MAX_CHARS)
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

export function DocumentWritingProvider({ children }: { children: ReactNode }): ReactElement {
  const [leftTab, setLeftTab] = useState<'templates' | 'history'>('templates')
  const [historyRefreshSignal, setHistoryRefreshSignal] = useState(0)
  const [activeCategory, setActiveCategory] = useState<TemplateCategory | 'all'>('all')
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [generatedContent, setGeneratedContent] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploaderOpen, setUploaderOpen] = useState(false)
  const [userTemplates, setUserTemplates] = useState<LegalTemplate[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null)
  const [uploadedMaterials, setUploadedMaterials] = useState<UploadedMaterial[]>([])
  const [instruction, setInstruction] = useState('')
  const [workflow, setWorkflow] = useState<DocumentWritingWorkflow>(idleWorkflow)
  const [workflowVisibility, setWorkflowVisibility] = useState<DocumentWritingWorkflowVisibility>('hidden')
  const [knowledgePanelOpen, setKnowledgePanelOpen] = useState(false)
  const [knowledgePanelWidth, setKnowledgePanelWidth] = useState(460)
  const workflowAbortRef = useRef<AbortController | null>(null)
  const workflowRunRef = useRef(0)

  const normalizedBuiltInTemplates = useMemo(
    () => builtInTemplates.map(withInferredTemplateFields),
    []
  )

  const showUserTemplates = activeCategory === 'custom'

  const loadUserTemplates = useCallback(async () => {
    setLoadingTemplates(true)
    try {
      const result = await withTimeout(
        window.dsGui.listUserTemplates(),
        10_000,
        '加载自定义模板超时'
      )
      setUserTemplates(result.map(userTemplateToLegalTemplate))
    } catch {
      // Backend not available - just use built-in.
    } finally {
      setLoadingTemplates(false)
    }
  }, [])

  useEffect(() => {
    void loadUserTemplates()
  }, [loadUserTemplates])

  useEffect(() => () => workflowAbortRef.current?.abort(), [])

  const allTemplates = useMemo(() => {
    if (activeCategory === 'custom') return userTemplates
    if (activeCategory === 'all') return [...normalizedBuiltInTemplates, ...userTemplates]
    return normalizedBuiltInTemplates.filter((template) => template.category === activeCategory)
  }, [activeCategory, normalizedBuiltInTemplates, userTemplates])

  const activeTemplate = useMemo(
    () => allTemplates.find((template) => template.id === activeTemplateId) ?? null,
    [activeTemplateId, allTemplates]
  )

  const resetEditor = useCallback(() => {
    setFieldValues({})
    setGeneratedContent(null)
    setError(null)
    setUploadedMaterials([])
    setInstruction('')
  }, [])

  const handleSelectTemplate = useCallback(
    (template: LegalTemplate) => {
      setActiveTemplateId(template.id)
      resetEditor()
    },
    [resetEditor]
  )

  const handleFieldChange = useCallback((fieldId: string, value: string) => {
    if (fieldId === '__reset__') {
      setGeneratedContent(null)
      setError(null)
      return
    }
    setFieldValues((prev) => ({ ...prev, [fieldId]: value }))
  }, [])

  const handleGeneratedContentChange = useCallback((content: string) => {
    setGeneratedContent(content)
  }, [])

  const saveCurrentToHistory = useCallback(
    async (contentOverride?: string) => {
      if (!activeTemplate) return
      const content = contentOverride ?? generatedContent
      if (!content) return
      try {
        await window.dsGui.saveDocumentHistoryRecord({
          id: `hist-${Date.now()}`,
          templateName: activeTemplate.name,
          templateCategory: activeTemplate.category,
          templateSource: activeTemplate.category === 'custom' ? 'custom' : 'builtin',
          fieldValues,
          materialFileNames: uploadedMaterials.filter((material) => material.loaded).map((material) => material.name),
          instructions: instruction,
          generatedContent: content,
          createdAt: new Date().toISOString()
        })
        setHistoryRefreshSignal((count) => count + 1)
      } catch {
        // History is helpful, but generation should not fail because of it.
      }
    },
    [activeTemplate, fieldValues, generatedContent, instruction, uploadedMaterials]
  )

  const handleGenerate = useCallback(async () => {
    if (!activeTemplate) return
    const materials = loadedMaterials(uploadedMaterials)
    const explicitMissing = explicitRequiredFieldMissing(activeTemplate, fieldValues)
    if (explicitMissing.length > 0) {
      setError(`请先选择必填身份/方向字段：${explicitMissing.join('、')}`)
      return
    }
    const missing = missingRequiredFields(activeTemplate, fieldValues)
    if (missing.length > 0 && materials.length === 0) {
      setError(`请填写必填字段，或上传可供提取事实的案件材料：${missing.join('、')}`)
      return
    }

    workflowAbortRef.current?.abort()
    const abortController = new AbortController()
    workflowAbortRef.current = abortController
    const runId = ++workflowRunRef.current
    const request = {
      template: {
        id: activeTemplate.id,
        name: activeTemplate.name,
        description: activeTemplate.description,
        content: activeTemplate.content,
        fields: activeTemplate.fields,
        legalBasis: activeTemplate.legalBasis,
        source: activeTemplate.category === 'custom' ? ('user' as const) : ('catalog' as const)
      },
      fieldValues,
      materials: materials.length > 0 ? materials : undefined,
      instructions: instruction.trim() || undefined
    }

    setGenerating(true)
    setError(null)
    setWorkflowVisibility('expanded')
    setWorkflow({
      status: 'running',
      stages: createDocumentWritingStages(materials.length),
      toolCount: 0,
      reasoning: ''
    })

    try {
      const provider = getProvider()
      const settings = await rendererRuntimeClient.getSettings()
      const workspace = normalizeWorkspaceRoot(settings.workspaceRoot) || '~'
      const thread = await provider.createThread({
        workspace,
        title: `文书写作：${activeTemplate.name}`,
        mode: 'agent'
      })
      const sent = await provider.sendUserMessage(thread.id, buildDocumentWritingAgentPrompt(request), {
        mode: 'agent'
      })
      let assistantText = ''
      let reasoning = ''
      let completed = false

      const updateWorkflow = (updater: (current: DocumentWritingWorkflow) => DocumentWritingWorkflow): void => {
        if (workflowRunRef.current !== runId) return
        setWorkflow((current) => updater(current))
      }
      const fail = (message: string): void => {
        if (completed || workflowRunRef.current !== runId) return
        completed = true
        updateWorkflow((current) => ({
          ...current,
          status: 'error',
          error: message,
          stages: updateDocumentWritingStages(
            current.stages,
            current.stages.find((stage) => stage.status === 'running')?.id ?? 'materials',
            'error',
            message
          )
        }))
        setError(message)
      }

      const sink: ThreadEventSink = {
        onSeq: () => {},
        onDeltas: (deltas: ThreadDeltaEvent[]) => {
          for (const delta of deltas) {
            if (delta.kind === 'agent_message') assistantText += delta.text
            else reasoning += delta.text
          }
          updateWorkflow((current) => ({
            ...current,
            reasoning: reasoning.trim(),
            stages: assistantText.trim()
              ? advanceDocumentWritingStage(current.stages, 'drafting', '正在组织并写入文书正文')
              : advanceDocumentWritingStage(current.stages, 'issues', '正在归纳争议焦点和证明要点')
          }))
        },
        onUserMessage: () => {},
        onTool: (event: ToolEventPayload) => {
          const stageId = documentWritingStageForTool(
            event.summary,
            typeof event.meta?.toolName === 'string' ? event.meta.toolName : undefined
          )
          updateWorkflow((current) => ({
            ...current,
            toolCount: current.toolCount + (event.status === 'running' ? 1 : 0),
            lastTool: event.summary || '正在调用法律工具',
            stages: advanceDocumentWritingStage(
              current.stages,
              stageId,
              event.status === 'error'
                ? `${event.summary || '工具调用'}未成功，正在尝试其他来源`
                : event.summary || current.stages.find((stage) => stage.id === stageId)?.detail
            )
          }))
        },
        onCompaction: () => {},
        onApproval: () => {},
        onUserInput: () => {},
        onUserInputStatus: () => {},
        onGoal: () => {},
        onTurnComplete: () => {
          if (workflowRunRef.current !== runId) return
          const content = assistantText.trim()
          if (!content) {
            fail('文书 Agent 已结束，但未返回文书正文。')
            return
          }
          completed = true
          setGeneratedContent(content)
          void saveCurrentToHistory(content)
          updateWorkflow((current) => ({
            ...current,
            status: 'done',
            stages: completeDocumentWritingStages(current.stages)
          }))
        },
        onError: (event) => fail(`文书生成连接中断：${event.message}`)
      }

      await provider.subscribeThreadEvents(thread.id, 0, sink, abortController.signal)
      if (!abortController.signal.aborted && !completed) {
        fail('文书生成连接已结束，但未收到完成事件。')
      }
      void sent
    } catch (err) {
      if (!abortController.signal.aborted) {
        const message = err instanceof Error ? err.message : '生成失败，请重试。'
        setError(message)
        setWorkflow((current) => ({ ...current, status: 'error', error: message }))
      }
    } finally {
      if (workflowRunRef.current === runId) {
        setGenerating(false)
        workflowAbortRef.current = null
      }
    }
  }, [activeTemplate, fieldValues, instruction, saveCurrentToHistory, uploadedMaterials])

  const handleNewDocument = useCallback(() => {
    setActiveTemplateId(null)
    resetEditor()
  }, [resetEditor])

  const handleUpload = useCallback(
    async (file: File) => {
      const text = await extractTemplateText(file)
      const now = new Date().toISOString()
      const templateId = `custom-${Date.now()}`
      const newTemplate: UserTemplate = {
        id: templateId,
        name: file.name.replace(/\.[^/.]+$/, ''),
        description: `用户上传模板：${file.name}`,
        category: 'custom',
        content: text,
        fields: [
          {
            id: 'content',
            label: '文书内容',
            type: 'textarea',
            placeholder: '请输入或编辑文书内容',
            required: true
          }
        ],
        sourceFile: file.name,
        learningStatus: 'analyzing',
        createdAt: now,
        updatedAt: now
      }
      const saveResult = await withTimeout(
        window.dsGui.saveUserTemplate(newTemplate),
        10_000,
        '保存模板超时，请重试。'
      )
      if (!saveResult.ok) throw new Error(saveResult.message)
      setUserTemplates((current) => [
        ...current.filter((template) => template.id !== templateId),
        userTemplateToLegalTemplate(newTemplate)
      ])
      void loadUserTemplates()

      // Background AI learning
      window.dsGui.learnTemplateFromFile({
        fileContent: text,
        fileName: file.name
      }).then((result) => {
        if (!result.ok) {
          // Update template with failed status
          window.dsGui.saveUserTemplate({
            ...newTemplate,
            learningStatus: 'failed',
            updatedAt: new Date().toISOString()
          }).then(() => loadUserTemplates()).catch(() => {})
          return
        }
        // Update template with learned fields
        window.dsGui.saveUserTemplate({
          ...newTemplate,
          name: result.name || newTemplate.name,
          description: result.description || newTemplate.description,
          content: result.content || text,
          fields: result.fields.map((f: { id: string; label: string; type: string; placeholder?: string; required?: boolean }) => ({
            id: f.id,
            label: f.label,
            type: f.type as 'text' | 'textarea' | 'date' | 'select' | 'array',
            placeholder: f.placeholder,
            required: f.required
          })),
          learningStatus: 'done',
          updatedAt: new Date().toISOString()
        }).then(() => loadUserTemplates()).catch(() => {})
      }).catch(() => {
        window.dsGui.saveUserTemplate({
          ...newTemplate,
          learningStatus: 'failed',
          updatedAt: new Date().toISOString()
        }).then(() => loadUserTemplates()).catch(() => {})
      })
    },
    [loadUserTemplates]
  )

  const handleRestoreHistory = useCallback(
    (record: DocumentHistoryRecord) => {
      const matchedTemplate = allTemplates.find(
        (template) =>
          template.name === record.templateName &&
          (template.category === record.templateCategory || record.templateCategory === 'custom')
      )
      if (matchedTemplate) setActiveTemplateId(matchedTemplate.id)
      setFieldValues(record.fieldValues)
      setGeneratedContent(record.generatedContent)
      setUploadedMaterials([])
      setInstruction(record.instructions)
      setLeftTab('templates')
    },
    [allTemplates]
  )

  const handleDeleteUserTemplate = useCallback(
    async (templateId: string) => {
      setDeletingTemplateId(templateId)
      try {
        await window.dsGui.deleteUserTemplate(templateId)
        await loadUserTemplates()
        if (activeTemplateId === templateId) handleNewDocument()
      } finally {
        setDeletingTemplateId(null)
      }
    },
    [activeTemplateId, handleNewDocument, loadUserTemplates]
  )

  const handleAddMaterial = useCallback(async (file: File) => {
    const materialId = `${file.name}-${Date.now()}`
    setUploadedMaterials((prev) => [
      ...prev,
      { id: materialId, file, name: file.name, content: '', loaded: false }
    ])
    try {
      const text = await extractMaterialText(file)
      setUploadedMaterials((prev) =>
        prev.map((material) =>
          material.id === materialId
            ? { ...material, content: text, loaded: true }
            : material
        )
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : '材料读取失败'
      setUploadedMaterials((prev) =>
        prev.map((material) =>
          material.id === materialId
            ? { ...material, error: message, loaded: false }
            : material
        )
      )
      setError(message)
    }
  }, [])

  const handleRemoveMaterial = useCallback((index: number) => {
    setUploadedMaterials((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleCategoryChange = useCallback(
    (category: TemplateCategory | 'all') => {
      setActiveCategory(category)
      setActiveTemplateId(null)
      resetEditor()
    },
    [resetEditor]
  )

  const handleKnowledgeToggle = useCallback(() => {
    setKnowledgePanelOpen((open) => !open)
  }, [])

  const value = useMemo<DocumentWritingContextValue>(
    () => ({
      leftTab,
      setLeftTab,
      historyRefreshSignal,
      activeCategory,
      activeTemplateId,
      searchQuery,
      setSearchQuery,
      fieldValues,
      generatedContent,
      generating,
      error,
      uploaderOpen,
      setUploaderOpen,
      userTemplates,
      loadingTemplates,
      deletingTemplateId,
      uploadedMaterials,
      instruction,
      setInstruction,
      workflow,
      workflowVisibility,
      setWorkflowVisibility,
      knowledgePanelOpen,
      setKnowledgePanelOpen,
      knowledgePanelWidth,
      setKnowledgePanelWidth,
      showUserTemplates,
      allTemplates,
      activeTemplate,
      handleSelectTemplate,
      handleFieldChange,
      handleGeneratedContentChange,
      handleGenerate,
      handleNewDocument,
      handleUpload,
      handleRestoreHistory,
      handleDeleteUserTemplate,
      handleAddMaterial,
      handleRemoveMaterial,
      handleCategoryChange,
      handleKnowledgeToggle
    }),
    [
      activeCategory,
      activeTemplate,
      activeTemplateId,
      allTemplates,
      deletingTemplateId,
      error,
      fieldValues,
      generatedContent,
      generating,
      handleAddMaterial,
      handleCategoryChange,
      handleDeleteUserTemplate,
      handleFieldChange,
      handleGeneratedContentChange,
      handleGenerate,
      handleKnowledgeToggle,
      handleNewDocument,
      handleRemoveMaterial,
      handleRestoreHistory,
      handleSelectTemplate,
      handleUpload,
      historyRefreshSignal,
      instruction,
      knowledgePanelOpen,
      knowledgePanelWidth,
      leftTab,
      loadingTemplates,
      searchQuery,
      showUserTemplates,
      uploadedMaterials,
      uploaderOpen,
      userTemplates,
      workflow,
      workflowVisibility
    ]
  )

  return (
    <DocumentWritingContext.Provider value={value}>
      {children}
    </DocumentWritingContext.Provider>
  )
}

export function useDocumentWriting(): DocumentWritingContextValue {
  const value = useContext(DocumentWritingContext)
  if (!value) {
    throw new Error('useDocumentWriting must be used within DocumentWritingProvider')
  }
  return value
}
