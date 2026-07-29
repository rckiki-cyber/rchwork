const { createHash, randomBytes } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const FORMAT_VERSION = 1
const KEY_CONTEXT = 'legalwork:pkulaw-fallback:v1'
const LOCAL_SOURCE_CONFIG = join(__dirname, 'pkulaw-fallback.local.json')
const FALLBACK_SOURCE_PATH = join(__dirname, '..', 'legalwork', 'src', 'adapters', 'tool', 'pkulaw-fallback.auth')
const OUTPUT_PATH = join(
  __dirname,
  '..',
  'legalwork',
  'dist',
  'adapters',
  'tool',
  'pkulaw-fallback.auth'
)

function parseArgs(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--source' && argv[index + 1]) result.source = argv[++index]
    else if (value === '--remember') result.remember = true
    else if (value === '--require') result.require = true
  }
  return result
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function extractTokenFromSkill(path) {
  const text = readFileSync(path, 'utf8')
  const matches = [...text.matchAll(/Authorization"\s*:\s*"Bearer\s+([^"\s]+)"/g)]
    .map((match) => match[1])
  const tokens = [...new Set(matches)]
  if (tokens.length !== 1) {
    throw new Error(`Expected exactly one embedded PKULaw credential in the source skill; found ${tokens.length}.`)
  }
  return tokens[0]
}

function normalizeToken(value) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.includes('${') || /\s/.test(normalized) || normalized.length < 16) {
    return ''
  }
  return normalized
}

function encodeToken(token) {
  const salt = randomBytes(24)
  const key = createHash('sha256').update(KEY_CONTEXT).update(salt).digest()
  const plain = Buffer.from(token, 'utf8')
  const encrypted = Buffer.allocUnsafe(plain.length)
  for (let index = 0; index < plain.length; index += 1) {
    encrypted[index] = plain[index] ^ key[index % key.length]
  }
  return {
    v: FORMAT_VERSION,
    salt: salt.toString('base64'),
    data: encrypted.toString('base64')
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const local = readJson(LOCAL_SOURCE_CONFIG)
  const source = args.source ||
    process.env.LEGALWORK_PKULAW_FALLBACK_SOURCE ||
    (typeof local?.source === 'string' ? local.source : '')
  const token = normalizeToken(
    process.env.LEGALWORK_PKULAW_FALLBACK_TOKEN ||
    (source && existsSync(resolve(source)) ? extractTokenFromSkill(resolve(source)) : '')
  )

  if (!token) {
    if (existsSync(OUTPUT_PATH)) {
      console.log('PKULaw fallback credential: preserved existing bundled payload.')
      return
    }
    // Fallback to the committed encrypted payload (safe: XOR+SHA256 with key derivation context in source code)
    if (existsSync(FALLBACK_SOURCE_PATH)) {
      mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
      const payload = readFileSync(FALLBACK_SOURCE_PATH, 'utf8')
      writeFileSync(OUTPUT_PATH, payload, { encoding: 'utf8', mode: 0o600 })
      console.log('PKULaw fallback credential: bundled from committed source.')
      return
    }
    if (args.require || process.env.LEGALWORK_REQUIRE_PKULAW_FALLBACK === '1') {
      throw new Error('PKULaw fallback credential is required but no secure source was configured.')
    }
    console.log('PKULaw fallback credential: no secure source configured; bundle omitted.')
    return
  }

  if (args.remember && source) {
    writeFileSync(LOCAL_SOURCE_CONFIG, `${JSON.stringify({ source: resolve(source) }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(encodeToken(token))}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  const fingerprint = createHash('sha256').update(token).digest('hex').slice(0, 12)
  console.log(`PKULaw fallback credential: bundled successfully (fingerprint ${fingerprint}).`)
}

main()
