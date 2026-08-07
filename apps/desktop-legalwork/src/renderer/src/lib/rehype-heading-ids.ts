type HastNode = {
  type?: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/**
 * GitHub 风格 slug：小写 → 去标点（保留 Unicode 字母/数字/连字符/空格）→ 空格转连字符。
 * 中文标题原样保留（`第一章` → `第一章`），这样 Markdown 目录里的
 * `[第一章](#第一章)` 锚点链接就能通过浏览器默认跳转命中标题。
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function headingText(node: HastNode): string {
  let text = ''
  const walk = (n: HastNode): void => {
    if (n.type === 'text' && typeof n.value === 'string') text += n.value
    if (n.type === 'element' && n.tagName === 'img' && typeof n.properties?.alt === 'string') {
      text += ` ${n.properties.alt as string}`
    }
    if (n.children) n.children.forEach(walk)
  }
  walk(node)
  return text.trim()
}

/**
 * 为 h1-h6 生成 GitHub 风格 `id`，使 Markdown 目录（TOC）锚点链接可跳转。
 * streamdown 默认标题渲染不产出 id，导致 `[xxx](#xxx)` 点击后浏览器找不到目标。
 */
export function rehypeHeadingIds() {
  const used = new Set<string>()
  return (tree: HastNode): void => {
    const visit = (node: HastNode): void => {
      if (node.type === 'element' && HEADING_TAGS.has(node.tagName ?? '')) {
        const base = headingSlug(headingText(node)) || 'section'
        let id = base
        let n = 2
        while (used.has(id)) id = `${base}-${n++}`
        used.add(id)
        node.properties = { ...(node.properties ?? {}), id }
      }
      if (node.children) node.children.forEach(visit)
    }
    visit(tree)
  }
}
