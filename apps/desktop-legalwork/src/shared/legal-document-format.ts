/**
 * Chinese legal-document structure rules shared by generation, preview and export.
 *
 * Markdown is only the storage syntax. The generated text must still follow the
 * conventional structure of the selected legal document instead of looking like
 * a generic web article.
 */

export type LegalDocumentArchetype =
  | 'court-pleading'
  | 'court-application'
  | 'law-firm-opinion'
  | 'lawyer-letter'
  | 'contract'
  | 'corporate-resolution'
  | 'corporate-governance'
  | 'authorization'
  | 'personal-instrument'
  | 'arbitration'

export type LegalDocumentFormatSpec = {
  archetype: LegalDocumentArchetype
  label: string
  requiredOrder: string[]
  numberingRule: string
  markdownRule: string
  closingRule: string
}

const ARCHETYPE_BY_TEMPLATE_ID: Record<string, LegalDocumentArchetype> = {
  'civil-complaint': 'court-pleading',
  'civil-defense': 'court-pleading',
  'civil-appeal': 'court-pleading',
  'civil-counterclaim': 'court-pleading',
  'criminal-private-prosecution': 'court-pleading',
  'criminal-incidental-civil': 'court-pleading',
  'criminal-appeal': 'court-pleading',
  'criminal-petition': 'court-pleading',
  'admin-complaint': 'court-pleading',
  'admin-defense': 'court-pleading',
  'admin-appeal': 'court-pleading',
  'civil-retrial': 'court-application',
  'civil-enforcement': 'court-application',
  'property-preservation': 'court-application',
  'evidence-preservation': 'court-application',
  'preliminary-execution': 'court-application',
  'jurisdiction-objection': 'court-application',
  'admin-petition': 'court-application',
  'state-compensation': 'court-application',
  'withdraw-complaint': 'court-application',
  'legal-opinion': 'law-firm-opinion',
  'due-diligence-report': 'law-firm-opinion',
  'lawyer-letter': 'lawyer-letter',
  'sales-contract': 'contract',
  'lease-contract': 'contract',
  'loan-contract': 'contract',
  'labor-contract': 'contract',
  'equity-transfer': 'contract',
  'partnership-agreement': 'contract',
  nda: 'contract',
  'non-compete': 'contract',
  'gift-contract': 'contract',
  'settlement-agreement': 'contract',
  'shareholders-resolution': 'corporate-resolution',
  'board-resolution': 'corporate-resolution',
  'company-articles': 'corporate-governance',
  'power-of-attorney': 'authorization',
  'divorce-agreement': 'personal-instrument',
  will: 'personal-instrument',
  'arbitration-application': 'arbitration'
}

