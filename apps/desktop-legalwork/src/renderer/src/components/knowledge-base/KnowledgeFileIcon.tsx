import type { ReactElement } from 'react'
import type { KnowledgeTreeNode } from './types'

type FileVisual = {
  accent: string
  label: string
  symbol: 'folder' | 'pdf' | 'word' | 'ppt' | 'excel' | 'txt' | 'markdown' | 'audio' | 'archive' | 'generic'
}

const FILE_VISUALS: Record<string, FileVisual> = {
  pdf: { accent: '#ff5a52', label: 'PDF', symbol: 'pdf' },
  doc: { accent: '#3478f6', label: 'WORD', symbol: 'word' },
  docx: { accent: '#3478f6', label: 'WORD', symbol: 'word' },
  ppt: { accent: '#f26a35', label: 'PPT', symbol: 'ppt' },
  pptx: { accent: '#f26a35', label: 'PPT', symbol: 'ppt' },
  xls: { accent: '#28a45f', label: 'EXCEL', symbol: 'excel' },
  xlsx: { accent: '#28a45f', label: 'EXCEL', symbol: 'excel' },
  csv: { accent: '#28a45f', label: 'CSV', symbol: 'excel' },
  txt: { accent: '#7d8795', label: 'TXT', symbol: 'txt' },
  md: { accent: '#8b5cf6', label: 'MD', symbol: 'markdown' },
  markdown: { accent: '#8b5cf6', label: 'MD', symbol: 'markdown' },
  mp3: { accent: '#d855a6', label: '音频', symbol: 'audio' },
  m4a: { accent: '#d855a6', label: '音频', symbol: 'audio' },
  wav: { accent: '#d855a6', label: '音频', symbol: 'audio' },
  aac: { accent: '#d855a6', label: '音频', symbol: 'audio' },
  flac: { accent: '#d855a6', label: '音频', symbol: 'audio' },
  ogg: { accent: '#d855a6', label: '音频', symbol: 'audio' },
  zip: { accent: '#b87922', label: 'ZIP', symbol: 'archive' },
  rar: { accent: '#b87922', label: 'RAR', symbol: 'archive' },
  '7z': { accent: '#b87922', label: '7Z', symbol: 'archive' }
}

function nodeExtension(node: KnowledgeTreeNode): string {
  return (node.extension || node.name.split('.').pop() || '').replace(/^\./, '').toLowerCase()
}

export function knowledgeFileVisual(node: KnowledgeTreeNode): FileVisual {
  if (node.kind === 'folder') {
    return { accent: '#4f9cf7', label: '文件夹', symbol: 'folder' }
  }
  const extension = nodeExtension(node)
  return FILE_VISUALS[extension] ?? {
    accent: '#8a93a0',
    label: extension ? extension.toUpperCase() : '文件',
    symbol: 'generic'
  }
}

