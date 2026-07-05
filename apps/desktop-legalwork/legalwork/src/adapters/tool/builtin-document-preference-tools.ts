import { LocalToolHost } from './local-tool-host.js'
import type { UserInputQuestion } from '../../ports/user-input-gate.js'

export const REQUEST_DOCUMENT_PREFERENCES_TOOL_NAME = 'request_document_preferences'

export type DocumentType =
  | 'complaint'
  | 'answer'
  | 'agency_opinion'
  | 'legal_opinion'
  | 'lawyer_letter'
  | 'contract'
  | 'judgment'
  | 'unknown'

const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  complaint: '起诉状/仲裁申请书',
  answer: '答辩状/反诉状',
  agency_opinion: '代理词/辩护词',
  legal_opinion: '法律意见书/备忘录',
  lawyer_letter: '律师函/催告函',
  contract: '合同/协议',
  judgment: '判决书/裁定书',
  unknown: '法律文书'
}

function normalizeDocumentType(raw: unknown): DocumentType {
  const value = String(raw ?? '').toLowerCase().trim()
  if (value.includes('complaint') || value.includes('起诉') || value.includes('仲裁申请')) return 'complaint'
  if (value.includes('answer') || value.includes('答辩') || value.includes('反诉')) return 'answer'
  if (value.includes('agency') || value.includes('代理词') || value.includes('辩护词')) return 'agency_opinion'
  if (value.includes('opinion') || value.includes('memo') || value.includes('意见书') || value.includes('备忘录')) return 'legal_opinion'
  if (value.includes('letter') || value.includes('律师函') || value.includes('催告')) return 'lawyer_letter'
  if (value.includes('contract') || value.includes('合同') || value.includes('协议')) return 'contract'
  if (value.includes('judgment') || value.includes('判决') || value.includes('裁定')) return 'judgment'
  return 'unknown'
}

