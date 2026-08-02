/**
 * Maps legalwork agent activity to thinking-orbs animation states.
 *
 * Six states ship with the `thinking-orbs` package:
 *   working   — particles on tilted orbits (default / busy)
 *   searching — a scan meridian sweeps a dotted globe (web/knowledge search)
 *   solving   — bands scramble, then click back (reasoning)
 *   listening — a waveform rolls through rings (waiting for user input)
 *   composing — an undulating sash (drafting / writing documents)
 *   shaping   — a dotted outline morphs (file_change / templating)
 *
 * This module is deliberately dependency-free (no React) so it can be unit
 * tested in isolation and reused by both the live-turn banner and per-block
 * icons.
 */

import type { ChatBlock, ToolItemKind } from '../../agent/types'
import { extractToolName } from './tool-summary'

export type OrbState = 'working' | 'searching' | 'solving' | 'listening' | 'composing' | 'shaping'

/** Tool names whose activity is best described as "searching". */
const SEARCH_NAMES = new Set([
  'web_search',
  'web_fetch',
  'knowledge_search',
  'knowledge_read_file',
  'search',
  'search_files',
  'grep',
  'grep_files',
  'find',
  'ls'
])

/** Tool names whose activity is best described as "composing" (drafting/writing). */
const COMPOSE_NAMES = new Set([
  'write',
  'write_file',
  'edit',
  'edit_file',
  'create_file',
  'apply_patch',
  'resolve_legal_document_template',
  'request_document_preferences'
])

export interface ResolveOrbStateInput {
  /** True while the agent turn is actively running. */
  busy: boolean
  /** Non-empty while reasoning deltas are streaming. */
  liveReasoning: string
  /** True when the agent is waiting for the user to answer a question. */
  waitingForUserInput: boolean
  /** The name of the tool currently running, if any. */
  activeToolName?: string
  /** The coarse tool category currently running, if any. */
  activeToolKind?: ToolItemKind
}

/**
 * Pick the orb state for a single tool block. The tool name is recovered from
 * the block summary (real-time stream blocks don't carry `meta.toolName`).
 */
export function orbStateForToolName(toolName: string, toolKind?: ToolItemKind): OrbState {
  if (SEARCH_NAMES.has(toolName)) return 'searching'
  if (COMPOSE_NAMES.has(toolName)) return 'composing'
  if (toolKind === 'file_change') return 'shaping'
  return 'working'
}

/**
 * Pick the orb state for a single chat block, or null when the block should
 * keep its existing lucide icon (e.g. inactive, error, non-process kinds).
 */
export function orbStateForBlock(block: ChatBlock): OrbState | null {
  if (block.kind === 'reasoning') return 'solving'
  if (block.kind === 'tool') {
    return orbStateForToolName(extractToolName(block.summary), block.toolKind)
  }
  return null
}

/**
 * Resolve the top-level orb state for the live-turn banner. Priority:
 *   listening (waiting for input) > specific active tool > reasoning > working.
 */
export function resolveOrbState(input: ResolveOrbStateInput): OrbState {
  if (input.waitingForUserInput) return 'listening'
  if (input.activeToolName || input.activeToolKind) {
    return orbStateForToolName(input.activeToolName ?? '', input.activeToolKind)
  }
  if (input.liveReasoning.trim()) return 'solving'
  return 'working'
}

/**
 * Find the first running tool block in a turn's process blocks and return the
 * orb state it maps to, or null when no tool is currently running.
 */
export function activeToolOrbState(processBlocks: ChatBlock[]): OrbState | null {
  for (const block of processBlocks) {
    if (block.kind === 'tool' && block.status === 'running') {
      return orbStateForBlock(block)
    }
  }
  return null
}
