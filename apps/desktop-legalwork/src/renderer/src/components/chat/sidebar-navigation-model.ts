export type SidebarView =
  | 'chat'
  | 'dataCompliance'
  | 'desensitize'
  | 'claw'
  | 'schedule'
  | 'documentWriting'
  | 'legalResearch'
  | 'knowledgeBase'
  | 'learningIteration'

export type WorkspaceModeView = 'chat' | 'dataCompliance' | 'desensitize' | 'claw'

const AGENT_WORKSPACE_VIEWS = new Set<SidebarView>([
  'chat',
  'learningIteration',
  'documentWriting',
  'legalResearch',
  'knowledgeBase',
  'schedule'
])

export function isAgentWorkspaceView(view: SidebarView): boolean {
  return AGENT_WORKSPACE_VIEWS.has(view)
}

export function getWorkspaceModeView(view: SidebarView): WorkspaceModeView {
  if (view === 'dataCompliance' || view === 'desensitize' || view === 'claw') {
    return view
  }
  return 'chat'
}
