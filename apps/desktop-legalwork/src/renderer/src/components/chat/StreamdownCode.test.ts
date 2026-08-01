import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StreamdownCode } from './StreamdownCode'
import {
  diagramWidthFromSvg,
  ensureMermaidLabelVisibility,
  isMermaidLanguage,
  looksLikeMermaidSource
} from './MermaidDiagram'

describe('StreamdownCode plain text fences', () => {
  it('renders text fenced blocks without code block chrome', () => {
    const html = renderToStaticMarkup(
      createElement(
        StreamdownCode,
        { className: 'language-text', 'data-block': true },
        'refactor(chat): simplify composer\n\n- Keep only Stop\n'
      )
    )

    expect(html).toContain('ds-plain-text-block')
    expect(html).toContain('refactor(chat): simplify composer')
    expect(html).toContain('- Keep only Stop')
    expect(html).not.toContain('ds-code-block-header')
    expect(html).not.toContain('Download code')
    expect(html).not.toContain('Copy code')
  })

  it('hides empty plain text fenced blocks', () => {
    const html = renderToStaticMarkup(
      createElement(
        StreamdownCode,
        { className: 'language-text', 'data-block': true },
        '\n'
      )
    )

    expect(html).toBe('')
  })

  it('routes Mermaid fences to the diagram renderer', () => {
    const html = renderToStaticMarkup(
      createElement(
        StreamdownCode,
        { className: 'language-mermaid', 'data-block': true },
        'flowchart LR\n  A[材料] --> B[审查]\n'
      )
    )

    expect(html).toContain('data-streamdown="mermaid-block"')
    expect(html).toContain('流程图')
    expect(html).not.toContain('ds-code-block-header')
  })

  it('accepts Mermaid aliases and keeps wide diagrams readable', () => {
    expect(isMermaidLanguage('mermaid')).toBe(true)
    expect(isMermaidLanguage('MMD')).toBe(true)
    expect(isMermaidLanguage('text')).toBe(false)
    expect(diagramWidthFromSvg('<svg viewBox="0 0 1800 300"></svg>')).toBe(1800)
    expect(diagramWidthFromSvg('<svg viewBox="0 0 320 180"></svg>')).toBe(560)
    expect(diagramWidthFromSvg('<svg></svg>')).toBe(560)
  })

  it('recognizes Mermaid source even when a model mislabels the fence as text', () => {
    expect(looksLikeMermaidSource('flowchart LR\n  A --> B')).toBe(true)
    expect(looksLikeMermaidSource('sequenceDiagram\n  A->>B: 审核')).toBe(true)
    expect(looksLikeMermaidSource('普通文本 -> 仍然按普通文本显示')).toBe(false)

    const html = renderToStaticMarkup(
      createElement(
        StreamdownCode,
        { className: 'language-text', 'data-block': true },
        'flowchart LR\n  A[材料] --> B[审查]\n'
      )
    )
    expect(html).toContain('data-streamdown="mermaid-block"')
    expect(html).not.toContain('ds-plain-text-block')
  })

  it('keeps CJK Mermaid labels from being clipped by their SVG viewport', () => {
    const svg = [
      '<svg>',
      '<foreignObject width="96"><div><span>智能驾驶事故</span></div></foreignObject>',
      '<foreignObject overflow="hidden" width="200"><div>需要技术鉴定</div></foreignObject>',
      '</svg>'
    ].join('')
    const visible = ensureMermaidLabelVisibility(svg)

    expect(visible.match(/overflow="visible"/g)).toHaveLength(2)
    expect(visible).not.toContain('overflow="hidden"')
    expect(visible).toContain('智能驾驶事故')
    expect(visible).toContain('需要技术鉴定')
  })
})
