import { describe, expect, it } from 'vitest'
import {
  getWorkspaceModeView,
  isAgentWorkspaceView,
  type SidebarView
} from './sidebar-navigation-model'

describe('sidebar navigation model', () => {
  it.each<SidebarView>([
    'chat',
    'learningIteration',
    'documentWriting',
    'legalResearch',
    'knowledgeBase',
    'schedule'
  ])('keeps the Agent main navigation visible for %s', (view) => {
    expect(isAgentWorkspaceView(view)).toBe(true)
    expect(getWorkspaceModeView(view)).toBe('chat')
  })

  it.each<SidebarView>(['desensitize', 'dataCompliance', 'claw'])(
    'keeps %s in its own workspace mode',
    (view) => {
      expect(isAgentWorkspaceView(view)).toBe(false)
      expect(getWorkspaceModeView(view)).toBe(view)
    }
  )
})
