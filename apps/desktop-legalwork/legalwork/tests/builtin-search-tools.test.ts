import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// defaultLocalTools executes buildBuiltinLocalTools at load time; importing it
// here mirrors tests/builtin-tools.test.ts and sidesteps the circular-init
// ReferenceError that a direct builtin-tools import can hit.
import { defaultLocalTools, type LocalTool } from '../src/adapters/tool/local-tool-host.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'

function toolByName(name: string): LocalTool {
  const tool = defaultLocalTools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool not found: ${name}`)
  return tool
}

function toolContext(workspace: string): ToolHostContext {
  return {
    workspace,
    threadId: 'test',
    abortSignal: new AbortController().signal
  } as unknown as ToolHostContext
}

async function tempWorkspace(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'ls-grep-'))
  await mkdir(join(root, 'subdir'))
  await writeFile(join(root, 'a.txt'), 'hello world\n')
  await writeFile(join(root, 'subdir', 'b.txt'), 'needle here\n')
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

describe('ls error tolerance', () => {
  it('returns a friendly error instead of throwing ENOENT for a missing directory', async () => {
    const { root, cleanup } = await tempWorkspace()
    try {
      const result = await toolByName('ls').execute(
        { path: join(root, 'does-not-exist') },
        toolContext(root)
      )
      expect(result.isError).toBe(true)
      expect(String((result.output as Record<string, unknown>).error)).toContain('does not exist')
    } finally {
      await cleanup()
    }
  })

  it('returns a friendly error for a path that is a file, not a directory', async () => {
    const { root, cleanup } = await tempWorkspace()
    try {
      const result = await toolByName('ls').execute({ path: join(root, 'a.txt') }, toolContext(root))
      expect(result.isError).toBe(true)
      expect(String((result.output as Record<string, unknown>).error)).toContain('not a directory')
    } finally {
      await cleanup()
    }
  })

  it('lists an existing directory normally', async () => {
    const { root, cleanup } = await tempWorkspace()
    try {
      const result = await toolByName('ls').execute({ path: root }, toolContext(root))
      expect(result.isError).toBeFalsy()
      const names = (result.output as { names?: string[] }).names ?? []
      expect(names).toContain('a.txt')
      expect(names).toContain('subdir/')
    } finally {
      await cleanup()
    }
  })
})

describe('grep error tolerance', () => {
  it('returns a friendly error instead of throwing ENOENT for a missing path', async () => {
    const { root, cleanup } = await tempWorkspace()
    try {
      const result = await toolByName('grep').execute(
        { pattern: 'needle', path: join(root, 'no-such-file.txt') },
        toolContext(root)
      )
      expect(result.isError).toBe(true)
      expect(String((result.output as Record<string, unknown>).error)).toContain('does not exist')
    } finally {
      await cleanup()
    }
  })

  it('searches a single file path directly', async () => {
    const { root, cleanup } = await tempWorkspace()
    try {
      const result = await toolByName('grep').execute(
        { pattern: 'needle', path: join(root, 'subdir', 'b.txt') },
        toolContext(root)
      )
      expect(result.isError).toBeFalsy()
      const matches = (result.output as { matches?: Array<{ text: string }> }).matches ?? []
      expect(matches.length).toBe(1)
      expect(matches[0]?.text).toContain('needle')
    } finally {
      await cleanup()
    }
  })
})
