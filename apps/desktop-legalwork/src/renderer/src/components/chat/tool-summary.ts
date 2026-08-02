/**
 * Small, dependency-free helpers for deriving a tool name from a block summary.
 * Split out of message-timeline-process.tsx so both the process renderer and
 * orb-state.ts can share it without a circular import.
 */

/** Extract the leading tool name from a summary like "web_search: ...". */
export function extractToolName(summary: string): string {
  const match = summary.trim().match(/^([a-z0-9_-]+)\s*:/i)
  return match?.[1] ?? ''
}
