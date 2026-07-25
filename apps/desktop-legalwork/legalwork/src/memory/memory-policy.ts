import type {
  MemoryCaptureSource,
  MemoryCategory
} from '../contracts/memory.js'

export const AUTOMATIC_MEMORY_CONFIDENCE_THRESHOLD = 0.8

const AUTOMATIC_CATEGORIES = new Set<MemoryCategory>([
  'profile',
  'preference',
  'workflow',
  'project'
])

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
  /(?:api[_\s-]?key|token|client[_\s-]?secret|secret|password|passwd|密码|口令|密钥|秘钥|验证码|verification\s*code)\s*(?:[:=：]|是|为)\s*\S+/i,
  /\b(?:sk|pk|api)[-_][A-Za-z0-9]{16,}\b/i,
  /\bAKIA[A-Z0-9]{16}\b/
]

const SENSITIVE_PATTERNS = [
  /\b1[3-9]\d{9}\b/,
  /\b\d{16,19}\b/,
  /\b\d{17}[\dXx]\b/,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /(?:身份证|手机号|电话号码|银行卡|账号标识|账号|账户|用户名|住址|客户|当事人|证人|案号)/
]

export type MemoryPolicyDecision =
  | { status: 'allow' }
  | { status: 'confirmation_required'; reason: string }
  | { status: 'reject'; reason: string }

export class MemoryPolicyError extends Error {
  constructor(
    readonly code: 'confirmation_required' | 'secret_rejected',
    message: string
  ) {
    super(message)
    this.name = 'MemoryPolicyError'
  }
}

export function assessMemoryCapture(input: {
  content: string
  category: MemoryCategory
  confidence: number
  captureSource: MemoryCaptureSource
}): MemoryPolicyDecision {
  if (containsSecret(input.content)) {
    return {
      status: 'reject',
      reason: 'Secrets such as passwords, API keys, tokens, and verification codes cannot be stored in memory.'
    }
  }
  if (input.captureSource !== 'automatic') return { status: 'allow' }
  if (!AUTOMATIC_CATEGORIES.has(input.category)) {
    return {
      status: 'confirmation_required',
      reason: `Automatic capture is not allowed for memory category "${input.category}".`
    }
  }
  if (input.confidence < AUTOMATIC_MEMORY_CONFIDENCE_THRESHOLD) {
    return {
      status: 'confirmation_required',
      reason: `Memory confidence must be at least ${AUTOMATIC_MEMORY_CONFIDENCE_THRESHOLD} for automatic capture.`
    }
  }
  if (containsSensitiveIdentifier(input.content)) {
    return {
      status: 'confirmation_required',
      reason: 'This memory may contain client, matter, or account-identifying information.'
    }
  }
  return { status: 'allow' }
}

export function assertMemoryCaptureAllowed(input: {
  content: string
  category: MemoryCategory
  confidence: number
  captureSource: MemoryCaptureSource
}): void {
  const decision = assessMemoryCapture(input)
  if (decision.status === 'allow') return
  throw new MemoryPolicyError(
    decision.status === 'reject' ? 'secret_rejected' : 'confirmation_required',
    decision.reason
  )
}

export function assertMemoryContentHasNoSecrets(content: string): void {
  if (!containsSecret(content)) return
  throw new MemoryPolicyError(
    'secret_rejected',
    'Secrets such as passwords, API keys, tokens, and verification codes cannot be stored in memory.'
  )
}

export function normalizeMemoryText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function containsSecret(content: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(content))
}

export function containsSensitiveIdentifier(content: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))
}
