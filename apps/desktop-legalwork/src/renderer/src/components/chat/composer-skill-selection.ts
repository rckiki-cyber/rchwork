export type ComposerSkillSelection = {
  id: string
  name: string
  description?: string
}

export function buildSelectedSkillPrompt(
  skill: ComposerSkillSelection | null | undefined,
  task: string
): string {
  const normalizedTask = task.trim()
  if (!skill?.id.trim()) return normalizedTask
  const command = `/skill:${skill.id.trim()}`
  return normalizedTask ? `${command} ${normalizedTask}` : command
}
