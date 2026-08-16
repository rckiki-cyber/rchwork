export const LEARNING_ITERATION_THREAD_PREFIX = '[Learning iteration]'

/**
 * Threads created by the idle-time learning iteration runtime. Their prompt
 * explicitly forbids tool calls ("Do not call any tools") because the runtime
 * owns validation and publishing. Delivery-quality gates must not reinterpret
 * corpus words such as 知识库/检索/来源 as a user request to retrieve
 * knowledge — otherwise a completed check is falsely marked as failed.
 */
export function isLearningIterationThreadTitle(title: string | undefined): boolean {
  return (title?.trim() ?? '').startsWith(LEARNING_ITERATION_THREAD_PREFIX)
}
