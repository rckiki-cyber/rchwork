import { describe, expect, it } from 'vitest'
import { calculateModelListMenuPlacement } from './settings-model-list-picker'

describe('calculateModelListMenuPlacement', () => {
  it('opens below the trigger when there is enough viewport space', () => {
    expect(calculateModelListMenuPlacement({
      anchorRect: { top: 100, bottom: 140, left: 200, right: 600, width: 400 },
      estimatedHeight: 300,
      viewportHeight: 800,
      viewportWidth: 1200
    })).toEqual({
      left: 200,
      top: 148,
      width: 400,
      maxHeight: 300
    })
  })

  it('opens above the trigger when the following settings rows would be covered near the viewport edge', () => {
    expect(calculateModelListMenuPlacement({
      anchorRect: { top: 620, bottom: 660, left: 200, right: 600, width: 400 },
      estimatedHeight: 300,
      viewportHeight: 720,
      viewportWidth: 1200
    })).toEqual({
      left: 200,
      top: 312,
      width: 400,
      maxHeight: 300
    })
  })

  it('normalizes coordinates when the settings UI is zoomed', () => {
    expect(calculateModelListMenuPlacement({
      anchorRect: { top: 160, bottom: 224, left: 320, right: 960, width: 640 },
      estimatedHeight: 280,
      viewportHeight: 1280,
      viewportWidth: 1920,
      coordinateScale: 1.6
    })).toEqual({
      left: 200,
      top: 148,
      width: 400,
      maxHeight: 280
    })
  })
})
