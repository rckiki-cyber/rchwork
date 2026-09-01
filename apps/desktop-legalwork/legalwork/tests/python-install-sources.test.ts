import { describe, expect, it } from 'vitest'
import {
  MAX_PIP_INSTALL_ATTEMPTS,
  describePipIndexes,
  pipIndexArgs,
  resolvePipIndexCandidates,
  resolvePythonStandaloneUrls,
  runPipInstallWithFallback,
  selectReachablePipIndexes,
  type PipIndexCandidate
} from '../src/shared/python-install-sources.js'

const deadFetch = async (): Promise<never> => {
  throw new Error('offline')
}

const liveFetch = async (): Promise<{ ok: boolean; status: number; body: null }> => ({
  ok: true,
  status: 200,
  body: null
})

describe('pip index candidates', () => {
  // Regression: pipIndexArgs used to append --trusted-host unconditionally,
  // which switches off TLS verification for pypi.org and the mirrors. The
  // requirements files pin versions but carry no hashes, so that turned a
  // network convenience into a supply-chain hole.
  it('never disables TLS verification for the built-in mirrors or pypi.org', () => {
    const candidates = resolvePipIndexCandidates({})
    expect(candidates.length).toBeGreaterThan(1)
    for (const candidate of candidates) {
      expect(pipIndexArgs(candidate)).not.toContain('--trusted-host')
    }
  })

  it('only trusts a host the user pointed us at explicitly', () => {
    const candidates = resolvePipIndexCandidates({
      LEGALWORK_PIP_INDEX_URL: 'http://nexus.corp.local/simple'
    })
    const [override, ...rest] = candidates
    expect(pipIndexArgs(override)).toEqual([
      '-i', 'http://nexus.corp.local/simple', '--trusted-host', 'nexus.corp.local'
    ])
    for (const candidate of rest) {
      expect(pipIndexArgs(candidate)).not.toContain('--trusted-host')
    }
  })

  // Regression: forcing -i on every attempt overrode the user's pip.conf /
  // PIP_INDEX_URL, so intranet machines that used to install fine could not
  // install at all.
  it('always keeps a candidate that lets pip use its own configuration', () => {
    const candidates = resolvePipIndexCandidates({})
    const pipConfig = candidates.filter((candidate) => candidate.indexUrl === null)
    expect(pipConfig).toHaveLength(1)
    expect(pipIndexArgs(pipConfig[0])).toEqual([])
  })

  it('puts pip\'s own configuration first when the environment shows it is configured', () => {
    for (const env of [
      { PIP_INDEX_URL: 'http://nexus.corp.local/simple' },
      { PIP_EXTRA_INDEX_URL: 'http://nexus.corp.local/simple' },
      { PIP_CONFIG_FILE: '/etc/pip.conf' }
    ]) {
      expect(resolvePipIndexCandidates(env)[0].indexUrl).toBeNull()
    }
  })

  it('prefers domestic mirrors over pypi.org by default', () => {
    const labels = resolvePipIndexCandidates({}).map((candidate) => candidate.label)
    expect(labels.indexOf('pypi.tuna.tsinghua.edu.cn')).toBeLessThan(labels.indexOf('pypi.org'))
  })

  it('ignores an unparseable override instead of stranding the install', () => {
    const candidates = resolvePipIndexCandidates({ LEGALWORK_PIP_INDEX_URL: 'not a url' })
    expect(candidates.some((candidate) => candidate.label === 'pypi.tuna.tsinghua.edu.cn')).toBe(true)
  })

  it('describes candidates for the failure message', () => {
    expect(describePipIndexes(resolvePipIndexCandidates({}))).toContain('pypi.tuna.tsinghua.edu.cn')
  })
})

