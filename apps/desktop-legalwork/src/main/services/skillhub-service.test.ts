import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installSkillHubSkill, listSkillHubSkills } from './skillhub-service'

describe('skillhub-service', () => {
  const tempRoots: string[] = []

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('normalizes the public SkillHub hot list and rejects malformed entries', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      code: 0,
      message: 'success',
      data: {
        total: 688,
        skills: [
        {
          slug: 'web-tools-guide',
          name: 'Web Tools Guide',
          description_zh: '网页工具使用指南',
          description: 'Web tooling guide',
          category: 'knowledge-management',
          downloads: 212233,
          installs: 3459,
          stars: 205,
          score: 19000.5,
          version: '1.0.2',
          namespace: { handle: 'user_ec205dbb', displayName: '作者' },
          iconUrl: 'https://example.com/icon.png',
          tags: ['web', 'research']
        },
        {
          slug: '../unsafe',
          namespace: { handle: 'attacker' }
        }
        ]
      }
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await listSkillHubSkills({ category: 'legal', page: 2, pageSize: 24 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.total).toBe(688)
    expect(result.page).toBe(2)
    expect(result.totalPages).toBe(29)
    expect(result.skills).toEqual([expect.objectContaining({
      slug: 'web-tools-guide',
      namespace: 'user_ec205dbb',
      description: '网页工具使用指南',
      downloads: 212233,
      stars: 205,
      version: '1.0.2'
    })])
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('keyword=%E6%B3%95%E5%BE%8B'),
      expect.any(Object)
    )
  })

  it('rejects unsafe download coordinates before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await installSkillHubSkill({
      slug: '../unsafe',
      namespace: 'publisher',
      targetRoot: '/tmp/legalwork-skills'
    })

    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('installs a SkillHub package that contains only SKILL.md', async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), 'legalwork-skillhub-md-only-'))
    tempRoots.push(targetRoot)
    const archive = Buffer.from(
      'UEsDBAoAAAAIAGxrEV0dCECFbQAAAJcAAAAIAAAAU0tJTEwubWR9zUEKwkAMRuH9nOIH1/EAXYrbguAJhpm0hmYSSVult9fSffff4xFRsty4Q6vkphsFN1+Y5klUU+W5hLwXcevwWIPR55iqfw2Hw3N3GDygPGYFf6SyFUZ5hZurj9s10f9yQX/Hfki3VbQinwU/UEsBAhQACgAAAAgAbGsRXR0IQIVtAAAAlwAAAAgAAAAAAAAAAAAAAAAAAAAAAFNLSUxMLm1kUEsFBgAAAAABAAEANgAAAJMAAAAAAA==',
      'base64'
    )
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(archive, {
      status: 200,
      headers: { 'content-type': 'application/zip' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await installSkillHubSkill({
      slug: 'md-only-remote-skill',
      namespace: 'publisher',
      targetRoot
    })

    expect(result).toMatchObject({
      ok: true,
      installed: [{ name: 'md-only-remote-skill' }]
    })
    await expect(readFile(join(targetRoot, 'md-only-remote-skill', 'SKILL.md'), 'utf8'))
      .resolves.toContain('Build a legal evidence chronology.')
  })

  it('uses only the approved non-coding category routes', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(JSON.stringify({
      code: 0,
      message: 'success',
      data: { total: 0, skills: [] }
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await listSkillHubSkills({ category: 'office', page: 1 })
    await listSkillHubSkills({ category: 'learning', page: 1 })

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls[0]).toContain('category=office-efficiency')
    expect(urls[1]).toContain('category=knowledge-management')
    expect(urls.join(' ')).not.toContain('dev-programming')
  })
})
