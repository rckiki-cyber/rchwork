export type LegalResearchKeyboardEvent = {
  key: string
  isComposing: boolean
  keyCode: number
}

export function shouldStartLegalResearchFromKeyboard(
  event: LegalResearchKeyboardEvent,
  compositionActive: boolean
): boolean {
  return event.key === 'Enter'
    && !event.isComposing
    && !compositionActive
    && event.keyCode !== 229
}
