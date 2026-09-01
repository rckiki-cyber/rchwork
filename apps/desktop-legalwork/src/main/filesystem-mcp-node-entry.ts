import { existsSync } from 'node:fs'
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile
} from 'node:fs/promises'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

/**
 * 本地 filesystem MCP 服务器（离线版）。
 *
 * 原默认配置 `npx -y @modelcontextprotocol/server-filesystem` 依赖 npx 在启动时联网
 * 检查 npm registry，网络不通时会在 connect_timeout 内连不上（MCP error -32001）。
 * 本入口由 legalwork 自带 node（ELECTRON_RUN_AS_NODE）直接拉起，纯本地、零网络依赖，
 * 工具集与官方 server-filesystem 对齐，路径访问限制在启动参数给定的允许目录内。
 */

const allowedDirectories: string[] = process.argv.slice(2).filter((arg) => arg.trim().length > 0)

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structuredContent ? { structuredContent } : {})
  }
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true
  }
}

/** 将目标路径解析为绝对路径，并校验其落在允许目录内（与官方 server 同款的词法收容）。 */
function validatePath(targetPath: string): string {
  if (allowedDirectories.length === 0) {
    throw new Error('No allowed directories configured')
  }
  const absolutePath = path.resolve(targetPath)
  for (const allowedDir of allowedDirectories) {
    const normalizedAllowed = allowedDir.endsWith('/') ? allowedDir.slice(0, -1) : allowedDir
    const normalizedTarget = absolutePath.endsWith('/') ? absolutePath.slice(0, -1) : absolutePath
    const relative = path.relative(normalizedAllowed, normalizedTarget)
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return absolutePath
    }
  }
  throw new Error(`Access denied: ${targetPath} is outside the allowed directories`)
}

async function readFileContent(filePath: string): Promise<{ text: string; base64: string }> {
  const validatedPath = validatePath(filePath)
  const stats = await stat(validatedPath)
  if (stats.isDirectory()) {
    throw new Error(`Cannot read file: ${filePath} is a directory`)
  }
  const buffer = await readFile(validatedPath)
  if (buffer.includes(0)) {
    return { text: '', base64: buffer.toString('base64') }
  }
  return { text: buffer.toString('utf8'), base64: '' }
}

/** 简单 glob 匹配：双星号段跨任意层目录（可为零层）、单星号段内任意、问号单字符。 */
function globToRegExp(pattern: string): RegExp {
  let regex = ''
  let index = 0
  while (index < pattern.length) {
    const ch = pattern[index]
    if (ch === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          regex += '(?:.*/)?'
          index += 3
        } else {
          regex += '.*'
          index += 2
        }
        continue
      }
      regex += '[^/]*'
      index += 1
      continue
    }
    if (ch === '?') {
      regex += '[^/]'
      index += 1
      continue
    }
    regex += '.*+?^${}()|[]\\'.includes(ch) ? `\\${ch}` : ch
    index += 1
  }
  return new RegExp(`^${regex}$`)
}

async function walkDirectory(
  dir: string,
  relativePrefix: string,
  pattern?: string,
  excludePatterns: string[] = []
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    const relative = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (pattern) {
        const nested = await walkDirectory(path.join(dir, entry.name), relative, pattern, excludePatterns)
        results.push(...nested)
      } else {
        results.push(relative)
      }
      continue
    }
    if (pattern) {
      const matcher = globToRegExp(pattern)
      const excluded = excludePatterns.some((exclude) => globToRegExp(exclude).test(relative))
      if (!excluded && matcher.test(relative)) {
        results.push(relative)
      }
    } else {
      results.push(relative)
    }
  }
  return results
}

/**
 * 应用 unified diff（git diff 输出）。逐 hunk 校验上下文，任一不匹配即整体失败，
 * 保证要么干净应用要么报错，绝不产生半应用的文件。
 */
function applyUnifiedDiff(original: string, patchText: string): string {
  const originalLines = original.split('\n')
  const patchLines = patchText.split('\n')
  const result = [...originalLines]
  let offset = 0
  let index = 0
  while (index < patchLines.length) {
    const header = patchLines[index]
    if (!header.startsWith('@@')) {
      index++
      continue
    }
    const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (!match) throw new Error(`Invalid hunk header: ${header}`)
    const oldStart = Number(match[1])
    index++
    const body: string[] = []
    while (index < patchLines.length && !patchLines[index].startsWith('@@')) {
      body.push(patchLines[index])
      index++
    }
    const newLines: string[] = []
    let cursor = oldStart - 1 + offset
    for (const line of body) {
      if (line.length === 0) continue // 忽略 patch 文本末尾换行产生的空元素
      const operation = line[0]
      const content = line.slice(1)
      if (operation === ' ') {
        if (originalLines[cursor] !== content) {
          throw new Error(`Patch context mismatch at line ${cursor + 1}`)
        }
        newLines.push(content)
        cursor++
      } else if (operation === '-') {
        if (originalLines[cursor] !== content) {
          throw new Error(`Patch deletion mismatch at line ${cursor + 1}`)
        }
        cursor++
      } else if (operation === '+') {
        newLines.push(content)
      } else if (operation === '\\') {
        // `\ No newline at end of file` marker：忽略。
      } else {
        throw new Error(`Unknown patch line: ${line}`)
      }
    }
    const removedCount = cursor - (oldStart - 1 + offset)
    result.splice(oldStart - 1 + offset, removedCount, ...newLines)
    offset += newLines.length - removedCount
  }
  return result.join('\n')
}

