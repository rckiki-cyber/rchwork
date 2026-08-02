import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StreamdownCode } from './StreamdownCode'
import {
  adaptiveFontSize,
  diagramWidthFromSvg,
  ensureMermaidLabelVisibility,
  expandSvgViewBox,
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
    // Short diagrams keep their natural width instead of being blown up.
    expect(diagramWidthFromSvg('<svg viewBox="0 0 320 180"></svg>')).toBe(320)
    // Only a truly tiny diagram is raised to the readability floor.
    expect(diagramWidthFromSvg('<svg viewBox="0 0 150 100"></svg>')).toBe(240)
    expect(diagramWidthFromSvg('<svg></svg>')).toBe(240)
  })

  it('shrinks the base font as the amount of label text grows', () => {
    expect(adaptiveFontSize('flowchart LR\n  A[是] --> B[否]\n')).toBe(15)
    expect(
      adaptiveFontSize(
        'flowchart TD\n  A[当事人向法院申请强制执行] --> B[法院审查执行依据是否生效]\n' +
          '  B -->|具备| C[立案并发出执行通知]\n  B -->|不具备| D[裁定驳回并告知救济途径]\n'
      )
    ).toBeLessThan(15)
    const heavy = [
      'flowchart TD',
      ...Array.from({ length: 30 }, (_, i) => `  N${i}[第${i}步 依次核对合同条款、证据材料、管辖约定并登记入册] --> N${i + 1}[对异议事项进行复核与补证]`),
      '  N30[出具最终结论]'
    ].join('\n')
    expect(adaptiveFontSize(heavy)).toBe(12)
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

  it('widens the viewBox symmetrically without rescaling the content', () => {
    const padded = expandSvgViewBox('<svg viewBox="0 0 300 200"></svg>')
    // padX = max(20, 300*0.05) = 20; padY = max(20, 200*0.05) = 20
    expect(padded).toContain('viewBox="-20 -20 340 240"')
    // the width reported to the viewport now includes the padding
    expect(diagramWidthFromSvg(padded)).toBe(340)
  })

  it('leaves malformed SVGs untouched', () => {
    expect(expandSvgViewBox('<svg></svg>')).toBe('<svg></svg>')
    expect(expandSvgViewBox('<svg viewBox="abc"></svg>')).toBe('<svg viewBox="abc"></svg>')
  })
})