function FileSymbol({ symbol }: { symbol: FileVisual['symbol'] }): ReactElement {
  if (symbol === 'pdf') {
    return (
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.2 21.4c3.4-1.1 7.2-1.6 11.1-1.4" strokeWidth="1.35" />
        <path d="M12.1 24.3c2.4-4.1 4-8.4 4.2-12.8.1-1.8-1.6-2.1-2-.5-.7 3.1 2.6 8.7 5.6 10.8 1.6 1.1 2.5-.1 1.6-1.2" strokeWidth="1.25" />
      </g>
    )
  }
  if (symbol === 'word') {
    return (
      <g fill="currentColor">
        <rect x="9" y="12.5" width="11.5" height="1.45" rx=".7" />
        <rect x="9" y="16.6" width="9.2" height="1.45" rx=".7" opacity=".82" />
        <rect x="9" y="20.7" width="11.5" height="1.45" rx=".7" opacity=".64" />
      </g>
    )
  }
  if (symbol === 'ppt') {
    return (
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15.4 12.1v6.5h6.4a6.4 6.4 0 0 0-6.4-6.5Z" fill="currentColor" fillOpacity=".24" strokeWidth="1.25" />
        <path d="M13.1 14.4a6.1 6.1 0 1 0 6.2 6.1h-6.2Z" strokeWidth="1.25" />
      </g>
    )
  }
  if (symbol === 'excel') {
    return (
      <g fill="none" stroke="currentColor" strokeWidth="1.15">
        <rect x="9" y="12.2" width="12" height="11.2" rx="1.4" />
        <path d="M13 12.2v11.2M17 12.2v11.2M9 16h12M9 19.7h12" />
      </g>
    )
  }
  if (symbol === 'txt') {
    return (
      <g fill="currentColor">
        <rect x="9" y="12.4" width="12" height="1.35" rx=".65" />
        <rect x="9" y="16.2" width="10" height="1.35" rx=".65" opacity=".78" />
        <rect x="9" y="20" width="11.2" height="1.35" rx=".65" opacity=".56" />
        <rect x="9" y="23.8" width="7.4" height="1.35" rx=".65" opacity=".4" />
      </g>
    )
  }
  if (symbol === 'markdown') {
    return (
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.45">
        <path d="M8.7 22.5v-8.7l3.5 4 3.5-4v8.7" />
        <path d="M19 14v7.6m-2.2-2.3 2.2 2.4 2.2-2.4" />
      </g>
    )
  }
  if (symbol === 'audio') {
    return (
      <g fill="currentColor">
        <rect x="8.5" y="16.8" width="1.6" height="4.4" rx=".8" opacity=".5" />
        <rect x="11.7" y="13.8" width="1.6" height="10.4" rx=".8" opacity=".7" />
        <rect x="14.9" y="11.3" width="1.6" height="15.4" rx=".8" />
        <rect x="18.1" y="14.6" width="1.6" height="8.8" rx=".8" opacity=".72" />
        <rect x="21.3" y="17.1" width="1.6" height="3.8" rx=".8" opacity=".48" />
      </g>
    )
  }
  if (symbol === 'archive') {
    return (
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3">
        <path d="M14.9 10.8v14.4" strokeDasharray="1.5 2.1" />
        <rect x="12.9" y="18.2" width="4" height="4.2" rx="1" fill="currentColor" fillOpacity=".16" />
      </g>
    )
  }
  return (
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25">
      <path d="M9.3 14h8.9M9.3 17.9h11.1M9.3 21.8h8" opacity=".72" />
    </g>
  )
}

export function KnowledgeFileIcon({
  node,
  size = 28
}: {
  node: KnowledgeTreeNode
  size?: number
}): ReactElement {
  const visual = knowledgeFileVisual(node)

  if (visual.symbol === 'folder') {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 34 30"
        width={size + 2}
        height={size}
        className="block shrink-0 drop-shadow-[0_1px_1px_rgba(0,0,0,0.08)]"
        style={{ color: visual.accent }}
      >
        <path
          d="M3.2 8.1A2.6 2.6 0 0 1 5.8 5.5h7.1l2.6 2.7h12.7a2.6 2.6 0 0 1 2.6 2.6v12.4a3 3 0 0 1-3 3H6.2a3 3 0 0 1-3-3Z"
          fill="currentColor"
          fillOpacity=".2"
          stroke="currentColor"
          strokeWidth="1.35"
        />
        <path d="M3.7 10.5h26.6" stroke="currentColor" strokeOpacity=".55" strokeWidth="1.15" />
      </svg>
    )
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 30 40"
      width={Math.round(size * 0.75)}
      height={size}
      className="block shrink-0 drop-shadow-[0_1px_1px_rgba(0,0,0,0.08)]"
      style={{ color: visual.accent }}
    >
      <path
        d="M4.1 2.8h15.6l8.1 8.1V35a1.9 1.9 0 0 1-1.9 1.9H4.1A1.9 1.9 0 0 1 2.2 35V4.7a1.9 1.9 0 0 1 1.9-1.9Z"
        fill="currentColor"
        fillOpacity=".11"
        stroke="currentColor"
        strokeWidth="1.35"
      />
      <path d="M19.7 3v7.9h7.8" fill="currentColor" fillOpacity=".18" stroke="currentColor" strokeWidth="1.1" />
      <g transform="translate(0 2)">
        <FileSymbol symbol={visual.symbol} />
      </g>
    </svg>
  )
}

export function KnowledgeFileTypeBadge({ node }: { node: KnowledgeTreeNode }): ReactElement {
  const visual = knowledgeFileVisual(node)
  return (
    <span
      className="inline-flex min-w-[42px] items-center justify-center rounded-[6px] border px-2 py-[3px] text-[10.5px] font-semibold leading-none"
      style={{
        color: visual.accent,
        borderColor: `color-mix(in srgb, ${visual.accent} 20%, transparent)`,
        background: `color-mix(in srgb, ${visual.accent} 11%, transparent)`
      }}
    >
      {visual.label}
    </span>
  )
}