function makeQuestions(documentType: DocumentType): UserInputQuestion[] {
  switch (documentType) {
    case 'complaint':
      return [
        {
          header: '详细程度',
          id: 'verbosity',
          question: '您希望起诉状的详细程度如何?',
          options: [
            { label: '简要版', description: '核心事实+主要诉讼请求,适合简单案件快速立案' },
            { label: '标准版', description: '完整事实陈述、全部诉讼请求、主要法律依据' },
            { label: '详细版', description: '含完整证据清单、类案索引、详细法律论证' }
          ]
        },
        {
          header: '语气风格',
          id: 'tone',
          question: '您希望起诉状的语气风格如何?',
          options: [
            { label: '客观陈述', description: '平实叙述事实,不过度情绪化' },
            { label: '适度强调', description: '在关键事实和法律点上适度强调我方立场' },
            { label: '强硬主张', description: '明确有力地主张权利,强调对方违约/侵权严重性' }
          ]
        },
        {
          header: '证据呈现',
          id: 'evidence',
          question: '证据清单的呈现方式?',
          options: [
            { label: '仅列名称', description: '仅列出证据名称和份数' },
            { label: '附简要说明', description: '列明证据名称+简要证明目的' },
            { label: '附详细说明', description: '列明证据名称+详细证明目的+页码标注' }
          ]
        }
      ]
    case 'answer':
      return [
        {
          header: '防御强度',
          id: 'defense_intensity',
          question: '您希望答辩状的防御强度如何?',
          options: [
            { label: '温和回应', description: '承认部分事实,软化争议,保留协商空间' },
            { label: '标准抗辩', description: '逐项反驳对方主张,提出我方事实和法律依据' },
            { label: '强硬反击', description: '全面否认对方主张,并为反诉做准备' }
          ]
        },
        {
          header: '反诉意向',
          id: 'counterclaim',
          question: '是否需要在答辩中处理反诉?',
          options: [
            { label: '不提反诉', description: '仅针对原告诉求进行答辩' },
            { label: '保留反诉权利', description: '在答辩中声明保留另行提起反诉的权利' },
            { label: '明确提出反诉', description: '在答辩状中直接提出反诉请求' }
          ]
        },
        {
          header: '焦点策略',
          id: 'focus_strategy',
          question: '您希望聚焦的答辩策略?',
          options: [
            { label: '聚焦程序瑕疵', description: '重点指出管辖、主体、诉讼时效等程序问题' },
            { label: '聚焦实体反驳', description: '重点针对事实认定和法律适用进行实体反驳' },
            { label: '双轨并行', description: '程序和实体问题同时展开' }
          ]
        }
      ]
    case 'agency_opinion':
      return [
        {
          header: '论证深度',
          id: 'depth',
          question: '代理词的论证深度?',
          options: [
            { label: '简明扼要', description: '庭审口头补充用,抓重点' },
            { label: '标准书面代理词', description: '完整论证,适合提交法庭' },
            { label: '深度学术论证', description: '结合理论、学说、比较法进行深度论证' }
          ]
        },
        {
          header: '案例引用',
          id: 'case_citation',
          question: '案例引用策略?',
          options: [
            { label: '不引用案例', description: '仅依靠法律条文和事实论证' },
            { label: '引用指导性案例', description: '引用最高人民法院指导性案例' },
            { label: '类案+学术观点', description: '引用类案、学术观点和权威学说' }
          ]
        },
        {
          header: '价值衡量',
          id: 'value_balance',
          question: '除法律技术外,是否需要兼顾其他价值?',
          options: [
            { label: '仅法律技术分析', description: '聚焦法律要件和证据分析' },
            { label: '兼顾商业利益', description: '在分析中考虑商业影响和交易背景' },
            { label: '兼顾社会影响', description: '适当考虑裁判的社会效果和公共利益' }
          ]
        }
      ]
    case 'legal_opinion':
      return [
        {
          header: '受众对象',
          id: 'audience',
          question: '这份法律意见书/备忘录的主要受众是谁?',
          options: [
            { label: '内部法务', description: '专业术语,无需解释基础概念' },
            { label: '业务团队', description: '简化法律分析,突出商业影响和可操作性' },
            { label: '高管', description: '结论优先,极简分析,突出决策要点' },
            { label: '外部监管', description: '合规导向,引用规范和标准' }
          ]
        },
        {
          header: '分析深度',
          id: 'depth',
          question: '分析深度要求?',
          options: [
            { label: '结论优先', description: '1-2页,直接回答核心问题' },
            { label: '标准分析', description: '5-10页,含背景+分析+结论' },
            { label: '深度研究', description: '含比较法、立法沿革、全面类案检索' }
          ]
        },
        {
          header: '案例引用',
          id: 'case_citation',
          question: '是否需要引用案例?',
          options: [
            { label: '不引用案例', description: '仅依靠法律条文分析' },
            { label: '引用关键案例', description: '引用指导性案例或关键类案' },
            { label: '全面类案检索', description: '进行较全面的类案检索并引用' }
          ]
        },
        {
          header: '行文形式',
          id: 'format',
          question: '行文形式偏好?',
          options: [
            { label: '严格段落', description: '以段落形式行文,避免过多列表' },
            { label: '允许适度结构化', description: '在保持段落为主的前提下允许层级标题和少量列表' }
          ]
        }
      ]
    case 'lawyer_letter':
      return [
        {
          header: '紧迫程度',
          id: 'urgency',
          question: '律师函的紧迫程度?',
          options: [
            { label: '友好协商', description: '30日回复期,语气平和,强调协商解决' },
            { label: '正式催告', description: '15日回复期,语气正式,明确法律后果' },
            { label: '最后通牒', description: '7日回复期,语气强硬,明确将采取诉讼/仲裁' }
          ]
        },
        {
          header: '后果声明',
          id: 'consequence',
          question: '后果声明的强度?',
          options: [
            { label: '温和提示法律风险', description: '提示对方可能面临的法律风险' },
            { label: '明确声明将采取诉讼/仲裁', description: '明确告知逾期不回复将提起诉讼或仲裁' },
            { label: '全面声明', description: '声明将采取诉讼、保全、执行等全部措施' }
          ]
        },
        {
          header: '和解空间',
          id: 'settlement',
          question: '是否保留和解空间?',
          options: [
            { label: '保留协商空间', description: '在函件中表达愿意协商解决' },
            { label: '附条件和解方案', description: '提出具体和解条件' },
            { label: '不提及和解', description: '仅要求对方履行义务' }
          ]
        }
      ]
    case 'contract':
      return [
        {
          header: '风险倾向',
          id: 'risk_tendency',
          question: '合同条款的风险倾向?',
          options: [
            { label: '平衡双方利益', description: '权利义务相对平衡,适合长期合作' },
            { label: '偏向我方保护', description: '在关键条款上偏向保护我方利益' },
            { label: '最大化我方权益', description: '尽可能争取对我方最有利的条款' }
          ]
        },
        {
          header: '条款密度',
          id: 'density',
          question: '合同条款的详细程度?',
          options: [
            { label: '框架协议', description: '主要条款+原则性约定' },
            { label: '标准详细合同', description: '完整条款,适合一般交易' },
            { label: '超详细', description: '含定义、陈述保证、交割条件等详细条款' }
          ]
        },
        {
          header: '争议解决',
          id: 'dispute_resolution',
          question: '争议解决方式?',
          options: [
            { label: '诉讼', description: '约定由我方所在地法院管辖' },
            { label: '仲裁', description: '约定明确仲裁机构' },
            { label: '先调解后诉讼', description: '约定先协商调解,不成再诉讼' }
          ]
        }
      ]
    case 'judgment':
      return [
        {
          header: '说理详略',
          id: 'reasoning',
          question: '裁判文书的说理详略?',
          options: [
            { label: '简明', description: '争议不大案件,简要说理' },
            { label: '标准', description: '常规说理,覆盖主要争点' },
            { label: '充分', description: '疑难复杂案件,详细论证' }
          ]
        },
        {
          header: '案例引用',
          id: 'case_citation',
          question: '案例引用密度?',
          options: [
            { label: '不引用', description: '仅依据法律条文裁判' },
            { label: '指导性案例', description: '引用关键指导性案例' },
            { label: '全面引用', description: '全面引用类案支持裁判' }
          ]
        },
        {
          header: '格式严格度',
          id: 'formality',
          question: '格式严格度?',
          options: [
            { label: '严格法定', description: '严格遵循法院文书样式' },
            { label: '教学演示', description: '可适当标注说明,用于学习展示' }
          ]
        }
      ]
    case 'unknown':
    default:
      return [
        {
          header: '详细程度',
          id: 'verbosity',
          question: '您希望文书的详细程度如何?',
          options: [
            { label: '简要版', description: '抓住核心,简明扼要' },
            { label: '标准版', description: '结构完整,论述充分' },
            { label: '详细版', description: '内容详尽,论据完整' }
          ]
        },
        {
          header: '语气风格',
          id: 'tone',
          question: '您希望文书的语气风格如何?',
          options: [
            { label: '客观平实', description: '平实叙述,避免过度渲染' },
            { label: '适度强调', description: '在关键点上强调立场' },
            { label: '明确有力', description: '清晰有力地表达主张' }
          ]
        },
        {
          header: '受众对象',
          id: 'audience',
          question: '文书主要面向谁?',
          options: [
            { label: '专业人士', description: '使用专业术语,分析深入' },
            { label: '业务方/客户', description: '通俗易懂,突出要点' },
            { label: '司法机关', description: '规范严谨,符合提交要求' }
          ]
        }
      ]
  }
}

