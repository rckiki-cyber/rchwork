import { describe, expect, it } from 'vitest'
import {
  documentFactVerificationInstruction,
  documentInvolvesLoanAmounts,
  loanAmountLedgerInstruction,
  validateLoanAmountDraft
} from './money-consistency'

describe('documentInvolvesLoanAmounts', () => {
  it('detects a loan-draft scenario combining lending facts with money figures', () => {
    expect(documentInvolvesLoanAmounts(
      '借条载明借款 330,000 元，约定月利率 3%；出借人转账 330,000 元后，借款人返还 30,000 元。要求生成民事起诉状。'
    )).toBe(true)
  })

  it('detects the scenario from pasted material text alone', () => {
    expect(documentInvolvesLoanAmounts(
      '材料：借款人出具借据，载明借款本金 200,000 元，已归还 80,000 元，尚欠 120,000 元。'
    )).toBe(true)
  })

  it('ignores documents that mention loans without money figures', () => {
    expect(documentInvolvesLoanAmounts(
      '请为借款纠纷生成答辩状，倾向认为借款已清偿。'
    )).toBe(false)
  })

  it('ignores unrelated legal documents even when amounts appear', () => {
    expect(documentInvolvesLoanAmounts(
      '交通事故责任纠纷，医疗费 50,000 元，主张赔偿。'
    )).toBe(false)
  })

  it('returns false for empty input', () => {
    expect(documentInvolvesLoanAmounts('')).toBe(false)
    expect(documentInvolvesLoanAmounts('   ')).toBe(false)
  })
})

describe('documentFactVerificationInstruction', () => {
  it('mandates a fact ledger and legal-norm verification, not a gate', () => {
    const instruction = documentFactVerificationInstruction()
    expect(instruction).toContain('<document_fact_verification>')
    expect(instruction).toContain('事实核验台账')
    expect(instruction).toContain('材料明确记载')
    expect(instruction).toContain('待核实')
    expect(instruction).toContain('元典（Yuandian）/北大法宝（PKULaw）')
    expect(instruction).toContain('依据未核验，提交前请核实')
    expect(instruction).toContain('不得把未经核验的规范写成确定依据')
    expect(instruction).toContain('不得编造条号、链接或来源')
    expect(instruction).toContain('不得使用“如核实…则调整为…”的条件式二选一')
    // Verification must not block delivery, but must never fake being verified.
    expect(instruction).toContain('核验不阻塞交付')
    expect(instruction).toContain('不得伪装成已核验')
  })
})

describe('loanAmountLedgerInstruction', () => {
  it('contains the statutory anchors and money-handling rules from the issue', () => {
    const instruction = loanAmountLedgerInstruction()
    expect(instruction).toContain('<loan_amount_ledger_advisory>')
    expect(instruction).toContain('同一笔款项只允许处理一次')
    expect(instruction).toContain('预先扣除的利息')
    expect(instruction).toContain('《中华人民共和国民法典》第六百七十条')
    expect(instruction).toContain('《最高人民法院关于审理民间借贷案件适用法律若干问题的规定》第二十七条')
    expect(instruction).toContain('《中华人民共和国民法典》第五百六十一条')
    expect(instruction).toContain('不得直接“本金－还款＝剩余本金”')
    expect(instruction).toContain('条件式二选一')
    expect(instruction).toContain('【待核实】')
    expect(instruction).toContain('不得再把同一笔款项从应付利息中重复扣除')
  })
})

describe('validateLoanAmountDraft', () => {
  it('flags a conditional either-or claim written into the formal 诉请', () => {
    expect(validateLoanAmountDraft(
      '诉讼请求：一、判令被告偿还本金 100,000 元；如核实实际归还 280,000 元，则调整为 20,000 元。'
    )).toEqual([
      expect.stringContaining('条件式二选一')
    ])
  })

  it('flags the exact wording from the issue report', () => {
    const issues = validateLoanAmountDraft(
      '偿还本金 100,000 元；如核实实际归还 280,000 元，则调整为 20,000 元。'
    )
    expect(issues.length).toBeGreaterThan(0)
  })

  it('accepts a clean definitive claim without a conditional branch', () => {
    expect(validateLoanAmountDraft(
      '诉讼请求：一、判令被告偿还借款本金 300,000 元及利息（以 300,000 元为基数，按年利率 15.4% 计算）。'
    )).toEqual([])
  })

  it('accepts an empty draft', () => {
    expect(validateLoanAmountDraft('')).toEqual([])
  })
})
