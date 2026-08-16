type MarkdownNode = {
  type?: string
  value?: string
  children?: MarkdownNode[]
}

/**
 * Models commonly emit Chinese prose such as `核心是**“结论”**。`.
 * CommonMark treats that delimiter sequence as literal text because the
 * opening marker is embedded in a Unicode word. Repair only emphasis that the
 * parser left literal and that immediately follows a letter/number; already
 * valid Markdown has become a `strong` node before this plugin runs.
 */
export function remarkRepairInlineEmphasis(): (tree: MarkdownNode) => void {
  return (tree) => repairChildren(tree)
}

function repairChildren(node: MarkdownNode): void {
  if (!Array.isArray(node.children)) return
  const repaired: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      repaired.push(...repairTextNode(child.value))
      continue
    }
    repairChildren(child)
    repaired.push(child)
  }
  node.children = repaired
}

function repairTextNode(value: string): MarkdownNode[] {
  const pattern = /([\p{L}\p{N}])\*\*([^*\n]+)\*\*/gu
  const nodes: MarkdownNode[] = []
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0
    const leading = value.slice(cursor, index) + (match[1] ?? '')
    if (leading) nodes.push({ type: 'text', value: leading })
    nodes.push({
      type: 'strong',
      children: [{ type: 'text', value: match[2] ?? '' }]
    })
    cursor = index + match[0].length
  }
  if (nodes.length === 0) return [{ type: 'text', value }]
  const trailing = value.slice(cursor)
  if (trailing) nodes.push({ type: 'text', value: trailing })
  return nodes
}
