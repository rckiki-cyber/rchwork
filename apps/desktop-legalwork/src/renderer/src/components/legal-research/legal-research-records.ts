export type EditableResearchRecord = {
  id: string
  summary: string
  editedSummary?: string
  reportRevision?: number
  updatedAt?: number
}

export function applyLegalResearchSummaryEdit<T extends EditableResearchRecord>(
  records: T[],
  id: string,
  markdown: string,
  editedAt = Date.now()
): T[] {
  return records.map((record) =>
    record.id === id
      ? {
          ...record,
          summary: markdown,
          editedSummary: markdown,
          reportRevision: editedAt,
          updatedAt: editedAt
        }
      : record
  )
}
