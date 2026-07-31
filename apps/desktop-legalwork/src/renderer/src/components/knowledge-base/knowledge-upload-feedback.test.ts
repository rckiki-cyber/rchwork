import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KNOWLEDGE_UPLOAD_FEEDBACK_DURATION_MS,
  KNOWLEDGE_UPLOAD_FEEDBACK_EXIT_MS,
  scheduleKnowledgeUploadFeedbackDismiss
} from './knowledge-upload-feedback'

describe('scheduleKnowledgeUploadFeedbackDismiss', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts the exit animation before dismissing at exactly three seconds', () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const onDismiss = vi.fn()

    scheduleKnowledgeUploadFeedbackDismiss(onExit, onDismiss)

    vi.advanceTimersByTime(
      KNOWLEDGE_UPLOAD_FEEDBACK_DURATION_MS - KNOWLEDGE_UPLOAD_FEEDBACK_EXIT_MS - 1
    )
    expect(onExit).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(onExit).toHaveBeenCalledOnce()
    expect(onDismiss).not.toHaveBeenCalled()

    vi.advanceTimersByTime(KNOWLEDGE_UPLOAD_FEEDBACK_EXIT_MS)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('cancels both scheduled transitions when another upload starts', () => {
    vi.useFakeTimers()
    const onExit = vi.fn()
    const onDismiss = vi.fn()
    const cancel = scheduleKnowledgeUploadFeedbackDismiss(onExit, onDismiss)

    cancel()
    vi.advanceTimersByTime(KNOWLEDGE_UPLOAD_FEEDBACK_DURATION_MS)

    expect(onExit).not.toHaveBeenCalled()
    expect(onDismiss).not.toHaveBeenCalled()
  })
})