function applyTextEdits(original: string, edits: Array<{ oldText: string; newText: string }>): string {
  let content = original
  for (const edit of edits) {
    if (edit.oldText.length === 0) {
      throw new Error('edit_file requires a non-empty oldText')
    }
    if (!content.includes(edit.oldText)) {
      throw new Error(`oldText not found in file: ${edit.oldText.slice(0, 80)}`)
    }
    content = content.split(edit.oldText).join(edit.newText)
  }
  return content
}

async function runFilesystemServer(): Promise<void> {
  if (allowedDirectories.length === 0) {
    throw new Error('Server cannot operate: no allowed directories were provided as arguments')
  }

  const server = new McpServer(
    { name: 'legalwork-filesystem', version: '0.1.0' },
    { capabilities: { logging: {} } }
  )

  server.registerTool('read_file', {
    description: 'Read the complete contents of a file as text (or base64 for binary files).',
    inputSchema: { path: z.string().describe('Absolute path to the file to read') }
  }, async ({ path: filePath }) => {
    try {
      const { text, base64 } = await readFileContent(filePath)
      if (base64) return textResult(`File content is binary (${base64.length} base64 chars).`, { base64 })
      return textResult(text, { content: text })
    } catch (error) {
      return errorResult(`read_file failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('read_multiple_files', {
    description: 'Read the complete contents of multiple files at once.',
    inputSchema: { paths: z.array(z.string()).describe('Array of absolute paths to read') }
  }, async ({ paths }) => {
    const results: Array<{ path: string; content: string }> = []
    for (const filePath of paths) {
      try {
        const { text, base64 } = await readFileContent(filePath)
        results.push({ path: filePath, content: base64 ? `[binary ${base64.length} base64 chars]` : text })
      } catch (error) {
        results.push({ path: filePath, content: `[error: ${error instanceof Error ? error.message : String(error)}]` })
      }
    }
    return textResult(JSON.stringify(results, null, 2), { results })
  })

  server.registerTool('write_file', {
    description: 'Write text content to a file at the given path. Fails if the parent directory does not exist.',
    inputSchema: {
      path: z.string().describe('Absolute path of the file to write'),
      content: z.string().describe('Text content to write')
    }
  }, async ({ path: filePath, content }) => {
    try {
      const validatedPath = validatePath(filePath)
      await writeFile(validatedPath, content, 'utf8')
      return textResult(`Successfully wrote to ${filePath}`)
    } catch (error) {
      return errorResult(`write_file failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('edit_file', {
    description: 'Replace oldText with newText occurrences in a file. Returns the updated content.',
    inputSchema: {
      path: z.string().describe('Absolute path of the file to edit'),
      edits: z.array(z.object({
        oldText: z.string().describe('Exact text to find'),
        newText: z.string().describe('Replacement text')
      })).describe('List of text replacements')
    }
  }, async ({ path: filePath, edits }) => {
    try {
      const validatedPath = validatePath(filePath)
      const original = await readFile(validatedPath, 'utf8')
      const updated = applyTextEdits(original, edits)
      await writeFile(validatedPath, updated, 'utf8')
      return textResult(`Successfully edited ${filePath}`, { content: updated })
    } catch (error) {
      return errorResult(`edit_file failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('create_directory', {
    description: 'Create a new directory (and any missing parents).',
    inputSchema: { path: z.string().describe('Absolute path of the directory to create') }
  }, async ({ path: dirPath }) => {
    try {
      const validatedPath = validatePath(dirPath)
      await mkdir(validatedPath, { recursive: true })
      return textResult(`Successfully created directory ${dirPath}`)
    } catch (error) {
      return errorResult(`create_directory failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('list_directory', {
    description: 'List entries (files and directories) in a directory.',
    inputSchema: { path: z.string().describe('Absolute path of the directory to list') }
  }, async ({ path: dirPath }) => {
    try {
      const validatedPath = validatePath(dirPath)
      const entries = await readdir(validatedPath, { withFileTypes: true })
      const items = await Promise.all(entries.map(async (entry) => {
        let size: number | null = null
        let modified: string | null = null
        try {
          const stats = await stat(path.join(validatedPath, entry.name))
          size = stats.size
          modified = stats.mtime.toISOString()
        } catch {
          /* 条目可能在 stat 前被删，忽略。 */
        }
        return { name: entry.name, type: entry.isDirectory() ? 'directory' : 'file', size, modified }
      }))
      return textResult(JSON.stringify(items, null, 2), { entries: items })
    } catch (error) {
      return errorResult(`list_directory failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('directory_tree', {
    description: 'Recursively list the directory tree, one relative path per line.',
    inputSchema: { path: z.string().describe('Absolute path of the directory to walk') }
  }, async ({ path: dirPath }) => {
    try {
      const validatedPath = validatePath(dirPath)
      const tree = await walkDirectory(validatedPath, '')
      return textResult(tree.length ? tree.join('\n') : '(empty directory)', { tree })
    } catch (error) {
      return errorResult(`directory_tree failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('move_file', {
    description: 'Move or rename a file or directory. Creates the destination parent directory if needed.',
    inputSchema: {
      source: z.string().describe('Absolute path to the existing file or directory'),
      destination: z.string().describe('Absolute destination path')
    }
  }, async ({ source, destination }) => {
    try {
      const validatedSource = validatePath(source)
      const validatedDestination = validatePath(destination)
      await mkdir(path.dirname(validatedDestination), { recursive: true })
      await rename(validatedSource, validatedDestination)
      return textResult(`Successfully moved ${source} to ${destination}`)
    } catch (error) {
      return errorResult(`move_file failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('search_files', {
    description: 'Recursively search for files whose path matches a glob pattern. Supports `**`, `*`, and `?`.',
    inputSchema: {
      path: z.string().describe('Absolute directory to search'),
      pattern: z.string().describe('Glob pattern to match file paths, e.g. "**/*.md"'),
      excludePatterns: z.array(z.string()).optional().describe('Optional glob patterns to exclude')
    }
  }, async ({ path: dirPath, pattern, excludePatterns }) => {
    try {
      const validatedPath = validatePath(dirPath)
      const exclude = excludePatterns ?? []
      const matches = await walkDirectory(validatedPath, '', pattern, exclude)
      return textResult(matches.length ? matches.join('\n') : 'No files found matching the pattern.', {
        files: matches
      })
    } catch (error) {
      return errorResult(`search_files failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('get_file_info', {
    description: 'Get metadata for a file or directory (size, timestamps, type).',
    inputSchema: { path: z.string().describe('Absolute path to inspect') }
  }, async ({ path: filePath }) => {
    try {
      const validatedPath = validatePath(filePath)
      const stats = await stat(validatedPath)
      const info = {
        size: stats.size,
        created: stats.birthtime.toISOString(),
        modified: stats.mtime.toISOString(),
        accessed: stats.atime.toISOString(),
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile()
      }
      return textResult(JSON.stringify(info, null, 2), { info })
    } catch (error) {
      return errorResult(`get_file_info failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('list_allowed_directories', {
    description: 'List the directories this filesystem server is allowed to access.'
  }, async () => {
    return textResult(allowedDirectories.join('\n'), { directories: allowedDirectories })
  })

  server.registerTool('tail_file', {
    description: 'Read the last N lines of a text file.',
    inputSchema: {
      path: z.string().describe('Absolute path of the file'),
      lines: z.number().int().min(1).max(1000).optional().describe('Number of lines to read (default 20)')
    }
  }, async ({ path: filePath, lines }) => {
    try {
      const validatedPath = validatePath(filePath)
      const content = await readFile(validatedPath, 'utf8')
      const count = lines ?? 20
      const tail = content.split('\n').slice(-count).join('\n')
      return textResult(tail)
    } catch (error) {
      return errorResult(`tail_file failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('head_file', {
    description: 'Read the first N lines of a text file.',
    inputSchema: {
      path: z.string().describe('Absolute path of the file'),
      lines: z.number().int().min(1).max(1000).optional().describe('Number of lines to read (default 20)')
    }
  }, async ({ path: filePath, lines }) => {
    try {
      const validatedPath = validatePath(filePath)
      const content = await readFile(validatedPath, 'utf8')
      const count = lines ?? 20
      const head = content.split('\n').slice(0, count).join('\n')
      return textResult(head)
    } catch (error) {
      return errorResult(`head_file failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  server.registerTool('apply_patch', {
    description: 'Apply a unified diff (git diff output) to a file. Fails atomically if any hunk does not match.',
    inputSchema: {
      path: z.string().describe('Absolute path of the file to patch'),
      patch: z.string().describe('Unified diff text to apply')
    }
  }, async ({ path: filePath, patch }) => {
    try {
      const validatedPath = validatePath(filePath)
      if (!existsSync(validatedPath)) {
        throw new Error('Target file does not exist; apply_patch only supports patching existing files')
      }
      const original = await readFile(validatedPath, 'utf8')
      const updated = applyUnifiedDiff(original, patch)
      await writeFile(validatedPath, updated, 'utf8')
      return textResult('Successfully applied patch.', { content: updated })
    } catch (error) {
      return errorResult(`apply_patch failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

void runFilesystemServer().catch((error) => {
  console.error(`[legalwork-filesystem] server failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