const SPECS: Record<LegalDocumentArchetype, LegalDocumentFormatSpec> = {
  'court-pleading': {
    archetype: 'court-pleading',
    label: '诉讼文书',
    requiredOrder: ['居中标题', '当事人及诉讼地位', '案由或引言', '诉讼请求/答辩意见', '事实与理由', '证据和附件（如有）', '受文法院', '具状人及日期'],
    numberingRule: '请求事项可用“1.、2.、3.”逐项列明；事实与理由的层级依次使用“一、”“（一）”“1.”“（1）”，不得把连续叙事事实机械拆成西式编号列表。',
    markdownRule: '# 只用于文书标题；## 对应“一、”级标题；### 对应“（一）”级标题。不要使用 Markdown 自动有序列表表达普通正文。',
    closingRule: '结尾使用“此致”另起一行，受文法院另起一行；具状人/答辩人和日期置于文末右侧落款区。'
  },
  'court-application': {
    archetype: 'court-application',
    label: '司法申请书',
    requiredOrder: ['居中标题', '申请人与被申请人信息', '申请事项', '事实与理由', '法律依据（融入说理，必要时单列）', '受文机关', '申请人及日期', '附件（如有）'],
    numberingRule: '申请事项可逐项编号；论证层级依次使用“一、”“（一）”“1.”“（1）”，事实经过以自然段为主。',
    markdownRule: '# 只用于文书标题；##/### 仅表示规范中文层级标题，禁止网页式分隔线和装饰性引用框。',
    closingRule: '使用“此致”及受文机关，申请人和日期置于文末右侧；附件置于落款之后。'
  },
  'law-firm-opinion': {
    archetype: 'law-firm-opinion',
    label: '律师事务所专业文书',
    requiredOrder: ['居中标题', '编号（有则保留）', '致送对象', '事项/主题', '释义、依据与声明', '基本事实', '法律分析', '结论性意见', '风险提示或保留事项', '事务所、经办律师及日期'],
    numberingRule: '一级论证使用“一、二、三”；二级使用“（一）（二）”；三级使用“1.、2.”。基本事实以连贯自然段或按争点分层，不得把每句话拆成 1—N 列表。',
    markdownRule: '# 只用于“法律意见书/尽职调查报告”标题；## 对应“一、”；### 对应“（一）”。“致：”“关于：”为无缩进的题注段，不使用列表。',
    closingRule: '结尾由律师事务所名称、经办律师、日期组成右侧落款；保留事项应在结论之后、落款之前。'
  },
  'lawyer-letter': {
    archetype: 'lawyer-letter',
    label: '律师函',
    requiredOrder: ['律师函标题及编号', '致送对象', '委托及事项说明', '事实陈述', '法律评价', '正式函告事项及履行期限', '逾期后果', '事务所、律师及日期'],
    numberingRule: '函告事项可逐项编号；事实与法律评价使用“一、”“（一）”层级，不作流水账式编号。',
    markdownRule: '# 只用于标题；致送对象和开头称谓用普通段落；不得使用网页式横线、引用框或项目符号装饰。',
    closingRule: '结尾使用正式结束语，事务所、律师和日期置于右侧落款区。'
  },
  contract: {
    archetype: 'contract',
    label: '合同/协议',
    requiredOrder: ['居中合同名称', '合同编号与签订地（如有）', '各方主体信息', '鉴于/订立目的', '定义（需要时）', '实体权利义务条款', '违约责任', '解除终止', '争议解决', '生效及其他', '签署页'],
    numberingRule: '合同正文使用“第一条、第二条……”；条内依次使用“1.1”“1.1.1”，或统一使用“（一）”“1.”，全文只能选择一套体系并保持连续。',
    markdownRule: '# 只用于合同名称；## 对应“第一条”条款；### 对应条内分项。主体信息和签署栏不得写成 Markdown 列表。',
    closingRule: '签署页区分各方名称、法定代表人/授权代表、签署日期；不要用“此致”。'
  },
  'corporate-resolution': {
    archetype: 'corporate-resolution',
    label: '公司决议',
    requiredOrder: ['公司名称及会议决议标题', '会议时间地点与召集主持', '出席及表决权情况', '程序合法性说明', '逐项审议事项与表决结果', '签字/盖章及日期'],
    numberingRule: '决议事项使用“一、二、三”或“议案一、议案二”；每项必须写明表决结果，不使用普通有序列表代替决议层级。',
    markdownRule: '# 只用于决议标题；## 用于各项议案/决议事项；会议基本信息用普通段落。',
    closingRule: '股东/董事签字或盖章及日期置于文末，不使用“此致”。'
  },
  'corporate-governance': {
    archetype: 'corporate-governance',
    label: '公司治理文件',
    requiredOrder: ['文件名称', '总则', '公司基本事项', '股东与出资', '组织机构及职权', '财务会计', '合并分立解散清算', '附则', '股东签署及日期'],
    numberingRule: '章程使用“第一章/第二章”和“第一条/第二条”的章—条体系，条文连续编号，不使用 Markdown 自动列表充当条款。',
    markdownRule: '# 只用于文件名称；## 对应“第一章”；### 不得替代条文，条文以“第一条”开头的普通段落书写。',
    closingRule: '全体股东签署/盖章和日期置于文末。'
  },
  authorization: {
    archetype: 'authorization',
    label: '授权委托书',
    requiredOrder: ['居中标题', '委托人与受托人身份信息', '委托事项', '权限范围', '授权期限', '是否可转委托', '委托人签章及日期'],
    numberingRule: '权限较多时可逐项列明；全文以短段落为主，不人为设置多级章节。',
    markdownRule: '# 只用于标题；通常不使用 ##/###，不得套用诉讼文书“事实与理由”结构。',
    closingRule: '委托人签字/盖章及日期置于右侧；需要受托人签字时单列。'
  },
  'personal-instrument': {
    archetype: 'personal-instrument',
    label: '身份/家事法律文书',
    requiredOrder: ['居中标题', '各方/立文人身份信息', '意思表示与事实基础', '财产、人身或继承安排', '债务与违约/执行安排', '生效与份数', '签名、见证及日期'],
    numberingRule: '协议类使用“第一条”条款体系；遗嘱使用“一、二、三”处分事项。根据文种选择其一，不混用。',
    markdownRule: '# 只用于标题；## 对应条款或处分事项；身份信息用普通段落。',
    closingRule: '本人/双方签名、见证人和日期按文种完整列明，不使用“此致”。'
  },
  arbitration: {
    archetype: 'arbitration',
    label: '仲裁申请书',
    requiredOrder: ['居中标题', '申请人与被申请人信息', '仲裁请求', '事实与理由', '仲裁协议及管辖依据', '证据和附件', '仲裁委员会', '申请人及日期'],
    numberingRule: '仲裁请求逐项编号；论证层级使用“一、”“（一）”“1.”，普通事实以自然段表述。',
    markdownRule: '# 只用于标题；##/### 对应中文层级；不得用网页式项目符号代替请求或说理。',
    closingRule: '使用“此致”及仲裁委员会，申请人和日期置于右侧。'
  }
}

function inferArchetype(templateName: string): LegalDocumentArchetype {
  if (/律师函/.test(templateName)) return 'lawyer-letter'
  if (/法律意见|尽职调查/.test(templateName)) return 'law-firm-opinion'
  if (/合同|协议/.test(templateName)) return 'contract'
  if (/章程/.test(templateName)) return 'corporate-governance'
  if (/决议/.test(templateName)) return 'corporate-resolution'
  if (/授权委托/.test(templateName)) return 'authorization'
  if (/仲裁/.test(templateName)) return 'arbitration'
  if (/申请书|异议/.test(templateName)) return 'court-application'
  return 'court-pleading'
}

export function getLegalDocumentFormatSpec(
  templateId: string | undefined,
  templateName: string
): LegalDocumentFormatSpec {
  const archetype = (templateId && ARCHETYPE_BY_TEMPLATE_ID[templateId]) || inferArchetype(templateName)
  return SPECS[archetype]
}

export function legalDocumentFormatInstruction(
  templateId: string | undefined,
  templateName: string
): string {
  const spec = getLegalDocumentFormatSpec(templateId, templateName)
  return [
    `文书体例：${spec.label}`,
    `固定结构顺序：${spec.requiredOrder.join(' → ')}`,
    `编号规则：${spec.numberingRule}`,
    `Markdown 规则：${spec.markdownRule}`,
    `结尾与落款：${spec.closingRule}`
  ].join('\n')
}

export const BUILT_IN_LEGAL_DOCUMENT_FORMAT_IDS = Object.freeze(
  Object.keys(ARCHETYPE_BY_TEMPLATE_ID)
)
