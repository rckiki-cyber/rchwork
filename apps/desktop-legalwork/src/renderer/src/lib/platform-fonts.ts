/**
 * Platform-aware font stacks for runtime surfaces that cannot read the
 * --font-apple-* CSS variables (CodeMirror themes, Mermaid config, ...).
 *
 * macOS keeps Apple-first stacks; Windows swaps in Segoe UI / Microsoft
 * YaHei for UI text and Cascadia Mono / Consolas for code.
 */

export function isWindowsPlatform(): boolean {
  return typeof window !== 'undefined' && window.dsGui?.platform === 'win32'
}

export function uiFontStack(): string {
  return isWindowsPlatform()
    ? '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
    : '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Segoe UI", "Helvetica Neue", Arial, sans-serif'
}

export function displayFontStack(): string {
  return isWindowsPlatform()
    ? '"Segoe UI Variable Display", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
    : '"SF Pro Display", -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Segoe UI", "Helvetica Neue", Arial, sans-serif'
}

export function monoFontStack(): string {
  return isWindowsPlatform()
    ? '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace'
    : 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace'
}

export function proseSerifStack(): string {
  return isWindowsPlatform()
    ? 'Georgia, "Times New Roman", "SimSun", "宋体", serif'
    : 'Georgia, Charter, "Iowan Old Style", "Noto Serif SC", serif'
}
