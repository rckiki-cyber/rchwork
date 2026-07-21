import type { ReactElement, ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  builtInTemplates,
  type LegalTemplate,
  type TemplateCategory,
  withInferredTemplateFields
} from './legal-templates'
import type { DocumentHistoryRecord } from '../../../../shared/document-history'
import type { UserTemplate } from '../../../../shared/user-templates'

export type UploadedMaterial = {
  id: string
  file: File
  name: string
  content: string
  loaded: boolean
  error?: string
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
  knowledgePanelOpen: boolean
  setKnowledgePanelOpen: (open: boolean) => void
  knowledgePanelWidth: number
  setKnowledgePanelWidth: (width: number) => void
  showUserTemplates: boolean
  allTemplates: LegalTemplate[]
  activeTemplate: LegalTemplate | null
  handleSelectTemplate: (template: LegalTemplate) => void
  handleFieldChange: (fieldId: string, value: string) => void
  handleGenerate: () => Promise<void>
  handleNewDocument: () => void
  handleUpload: (file: File) => Promise<void>
  handleSaveLearnedTemplate: (learned: {
    name: string
    description: string
    content: string
    fields: Array<{
      id: string
      label: string
      type: string
      placeholder?: string
      required?: boolean
    }>
  }) => Promise<void>
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
    icon: '📄'
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
  const [knowledgePanelOpen, setKnowledgePanelOpen] = useState(false)
  const [knowledgePanelWidth, setKnowledgePanelWidth] = useState(460)

  const normalizedBuiltInTemplates = useMemo(
    () => builtInTemplates.map(withInferredTemplateFields),
    []
  )

  const showUserTemplates = activeCategory === 'custom'

  const loadUserTemplates = useCallback(async () => {
    setLoadingTemplates(true)
    try {
      const stored = await window.dsGui.listUserTemplates()
      setUserTemplates(stored.map(userTemplateToLegalTemplate))
    } catch {
      // Backend not available - just use built-in.
    } finally {
      setLoadingTemplates(false)
    }
  }, [])

  useEffect(() => {
    void loadUserTemplates()
  }, [loadUserTemplates])

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

    setGenerating(true)
    setError(null)

    try {
      const result = await window.dsGui.generateDocumentFromTemplate({
        template: {
          id: activeTemplate.id,
          name: activeTemplate.name,
          description: activeTemplate.description,
          content: activeTemplate.content,
          fields: activeTemplate.fields,
          legalBasis: activeTemplate.legalBasis
        },
        fieldValues,
        materials: materials.length > 0 ? materials : undefined,
        instructions: instruction.trim() || undefined
      })

      if (result.ok) {
        setGeneratedContent(result.content)
        void saveCurrentToHistory(result.content)
      } else {
        setError(result.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败，请重试。')
    } finally {
      setGenerating(false)
    }
  }, [activeTemplate, fieldValues, instruction, saveCurrentToHistory, uploadedMaterials])

  const handleNewDocument = useCallback(() => {
    setActiveTemplateId(null)
    resetEditor()
  }, [resetEditor])

  const handleUpload = useCallback(
    async (file: File) => {
      const text = await file.text()
      const now = new Date().toISOString()
      const newTemplate: UserTemplate = {
        id: `custom-${Date.now()}`,
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
        createdAt: now,
        updatedAt: now
      }
      const saveResult = await window.dsGui.saveUserTemplate(newTemplate)
      if (!saveResult.ok) throw new Error(saveResult.message)
      await loadUserTemplates()
    },
    [loadUserTemplates]
  )

  const handleSaveLearnedTemplate = useCallback(
    async (learned: {
      name: string
      description: string
      content: string
      fields: Array<{
        id: string
        label: string
        type: string
        placeholder?: string
        required?: boolean
      }>
    }) => {
      const now = new Date().toISOString()
      const newTemplate: UserTemplate = {
        id: `custom-${Date.now()}`,
        name: learned.name,
        description: learned.description,
        category: 'custom',
        content: learned.content,
        fields: learned.fields.map((field) => ({
          id: field.id,
          label: field.label,
          type: field.type as 'text' | 'textarea' | 'date' | 'select' | 'array',
          placeholder: field.placeholder,
          required: field.required
        })),
        createdAt: now,
        updatedAt: now
      }
      const saveResult = await window.dsGui.saveUserTemplate(newTemplate)
      if (!saveResult.ok) throw new Error(saveResult.message)
      await loadUserTemplates()
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
      knowledgePanelOpen,
      setKnowledgePanelOpen,
      knowledgePanelWidth,
      setKnowledgePanelWidth,
      showUserTemplates,
      allTemplates,
      activeTemplate,
      handleSelectTemplate,
      handleFieldChange,
      handleGenerate,
      handleNewDocument,
      handleUpload,
      handleSaveLearnedTemplate,
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
      handleGenerate,
      handleKnowledgeToggle,
      handleNewDocument,
      handleRemoveMaterial,
      handleRestoreHistory,
      handleSaveLearnedTemplate,
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
      userTemplates
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