export function createRequestDocumentPreferencesTool(): ReturnType<typeof LocalToolHost.defineTool> {
  return LocalToolHost.defineTool({
    name: REQUEST_DOCUMENT_PREFERENCES_TOOL_NAME,
    description:
      'Request document drafting preferences from the user before generating a legal document. ' +
      'Given a document type (complaint, answer, agency_opinion, legal_opinion, lawyer_letter, contract, judgment) ' +
      'and an optional case summary, this tool presents document-type-specific preference questions ' +
      'and returns the user\'s selections. Always call this tool before drafting any legal document ' +
      'when a document-drafting skill is active.',
    toolKind: 'tool_call',
    inputSchema: {
      type: 'object',
      properties: {
        documentType: {
          type: 'string',
          description:
            'Type of legal document to draft. Use one of: complaint, answer, agency_opinion, legal_opinion, ' +
            'lawyer_letter, contract, judgment. Use "unknown" if uncertain.'
        },
        caseSummary: {
          type: 'string',
          description: 'Optional brief summary of the case or document context, used to personalize the prompt.'
        }
      },
      required: ['documentType'],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => {
      if (!context.awaitUserInput) {
        return {
          output: { error: 'GUI user input is not available in this runtime context' },
          isError: true
        }
      }
      const documentType = normalizeDocumentType(args.documentType)
      const questions = makeQuestions(documentType)
      const label = DOCUMENT_TYPE_LABELS[documentType]
      const caseSummary = args.caseSummary ? String(args.caseSummary).slice(0, 200) : ''
      const prompt = caseSummary
        ? `请确认 ${label} 的生成偏好(案情:${caseSummary})`
        : `请确认 ${label} 的生成偏好`
      const inputId = `docpref_${Math.random().toString(36).slice(2, 10)}`
      const itemId = `item_${inputId}`
      const resolution = await context.awaitUserInput({ id: inputId, itemId, prompt, questions })
      return {
        output: {
          documentType,
          label,
          resolution
        },
        isError: resolution.status === 'cancelled'
      }
    }
  })
}
