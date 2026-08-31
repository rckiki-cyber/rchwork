/**
 * Download sources for the data-compliance / 脱敏 Python environment.
 *
 * That environment is installed at runtime rather than shipped in the
 * installer: a standalone CPython build plus a few hundred MB of wheels
 * (paddlepaddle, paddleocr, PyMuPDF…). Both used to be fetched only from their
 * upstream homes — GitHub Releases and pypi.org — which are slow or plainly
 * unreachable for most mainland-China users, and that is the single most
 * common cause of the "环境安装失败" reports.
 *
 * So we try domestic mirrors first and keep upstream as the last candidate,
 * which keeps users outside China (and anyone whose network blocks the
 * mirrors) working. Callers are expected to walk the whole list and stop at
 * the first source that succeeds.
 *
 * This module stays free of node builtins: it is shared with the embedded
 * legalwork server and must remain importable from any bundle.
 */

const PIP_INDEX_MIRRORS = [
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.org/simple'
]

/** Label used for the candidate that lets pip resolve its own index. */
const PIP_DEFAULT_CONFIG_LABEL = 'pip 自身配置'

export interface PipIndexCandidate {
  /**
   * Index to pass via `-i`, or null to run pip with no index argument at all
   * so that the user's own `pip.conf` / `PIP_INDEX_URL` still applies.
   */
  indexUrl: string | null
  /** Human-readable source name for progress and error messages. */
  label: string
  /**
   * Whether pip may skip TLS verification for this host. Only ever true for an
   * index the user pointed us at explicitly (an internal mirror may serve
   * plain HTTP or a private CA); never for our own mirror list or pypi.org,
   * where disabling verification would weaken an already hash-less install.
   */
  trustedHost: boolean
}

function hasUserPipConfiguration(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    (env.PIP_INDEX_URL || '').trim() ||
      (env.PIP_EXTRA_INDEX_URL || '').trim() ||
      (env.PIP_CONFIG_FILE || '').trim()
  )
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * Indexes to try, in order. `LEGALWORK_PIP_INDEX_URL` takes first place but no
 * longer suppresses the fallbacks, so a stale override cannot strand the
 * install.
 *
 * A candidate that runs pip with no `-i` at all is always included so that a
 * user whose `pip.conf` points at an internal index can still install: it goes
 * first when the environment shows pip is configured, and last otherwise (by
 * then pip's own default, pypi.org, has already been tried by name).
 */
export function resolvePipIndexCandidates(env: NodeJS.ProcessEnv = process.env): PipIndexCandidate[] {
  const override = (env.LEGALWORK_PIP_INDEX_URL || '').trim()
  const candidates: PipIndexCandidate[] = []
  const seen = new Set<string>()

  const pushUrl = (url: string, trustedHost: boolean): void => {
    const hostname = hostnameOf(url)
    if (!hostname) return
    const key = url.replace(/\/+$/, '')
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ indexUrl: url, label: hostname, trustedHost })
  }

  if (override) pushUrl(override, true)

  const pipConfigCandidate: PipIndexCandidate = {
    indexUrl: null,
    label: PIP_DEFAULT_CONFIG_LABEL,
    trustedHost: false
  }
  if (hasUserPipConfiguration(env)) candidates.push(pipConfigCandidate)

  for (const mirror of PIP_INDEX_MIRRORS) pushUrl(mirror, false)

  if (!hasUserPipConfiguration(env)) candidates.push(pipConfigCandidate)

  return candidates
}

/** pip arguments selecting a specific index. Empty for the pip-config candidate. */
export function pipIndexArgs(candidate: PipIndexCandidate): string[] {
  if (!candidate.indexUrl) return []
  const args = ['-i', candidate.indexUrl]
  if (candidate.trustedHost) {
    const hostname = hostnameOf(candidate.indexUrl)
    if (hostname) args.push('--trusted-host', hostname)
  }
  return args
}

/** "清华、阿里云…" style list for progress and error messages. */
export function describePipIndexes(candidates: PipIndexCandidate[]): string {
  return candidates.map((candidate) => candidate.label).join('、')
}

export const PIP_INDEX_PROBE_TIMEOUT_MS = 5_000

type FetchLike = (input: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  body?: { cancel: () => Promise<void> | void } | null
}>

/**
 * Cheap reachability check for one index: fetch a small, always-present
 * project page and give up after a few seconds. This is what separates "the
 * mirror is dead" from "the mirror is slow" — without it, every unreachable
 * index costs a full pip timeout.
 */
export async function probePipIndex(
  indexUrl: string,
  timeoutMs: number = PIP_INDEX_PROBE_TIMEOUT_MS,
  fetchImpl?: FetchLike
): Promise<boolean> {
  const doFetch = (fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined)) || null
  if (!doFetch) return true
  const probeUrl = `${indexUrl.replace(/\/+$/, '')}/pip/`
  try {
    const response = await doFetch(probeUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    })
    // Headers are all we need; drop the body so the socket closes right away.
    try {
      await response.body?.cancel()
    } catch {
      // ignore
    }
    return response.ok || response.status === 403
  } catch {
    return false
  }
}

