import { describe, expect, it } from 'vitest'
import { repairDispatchToolArguments } from './tool-call-repair.js'

describe('repairDispatchToolArguments bash session actions', () => {
  it.each(['poll', 'write', 'stop'])('preserves a valid %s call without inventing a command', (action) => {
    const raw = {
      action,
      session_id: 'bash_123',
      ...(action === 'write' ? { input: 'y\n' } : {})
    }

    expect(repairDispatchToolArguments(raw, { toolName: 'bash' })).toEqual({
      arguments: raw,
      notes: []
    })
  })

  it('still repairs a run call that omits command', () => {
    const result = repairDispatchToolArguments({ action: 'run' }, { toolName: 'bash' })
    expect(result.arguments.command).toContain('Invalid bash call')
    expect(result.notes).toHaveLength(1)
  })
})

describe('repairDispatchToolArguments legal template aliases', () => {
  it('maps the DeepSeek caseCause alias to the tool schema query field', () => {
    expect(repairDispatchToolArguments({
      documentType: '民事起诉状',
      caseCause: '买卖合同纠纷'
    }, { toolName: 'resolve_legal_document_template' })).toEqual({
      arguments: {
        documentType: '民事起诉状',
        query: '买卖合同纠纷'
      },
      notes: ['mapped legacy caseCause to query']
    })
  })
})
