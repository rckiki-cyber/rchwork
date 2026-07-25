import { create } from 'zustand'
import type {
  LearningIterationRecordDetail,
  LearningIterationRecordSummary,
  LearningIterationRuntimeStatus
} from '@shared/ds-gui-api'

type LearningIterationState = {
  status: LearningIterationRuntimeStatus | null
  records: LearningIterationRecordSummary[]
  selectedId: string | null
  detail: LearningIterationRecordDetail | null
  loading: boolean
  actionPending: boolean
  notice: string
  refresh: () => Promise<void>
  select: (id: string | null) => Promise<void>
  queue: () => Promise<void>
  cancel: () => Promise<void>
  rollback: (id: string) => Promise<void>
}

export const useLearningIterationStore = create<LearningIterationState>((set, get) => ({
  status: null,
  records: [],
  selectedId: null,
  detail: null,
  loading: false,
  actionPending: false,
  notice: '',

  refresh: async () => {
    if (typeof window.dsGui === 'undefined') return
    set({ loading: true })
    try {
      const [status, recordsResult] = await Promise.all([
        window.dsGui.getLearningIterationStatus(),
        window.dsGui.listLearningIterations()
      ])
      const records = recordsResult.ok ? recordsResult.records : []
      set({
        status,
        records,
        loading: false,
        ...(!recordsResult.ok ? { notice: recordsResult.message } : {})
      })
      const selectedId = get().selectedId
      if (selectedId && !records.some((record) => record.id === selectedId)) {
        set({ selectedId: null, detail: null })
      }
    } catch (error) {
      set({
        loading: false,
        notice: error instanceof Error ? error.message : String(error)
      })
    }
  },

  select: async (id) => {
    set({ selectedId: id, detail: null, notice: '' })
    if (!id || typeof window.dsGui === 'undefined') return
    set({ loading: true })
    const result = await window.dsGui.getLearningIteration(id)
    if (get().selectedId !== id) return
    set({
      loading: false,
      ...(result.ok ? { detail: result.detail } : { notice: result.message })
    })
  },

  queue: async () => {
    if (typeof window.dsGui === 'undefined') return
    set({ actionPending: true, notice: '' })
    const result = await window.dsGui.queueLearningIteration()
    set({ actionPending: false, notice: result.message })
    await get().refresh()
  },

  cancel: async () => {
    if (typeof window.dsGui === 'undefined') return
    set({ actionPending: true, notice: '' })
    const result = await window.dsGui.cancelLearningIteration()
    set({ actionPending: false, notice: result.message })
    await get().refresh()
  },

  rollback: async (id) => {
    if (typeof window.dsGui === 'undefined') return
    set({ actionPending: true, notice: '' })
    const result = await window.dsGui.rollbackLearningIteration(id)
    set({ actionPending: false, notice: result.message })
    await get().refresh()
    if (get().selectedId === id) await get().select(id)
  }
}))
