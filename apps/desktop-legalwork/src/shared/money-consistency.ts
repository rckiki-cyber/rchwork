/**
 * Document correctness guards for legal document writing.
 *
 * Document generation must perform its own fact verification as part of the
 * drafting behaviour (not as a gated capability): legal norms must be checked
 * against authoritative sources or explicitly marked unverified, unresolved
 * factual conflicts must never be turned into definitive claims, and money
 * figures must be processed consistently. The helpers exported here cover two
 * layers:
 *
 *   1. Prompt mandates the model follows while drafting:
 *      - documentFactVerificationInstruction —— always injected, turns fact
 *        verification into a required workflow step for legal documents
 *        (fact ledger, legal-norm verification or "依据未核验", conflicts stay
 *        unresolved in the text);
 *      - loanAmountLedgerInstruction —— additionally injected when the case
 *        involves loan amounts, with the single-ledger / one-pass-per-payment /
 *        statutory-offset rules.
 *   2. A machine backstop on the finished draft:
 *      - validateLoanAmountDraft —— flags the concrete failure mode that would
 *        make a draft look submittable while being wrong (the
 *        "如核实…则调整为…" conditional either-or claim).
 *
 * The validator is deliberately narrow: it only flags patterns that are
 * unambiguously wrong, because flagging forces the document into a
 * "needs review" state instead of "done". Everything softer is handled at the
 * prompt level so correct drafts are never blocked.
 */

const LOAN_RELATIONSHIP = /(?:民间借贷|借款|借贷|出借|欠款|贷款|借条|借据)/
const LOAN_MONEY_TERMS = /(?:本金|利息|利率|月利率|年利率|还款|预扣|预先扣除|抵充|冲抵|欠付|归还|尚欠|已还|清偿|出借)/
const MONEY_FIGURE = /[¥￥]?\d[\d,，]*(?:\.\d+)?\s*(?:元|万|万元|块)/

/** True only when the text combines a lending relationship with money figures. */
export function documentInvolvesLoanAmounts(text: string): boolean {
  if (!text || typeof text !== 'string') return false
  const compact = text.replace(/\s+/g, '')
  return LOAN_RELATIONSHIP.test(compact) && LOAN_MONEY_TERMS.test(compact) && MONEY_FIGURE.test(compact)
}

/**
 * Fact-verification mandate for legal document writing, injected into every
 * document-writing prompt. This is what makes document generation actually
 * verify facts and legal norms as part of drafting: it is a workflow the model
 * follows, not a gate that turns verification on or off.
 */
export function documentFactVerificationInstruction(): string {
  return [
    '<document_fact_verification>',
    '本任务为法律文书写作。必须对正文中的事实与法律依据执行核验，并把核验状态体现在正文中：',
    '1. 事实核验台账：对每个关键事实（金额、日期、当事人、履行情况、争议焦点），区分「材料明确记载」「可由材料唯一推出」「待核实」三种状态；不要把所有材料信息都当成已核验事实。',
    '2. 法律依据核验：引用法条、司法解释或规范性文件前，应经元典（Yuandian）/北大法宝（PKULaw）检索核验其现行效力与准确条文；工具不可用、检索失败或核验未完成时，必须在正文对应位置标注「依据未核验，提交前请核实」，不得把未经核验的规范写成确定依据，也不得编造条号、链接或来源。',
    '3. 冲突事实：材料对同一关键事实存在实质冲突且无法确定时，正文不得写入确定结论，应列明具体冲突并标注【待核实】；不得使用“如核实…则调整为…”的条件式二选一。',
    '4. 核验不阻塞交付：核验未完成不影响交付正文，但所有未核验事项必须如实标注，不得伪装成已核验。',
    '</document_fact_verification>'
  ].join('\n')
}

/** Advisory block appended to the drafting prompt when loan amounts are involved. */
export function loanAmountLedgerInstruction(): string {
  return [
    '<loan_amount_ledger_advisory>',
    '本任务涉及借款金额与利息计算。必须按以下规则处理，防止生成看似可直接提交、但诉讼请求金额错误的文书：',
    '1. 建立“金额/现金流台账”，把材料中每一笔款项（借款本金、预扣利息、实际支付利息、本金还款、费用、违约金等）逐笔登记；同一笔款项只允许处理一次。',
    '2. 区分款项性质。若某笔款项被认定为“预先扣除的利息”，法律效果是借款本金按实际取得的金额认定并据此计算利息；不得再把同一笔款项从应付利息中重复扣除（《中华人民共和国民法典》第六百七十条、《最高人民法院关于审理民间借贷案件适用法律若干问题的规定》第二十七条）。',
    '3. 计算剩余本金前，必须先核实每笔还款的用途、双方约定与付款凭证备注；约定不明时按法定顺序抵充费用、利息、本金（《中华人民共和国民法典》第五百六十一条），不得直接“本金－还款＝剩余本金”。',
    '4. 材料对关键金额存在实质冲突且尚未解决时（例如还款金额两处记载不一致）：正式诉讼请求不得写入确定金额，也不得使用“如核实…则调整为…”的条件式二选一；应列明具体冲突、在对应位置标注【待核实】，并可另行提供分情形测算。',
    '5. 利率主张不得超过法定利率保护上限；引用法律条文须给出可核验来源（条号、链接或出处），无法核验时明确标注“无可核验链接/依据未核验”。',
    '</loan_amount_ledger_advisory>'
  ].join('\n')
}

/**
 * The one failure mode that is unambiguously detectable in finished prose:
 * a formal claim written as "如核实…则调整为…". This is the exact symptom of
 * an unresolved factual conflict leaking into a supposedly submittable claim.
 */
const CONDITIONAL_BINARY_CLAIM =
  /如.{0,16}(?:核实|查明|查实|确认).{0,40}(?:则调整|则改为|则变更为|调整为|改为|变更为|相应(?:调整|调减|调增|减少|增加))/
// 只有条件句前后涉及金额/诉讼请求时才判定为“金额冲突泄漏进诉请”，
// 避免“如查明被告下落不明，则改为公告送达”这类合法非金额条件句被误拦。
const CLAIM_MONEY_HINT =
  /(?:本金|利息|利率|数额|金额|款项|诉请|请求|标的|欠付|尚欠|[¥￥]?\d[\d,，]*(?:\.\d+)?\s*(?:元|万|万元|块))/

/** Returns human-readable problems found in a finished document draft. */
export function validateLoanAmountDraft(content: string): string[] {
  if (!content || typeof content !== 'string') return []
  const issues: string[] = []
  const match = content.match(CONDITIONAL_BINARY_CLAIM)
  if (match) {
    // 取条件句前后各 48 字符作为窗口，确认确实涉及金额/诉请而非普通条件表述
    const idx = match.index ?? 0
    const start = Math.max(0, idx - 48)
    const end = Math.min(content.length, idx + match[0].length + 48)
    const window = content.slice(start, end)
    if (CLAIM_MONEY_HINT.test(window)) {
      issues.push(
        '诉请出现了“如核实…则调整为…”的条件式二选一金额；事实核实前不应写入确定诉请，请列明冲突并标注待核实。'
      )
    }
  }
  return issues
}