describe('index reachability probing', () => {
  it('keeps every index when the network answers', async () => {
    const candidates = resolvePipIndexCandidates({})
    const reachable = await selectReachablePipIndexes(candidates, 50, liveFetch)
    expect(reachable).toHaveLength(candidates.length)
  })

  // On an isolated intranet nothing public answers. The pip-config candidate
  // is then the only one that can work, so it has to land inside the attempt
  // budget rather than at the back of the queue.
  it('hoists pip\'s own configuration to the front when nothing public answers', async () => {
    const candidates = resolvePipIndexCandidates({})
    const reachable = await selectReachablePipIndexes(candidates, 50, deadFetch)
    expect(reachable[0].indexUrl).toBeNull()
    expect(reachable.slice(0, MAX_PIP_INSTALL_ATTEMPTS).some((c) => c.indexUrl === null)).toBe(true)
  })

  it('drops only the indexes that failed to answer', async () => {
    const candidates = resolvePipIndexCandidates({})
    const onlyTsinghua = async (url: string) => {
      if (url.includes('tuna.tsinghua')) return { ok: true, status: 200, body: null }
      throw new Error('blocked')
    }
    const reachable = await selectReachablePipIndexes(candidates, 50, onlyTsinghua)
    expect(reachable.map((c) => c.label)).toEqual(['pypi.tuna.tsinghua.edu.cn', 'pip 自身配置'])
  })
})

describe('runPipInstallWithFallback', () => {
  const candidate = (label: string): PipIndexCandidate => ({ indexUrl: `https://${label}/simple`, label, trustedHost: false })

  it('stops at the first success', async () => {
    const tried: string[] = []
    const outcome = await runPipInstallWithFallback({
      candidates: [candidate('a'), candidate('b'), candidate('c')],
      attempt: async (c) => {
        tried.push(c.label)
        return c.label === 'a' ? 0 : 1
      },
      succeeded: (code) => code === 0
    })
    expect(tried).toEqual(['a'])
    expect(outcome.succeededWith?.label).toBe('a')
  })

  // The whole point of the cap: three indexes times two attempts times a
  // 15-minute pip timeout used to add up to a 90-minute wait before the user
  // saw any error at all.
  it('bounds the number of pip attempts', async () => {
    const tried: string[] = []
    const outcome = await runPipInstallWithFallback({
      candidates: [candidate('a'), candidate('b'), candidate('c'), candidate('d')],
      attempt: async (c) => {
        tried.push(c.label)
        return 1
      },
      succeeded: (code) => code === 0
    })
    expect(tried).toHaveLength(MAX_PIP_INSTALL_ATTEMPTS)
    expect(outcome.succeededWith).toBeNull()
    expect(outcome.attempted).toHaveLength(MAX_PIP_INSTALL_ATTEMPTS)
  })

  it('reports which indexes were actually attempted', async () => {
    const outcome = await runPipInstallWithFallback({
      candidates: [candidate('a'), candidate('b'), candidate('c')],
      attempt: async () => 1,
      succeeded: (code) => code === 0,
      maxAttempts: 3
    })
    expect(describePipIndexes(outcome.attempted)).toBe('a、b、c')
  })

  it('announces each switch exactly once', async () => {
    const switches: string[] = []
    await runPipInstallWithFallback({
      candidates: [candidate('a'), candidate('b'), candidate('c')],
      attempt: async () => 1,
      succeeded: (code) => code === 0,
      onSwitch: (next) => switches.push(next.label),
      maxAttempts: 3
    })
    expect(switches).toEqual(['b', 'c'])
  })
})

describe('standalone CPython sources', () => {
  it('tries the domestic mirror before GitHub', () => {
    const urls = resolvePythonStandaloneUrls('win32', 'x64', {})
    expect(urls[0]).toContain('registry.npmmirror.com')
    expect(urls[urls.length - 1]).toContain('github.com')
  })

  it('percent-encodes the + only for npmmirror', () => {
    const [mirror, upstream] = resolvePythonStandaloneUrls('darwin', 'arm64', {})
    expect(mirror).toContain('%2B')
    expect(upstream).toContain('+')
  })

  it('returns nothing for a platform with no published build', () => {
    expect(resolvePythonStandaloneUrls('aix' as NodeJS.Platform, 'x64', {})).toEqual([])
  })
})
