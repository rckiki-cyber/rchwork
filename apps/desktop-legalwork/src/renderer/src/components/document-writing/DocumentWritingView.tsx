import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { useCallback } from 'react'
import { DocumentKnowledgePanel } from './DocumentKnowledgePanel'
import { DocumentWritingEditor } from './DocumentWritingEditor'
import { useDocumentWriting } from './DocumentWritingContext'
import { DocumentWritingWorkflowPanel } from './DocumentWritingWorkflowPanel'

const KNOWLEDGE_PANEL_MIN_WIDTH = 360
const KNOWLEDGE_PANEL_MAX_WIDTH = 640

export function DocumentWritingView(): ReactElement {
  const documentWriting = useDocumentWriting()

  const beginKnowledgePanelResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      const startX = event.clientX
      const startWidth = documentWriting.knowledgePanelWidth
      const prevCursor = document.body.style.cursor
      const prevUserSelect = document.body.style.userSelect
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (moveEvent: PointerEvent): void => {
        const delta = startX - moveEvent.clientX
        const next = Math.min(
          KNOWLEDGE_PANEL_MAX_WIDTH,
          Math.max(KNOWLEDGE_PANEL_MIN_WIDTH, startWidth + delta)
        )
        documentWriting.setKnowledgePanelWidth(next)
      }

      const onUp = (): void => {
        document.body.style.cursor = prevCursor
        document.body.style.userSelect = prevUserSelect
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [documentWriting]
  )

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--ds-main)]">
        <DocumentWritingEditor
          template={documentWriting.activeTemplate}
          fieldValues={documentWriting.fieldValues}
          generatedContent={documentWriting.generatedContent}
          generating={documentWriting.generating}
          error={documentWriting.error}
          onFieldChange={documentWriting.handleFieldChange}
          onGeneratedContentChange={documentWriting.handleGeneratedContentChange}
          onGenerate={() => void documentWriting.handleGenerate()}
          onNewDocument={documentWriting.handleNewDocument}
          uploadedMaterials={documentWriting.uploadedMaterials}
          onAddMaterial={(file) => void documentWriting.handleAddMaterial(file)}
          onRemoveMaterial={documentWriting.handleRemoveMaterial}
          onUpdateInstruction={documentWriting.setInstruction}
          instruction={documentWriting.instruction}
        />
      </div>

      {documentWriting.knowledgePanelOpen ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            className="relative z-20 shrink-0 cursor-col-resize border-l border-[var(--ds-sidebar-divider)]"
            onPointerDown={beginKnowledgePanelResize}
          />
          <div
            className="flex shrink-0 flex-col overflow-hidden bg-[var(--ds-sidebar)]"
            style={{ width: documentWriting.knowledgePanelWidth }}
          >
            <DocumentKnowledgePanel onClose={() => documentWriting.setKnowledgePanelOpen(false)} />
          </div>
        </>
      ) : null}
      <DocumentWritingWorkflowPanel />
    </div>
  )
}
