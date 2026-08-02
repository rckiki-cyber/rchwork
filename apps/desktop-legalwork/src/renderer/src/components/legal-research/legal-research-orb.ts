/**
 * Maps legal-research activity to thinking-orbs states.
 *
 * The research flow is a segmented report stream (plan → per-stage updates →
 * final report) rather than a chat turn, so it maps stage text to orb states
 * instead of tool names. Mirrors the classification used by `iconForTool` in
 * useLegalResearch.ts so the icon and orb agree.
 */

import type { OrbState } from '../chat/orb-state'
import type { ResearchRecord, ResearchUpdate } from './useLegalResearch'

/** Classify a single research stage's text as searching / composing / working. */
export function orbStateForResearchText(text: string): OrbState {
  const lower = text.toLowerCase()
  if (
    lower.includes('synthesis') ||
    lower.includes('summar') ||
    lower.includes('总结') ||
    lower.includes('综述')
  ) {
    return 'composing'
  }
  if (
    lower.includes('search') ||
    lower.includes('搜索') ||
    lower.includes('web') ||
    lower.includes('fetch') ||
    lower.includes('提取') ||
    lower.includes('案例') ||
    lower.includes('判例') ||
    lower.includes('法规') ||
    lower.includes('条文')
  ) {
    return 'searching'
  }
  return 'working'
}

/**
 * Pick the orb state for the record header badge — a stable overview of the
 * overall research phase. Planning → solving, executing (any update streaming)
 * → working, report drafting → composing.
 */
export function orbStateForResearchPhase(record: ResearchRecord | null): OrbState {
  if (!record || record.status !== 'running') return 'working'
  if (record.updates.length === 0 && record.reasoning.trim()) return 'solving'
  return 'working'
}

/**
 * Pick the orb state for the live status strip — what the agent is doing this
 * instant. Follows the currently streaming update's text (searching/composing);
 * without one (planning / between steps) falls back to working.
 */
export function orbStateForResearchLive(record: ResearchRecord | null): OrbState {
  if (!record || record.status !== 'running') return 'working'
  const streaming = record.updates.find((u: ResearchUpdate) => u.completed !== true)
  if (streaming) return orbStateForResearchText(streaming.text)
  return 'working'
}
