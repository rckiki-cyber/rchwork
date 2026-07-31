export const KNOWLEDGE_UPLOAD_FEEDBACK_DURATION_MS = 3000
export const KNOWLEDGE_UPLOAD_FEEDBACK_EXIT_MS = 300

export function scheduleKnowledgeUploadFeedbackDismiss(
  onExit: () => void,
  onDismiss: () => void
): () => void {
  const exitTimer = globalThis.setTimeout(
    onExit,
    KNOWLEDGE_UPLOAD_FEEDBACK_DURATION_MS - KNOWLEDGE_UPLOAD_FEEDBACK_EXIT_MS
  )
  const dismissTimer = globalThis.setTimeout(
    onDismiss,
    KNOWLEDGE_UPLOAD_FEEDBACK_DURATION_MS
  )

  return () => {
    globalThis.clearTimeout(exitTimer)
    globalThis.clearTimeout(dismissTimer)
  }
}
