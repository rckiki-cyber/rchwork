import { readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import type { FindLocalToolOptions, GrepLocalToolOptions, GrepMatch, LsLocalToolOptions } from './builtin-tool-types.js'
import {
  DEFAULT_FIND_LIMIT,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  FD_EXECUTABLE_CANDIDATES,
  RG_EXECUTABLE_CANDIDATES
} from './builtin-tool-types.js'
import { defaultLsLocalToolOperations } from './builtin-tool-operations.js'
import {
  collectPaths,
  globToRegExp,
  isBinaryBuffer,
  listDirectoryWithOps,
  normalizeBoolean,
  normalizePositiveInteger,
  normalizeToolPath,
  resolveExecutable,
  resolveWorkspacePath,
  spawnCapture,
  withToolBoundary
} from './builtin-tool-utils.js'

/** Extract a Node error code (ENOENT/ENOTDIR/EPERM/...) from an unknown error. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  return undefined
}

export function createLsLocalTool(options: LsLocalToolOptions = {}): LocalTool {
  const statOp = options.operations?.stat ?? defaultLsLocalToolOperations.stat!
  const readdirOp = options.operations?.readdir ?? defaultLsLocalToolOperations.readdir!
  return LocalToolHost.defineTool({
    name: 'ls',
    description: 'List directory contents. Returns entries sorted alphabetically and marks directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' }
      },
      required: [],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const limit = normalizePositiveInteger(args.limit, options.defaultLimit ?? DEFAULT_LIST_LIMIT)
      const { workspaceRoot: root, absolutePath, relativePath } = resolveWorkspacePath(rawPath, context)
      let targetStat
      try {
        targetStat = await statOp(absolutePath)
      } catch (error) {
        const code = errorCodeOf(error)
        if (code === 'ENOENT') {
          return {
            output: {
              error: `directory does not exist: ${absolutePath}`,
              path: absolutePath
            },
            isError: true
          }
        }
        if (code === 'ENOTDIR') {
          return {
            output: {
              error: `not a directory: ${absolutePath}`,
              path: absolutePath
            },
            isError: true
          }
        }
        if (code === 'EPERM' || code === 'EACCES') {
          return {
            output: {
              error: `permission denied while listing: ${absolutePath}`,
              path: absolutePath
            },
            isError: true
          }
        }
        throw error
      }
      if (!targetStat.isDirectory()) {
        return {
          output: {
            error: `not a directory: ${absolutePath}`,
            path: absolutePath
          },
          isError: true
        }
      }
      const entries = await listDirectoryWithOps(absolutePath, root, false, limit, statOp, readdirOp)
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          entries: entries.map((entry) => ({
            ...entry,
            display_name: entry.kind === 'directory' ? `${entry.name}/` : entry.name
          })),
          names: entries.map((entry) => (entry.kind === 'directory' ? `${entry.name}/` : entry.name)),
          truncated: entries.length >= limit,
          entry_limit_reached: entries.length >= limit ? limit : null
        }
      }
    })
  })
}

export const createLsTool = createLsLocalTool
export const createLsToolDefinition = createLsLocalTool

export function createFindLocalTool(options: FindLocalToolOptions = {}): LocalTool {
  return LocalToolHost.defineTool({
    name: 'find',
    description: 'Find local filesystem files by glob pattern, similar to pi find. Relative paths resolve against the current workspace; absolute paths may point anywhere on the computer.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => withToolBoundary(async () => {
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
      if (!pattern) return { output: { error: 'pattern is required' }, isError: true }
      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const limit = normalizePositiveInteger(args.limit, options.defaultLimit ?? DEFAULT_FIND_LIMIT)
      const { workspaceRoot: root, absolutePath, relativePath } = resolveWorkspacePath(rawPath, context)
      const matcher = globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`)
      if (options.operations?.glob) {
        const matches = await options.operations.glob({ pattern, path: absolutePath, limit })
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            pattern,
            matches,
            backend: 'custom',
            truncated: matches.length >= limit,
            result_limit_reached: matches.length >= limit ? limit : null
          }
        }
      }
      const fd = resolveExecutable(options.fdExecutableCandidates ?? FD_EXECUTABLE_CANDIDATES)
      const rg = resolveExecutable(options.rgExecutableCandidates ?? RG_EXECUTABLE_CANDIDATES)
      let matches: Array<{ path: string; relative_path: string }>
      if (fd) {
        const args = [
          '--glob',
          '--color=never',
          '--hidden',
          '--no-require-git',
          '--max-results',
          String(limit),
          '--',
          pattern,
          absolutePath
        ]
        const result = await spawnCapture(fd, args, { cwd: root, signal: context.abortSignal })
        const candidates = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        matches = candidates
          .map((path) => ({
            path: resolve(path),
            relative_path: normalizeToolPath(relative(root, resolve(path)) || '.')
          }))
          .slice(0, limit)
      } else if (rg) {
        const result = await spawnCapture(
          rg,
          ['--files', '--hidden', '-g', pattern, absolutePath],
          { cwd: root, signal: context.abortSignal }
        )
        const candidates = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        matches = candidates
          .map((path) => ({
            path: resolve(path),
            relative_path: normalizeToolPath(relative(root, resolve(path)) || '.')
          }))
          .slice(0, limit)
      } else {
        const paths = await collectPaths(absolutePath, { includeDirectories: false, limit: limit * 8 })
        matches = paths
          .map((path) => ({ path, relative_path: normalizeToolPath(relative(root, path) || '.') }))
          .filter((entry) => matcher.test(entry.relative_path))
          .slice(0, limit)
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          pattern,
          matches,
          backend: fd ? 'fd' : rg ? 'rg' : 'scan',
          truncated: matches.length >= limit,
          result_limit_reached: matches.length >= limit ? limit : null
        }
      }
    })
  })
}

export const createFindTool = createFindLocalTool
export const createFindToolDefinition = createFindLocalTool

/** 在单个文件上执行正则匹配并返回 GrepMatch 列表。二进制文件视为无匹配。 */
async function grepSingleFile(input: {
  matcher: RegExp
  filePath: string
  relativePath: string
  limit: number
  contextLines: number
}): Promise<GrepMatch[]> {
  const { matcher, filePath, relativePath, limit, contextLines } = input
  const buffer = await readFile(filePath)
  if (isBinaryBuffer(buffer)) return []
  const fileLines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n')
  const matches: GrepMatch[] = []
  for (let index = 0; index < fileLines.length; index += 1) {
    if (matches.length >= limit) break
    const line = fileLines[index] ?? ''
    const result = matcher.exec(line)
    if (!result) continue
    matches.push({
      path: filePath,
      relative_path: relativePath,
      line: index + 1,
      column: (result.index ?? 0) + 1,
      text: line,
      ...(contextLines > 0
        ? {
            context_before: fileLines.slice(Math.max(0, index - contextLines), index),
            context_after: fileLines.slice(index + 1, index + 1 + contextLines)
          }
        : {})
    })
  }
  return matches
}

export function createGrepLocalTool(options: GrepLocalToolOptions = {}): LocalTool {
  return LocalToolHost.defineTool({
    name: 'grep',
    description: 'Search file contents for a pattern and return matching lines with paths and line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        ignoreCase: { type: 'boolean' },
        literal: { type: 'boolean' },
        context: { type: 'number' },
        limit: { type: 'number' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => withToolBoundary(async () => {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (!pattern.trim()) return { output: { error: 'pattern is required' }, isError: true }
      const literal = normalizeBoolean(args.literal)
      const ignoreCase = normalizeBoolean(args.ignoreCase)
      const contextLines = typeof args.context === 'number' && Number.isFinite(args.context) && args.context > 0
        ? Math.floor(args.context)
        : 0
      const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : null
      const limit = normalizePositiveInteger(args.limit, options.defaultLimit ?? DEFAULT_SEARCH_LIMIT)
      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const flags = ignoreCase ? 'i' : ''
      const effectiveMatcher = literal
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
        : new RegExp(pattern, flags)
      const globMatcher = glob ? globToRegExp(glob.includes('/') ? glob : `**/${glob}`) : null
      const { workspaceRoot: root, absolutePath, relativePath } = resolveWorkspacePath(rawPath, context)
      // 优先走注入的自定义 search backend（若有），保持依赖注入语义不变。
      if (options.operations?.search) {
        const matches = await options.operations.search({
          pattern,
          path: absolutePath,
          glob,
          ignoreCase,
          literal,
          context: contextLines,
          limit
        })
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            pattern,
            glob,
            ignore_case: ignoreCase,
            literal,
            context: contextLines,
            backend: 'custom',
            matches,
            truncated: matches.length >= limit,
            match_limit_reached: matches.length >= limit ? limit : null
          }
        }
      }
      // path 指向单个文件时直接搜索该文件，避免把文件当目录遍历报 ENOTDIR。
      let targetStat
      try {
        targetStat = await stat(absolutePath)
      } catch (error) {
        const code = errorCodeOf(error)
        if (code === 'ENOENT') {
          return {
            output: {
              error: `path does not exist: ${absolutePath}`,
              path: absolutePath
            },
            isError: true
          }
        }
        if (code === 'ENOTDIR') {
          return {
            output: {
              error: `not a directory: ${absolutePath}`,
              path: absolutePath
            },
            isError: true
          }
        }
        if (code === 'EPERM' || code === 'EACCES') {
          return {
            output: {
              error: `permission denied while searching: ${absolutePath}`,
              path: absolutePath
            },
            isError: true
          }
        }
        throw error
      }
      if (targetStat.isFile()) {
        const fileMatches = await grepSingleFile({
          matcher: effectiveMatcher,
          filePath: absolutePath,
          relativePath,
          limit,
          contextLines
        })
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            pattern,
            glob,
            ignore_case: ignoreCase,
            literal,
            context: contextLines,
            backend: 'file',
            matches: fileMatches,
            truncated: fileMatches.length >= limit,
            match_limit_reached: fileMatches.length >= limit ? limit : null
          }
        }
      }
      const matches: GrepMatch[] = []
      const rg = resolveExecutable(options.rgExecutableCandidates ?? RG_EXECUTABLE_CANDIDATES)
      if (rg) {
        const rgArgs = ['--hidden', '--line-number', '--with-filename', '--color', 'never']
        if (ignoreCase) rgArgs.push('--ignore-case')
        if (literal) rgArgs.push('--fixed-strings')
        if (glob) rgArgs.push('-g', glob)
        rgArgs.push(pattern, absolutePath)
        const result = await spawnCapture(rg, rgArgs, { cwd: root, signal: context.abortSignal })
        const rows = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        for (const row of rows) {
          if (matches.length >= limit) break
          const parsed = row.match(/^(.*?):(\d+):(.*)$/)
          if (!parsed) continue
          const candidatePath = resolve(parsed[1] ?? '')
          const lineNumber = Number(parsed[2] ?? '0')
          const lineText = parsed[3] ?? ''
          const candidateRelative = normalizeToolPath(relative(root, candidatePath) || '.')
          if (globMatcher && !globMatcher.test(candidateRelative)) continue
          const columnMatch = effectiveMatcher.exec(lineText)
          const buffer = await readFile(candidatePath)
          if (isBinaryBuffer(buffer)) continue
          const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n')
          matches.push({
            path: candidatePath,
            relative_path: candidateRelative,
            line: lineNumber,
            column: (columnMatch?.index ?? 0) + 1,
            text: lineText,
            ...(contextLines > 0
              ? {
                  context_before: lines.slice(Math.max(0, lineNumber - 1 - contextLines), lineNumber - 1),
                  context_after: lines.slice(lineNumber, lineNumber + contextLines)
                }
              : {})
          })
        }
      } else {
        const candidates = await collectPaths(absolutePath, { includeDirectories: false, limit: limit * 8 })
        for (const candidatePath of candidates) {
          if (matches.length >= limit) break
          const candidateRelative = normalizeToolPath(relative(root, candidatePath) || '.')
          if (globMatcher && !globMatcher.test(candidateRelative)) continue
          const buffer = await readFile(candidatePath)
          if (isBinaryBuffer(buffer)) continue
          const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n')
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? ''
            const result = effectiveMatcher.exec(line)
            if (!result) continue
            matches.push({
              path: candidatePath,
              relative_path: candidateRelative,
              line: index + 1,
              column: (result.index ?? 0) + 1,
              text: line,
              ...(contextLines > 0
                ? {
                    context_before: lines.slice(Math.max(0, index - contextLines), index),
                    context_after: lines.slice(index + 1, index + 1 + contextLines)
                  }
                : {})
            })
            if (matches.length >= limit) break
          }
        }
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          pattern,
          glob,
          ignore_case: ignoreCase,
          literal,
          context: contextLines,
          backend: rg ? 'rg' : 'scan',
          matches,
          truncated: matches.length >= limit,
          match_limit_reached: matches.length >= limit ? limit : null
        }
      }
    })
  })
}

export const createGrepTool = createGrepLocalTool
export const createGrepToolDefinition = createGrepLocalTool
