import { describe, expect, it } from 'vitest'
import {
  projectPickerMenuPosition,
  shouldDismissProjectPicker
} from './NewConversationProjectPicker'

describe('NewConversationProjectPicker helpers', () => {
  it('positions the portaled menu above the trigger and inside the viewport', () => {
    expect(projectPickerMenuPosition({ left: 300, top: 900 }, 1920, 1080)).toEqual({
      left: 300,
      bottom: 188,
      width: 420
    })
    expect(projectPickerMenuPosition({ left: 1800, top: 900 }, 1920, 1080).left).toBe(1476)
  })

  it('dismisses only when the pointer target is outside both trigger and menu', () => {
    const triggerTarget = {} as Node
    const menuTarget = {} as Node
    const outsideTarget = {} as Node
    const root = { contains: (target: Node) => target === triggerTarget }
    const menu = { contains: (target: Node) => target === menuTarget }

    expect(shouldDismissProjectPicker(triggerTarget, root, menu)).toBe(false)
    expect(shouldDismissProjectPicker(menuTarget, root, menu)).toBe(false)
    expect(shouldDismissProjectPicker(outsideTarget, root, menu)).toBe(true)
  })
})
