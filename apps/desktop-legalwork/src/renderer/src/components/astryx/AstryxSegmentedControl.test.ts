import { describe, expect, it, vi } from 'vitest'
import { dispatchSegmentSelection } from './AstryxSegmentedControl'

describe('dispatchSegmentSelection', () => {
  it('uses the reselect callback when the active segment is clicked again', () => {
    const onChange = vi.fn()
    const onReselect = vi.fn()

    dispatchSegmentSelection('chat', 'chat', onChange, onReselect)

    expect(onChange).not.toHaveBeenCalled()
    expect(onReselect).toHaveBeenCalledOnce()
    expect(onReselect).toHaveBeenCalledWith('chat')
  })

  it('uses the normal change callback for a different segment', () => {
    const onChange = vi.fn()
    const onReselect = vi.fn()

    dispatchSegmentSelection('chat', 'knowledgeBase', onChange, onReselect)

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('chat')
    expect(onReselect).not.toHaveBeenCalled()
  })
})