/**
 * Drop candidates whose host does not answer, keeping the original priority
 * order. The pip-config candidate has no URL to probe and is always kept.
 *
 * When no public index answers at all, the machine is most likely isolated
 * (an intranet workstation), where the user's own `pip.conf` is the only thing
 * that can possibly work — so it is hoisted to the front instead of sitting
 * past the attempt cap. The unreachable indexes are kept behind it rather than
 * dropped, because a proxy that refuses our probe may still let pip through.
 */
export async function selectReachablePipIndexes(
  candidates: PipIndexCandidate[],
  timeoutMs: number = PIP_INDEX_PROBE_TIMEOUT_MS,
  fetchImpl?: FetchLike
): Promise<PipIndexCandidate[]> {
  const reachability = await Promise.all(
    candidates.map(async (candidate) =>
      candidate.indexUrl ? probePipIndex(candidate.indexUrl, timeoutMs, fetchImpl) : true
    )
  )
  const reachable = candidates.filter((_, index) => reachability[index])
  if (reachable.some((candidate) => candidate.indexUrl)) return reachable
  return [
    ...candidates.filter((candidate) => !candidate.indexUrl),
    ...candidates.filter((candidate) => candidate.indexUrl)
  ]
}

/**
 * How many indexes we actually hand to pip. Each attempt carries a ~15 minute
 * timeout, so this is the knob that bounds the worst-case wait; probing above
 * means the attempts we do spend land on hosts that answered.
 */
export const MAX_PIP_INSTALL_ATTEMPTS = 2

export interface PipInstallRunOutcome<T> {
  /** Result of the last attempt, or null when no attempt ran. */
  result: T | null
  /** Candidate that succeeded, or null when all attempts failed. */
  succeededWith: PipIndexCandidate | null
  /** Candidates actually handed to pip, for the failure message. */
  attempted: PipIndexCandidate[]
}

/**
 * Walk the candidates in order until one install succeeds. Shared by the
 * desktop IPC installer and the embedded legalwork service so the retry policy
 * lives in exactly one place.
 */
export async function runPipInstallWithFallback<T>(options: {
  candidates: PipIndexCandidate[]
  attempt: (candidate: PipIndexCandidate) => Promise<T>
  succeeded: (result: T) => boolean
  onSwitch?: (next: PipIndexCandidate) => void
  maxAttempts?: number
}): Promise<PipInstallRunOutcome<T>> {
  const limit = Math.max(1, options.maxAttempts ?? MAX_PIP_INSTALL_ATTEMPTS)
  const attempted = options.candidates.slice(0, limit)
  let result: T | null = null

  for (const [index, candidate] of attempted.entries()) {
    if (index > 0) options.onSwitch?.(candidate)
    result = await options.attempt(candidate)
    if (options.succeeded(result)) {
      return { result, succeededWith: candidate, attempted }
    }
  }

  return { result, succeededWith: null, attempted }
}

const PYTHON_STANDALONE_RELEASE_TAG = '20240415'
const PYTHON_STANDALONE_VERSION = '3.11.9'

const PYTHON_STANDALONE_TARGETS: Record<string, Record<string, string>> = {
  darwin: { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' },
  linux: { arm64: 'aarch64-unknown-linux-gnu', x64: 'x86_64-unknown-linux-gnu' },
  // python-build-standalone ships only x86_64 Windows builds for this release
  // tag; arm64 Windows runs the x64 build transparently via emulation.
  win32: { arm64: 'x86_64-pc-windows-msvc', x64: 'x86_64-pc-windows-msvc' }
}

/**
 * Standalone CPython tarball URLs to try, in order. Empty when the platform
 * has no published build.
 */
export function resolvePythonStandaloneUrls(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const target = PYTHON_STANDALONE_TARGETS[platform]?.[arch === 'arm64' ? 'arm64' : 'x64']
  if (!target) return []

  const fileName = `cpython-${PYTHON_STANDALONE_VERSION}+${PYTHON_STANDALONE_RELEASE_TAG}-${target}-install_only.tar.gz`
  const upstream = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_RELEASE_TAG}/${fileName}`
  // npmmirror mirrors python-build-standalone byte for byte and is reachable
  // from mainland China. The '+' in the file name must be percent-encoded
  // there, unlike on GitHub.
  const npmmirror =
    'https://registry.npmmirror.com/-/binary/python-build-standalone/' +
    `${PYTHON_STANDALONE_RELEASE_TAG}/${fileName.replace('+', '%2B')}`

  const urls: string[] = []
  const mirrorPrefix = (env.LEGALWORK_PYTHON_MIRROR_PREFIX || '').trim()
  if (mirrorPrefix) urls.push(`${mirrorPrefix.replace(/\/+$/, '')}/${upstream}`)
  urls.push(npmmirror, upstream)
  return urls
}
