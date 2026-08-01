import type { ReactElement } from 'react'
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation
} from 'lucide-react'

const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg']
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv']
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'heic', 'heif']
const ARCHIVE_EXTENSIONS = ['zip', 'rar', '7z']
const CODE_EXTENSIONS = ['json', 'jsonl', 'ts', 'tsx', 'js', 'jsx', 'py', 'html', 'css', 'xml', 'yaml', 'yml', 'sh', 'go', 'rs', 'java', 'c', 'cpp']

export function fileTypeLabel(name: string): string {
  const dotIndex = name.lastIndexOf('.')
  const ext = dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : ''
  if (!ext) return '文件'
  if (ext === 'doc' || ext === 'docx') return 'WORD'
  if (ext === 'ppt' || ext === 'pptx') return 'PPT'
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'EXCEL'
  if (ext === 'pdf') return 'PDF'
  if (AUDIO_EXTENSIONS.includes(ext)) return '音频'
  if (ARCHIVE_EXTENSIONS.includes(ext)) return '压缩包'
  if (IMAGE_EXTENSIONS.includes(ext)) return '图片'
  if (['txt', 'md', 'markdown', ...CODE_EXTENSIONS, 'tsv'].includes(ext)) return '文本'
  return ext.toUpperCase()
}

export function fileTypeBadgeClass(label: string): string {
  const map: Record<string, string> = {
    WORD: 'bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-500/15 dark:text-blue-400 dark:border-blue-500/20',
    PPT: 'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-500/15 dark:text-amber-400 dark:border-amber-500/20',
    EXCEL: 'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/20',
    PDF: 'bg-red-50 text-red-700 border-red-100 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/20',
    音频: 'bg-cyan-50 text-cyan-700 border-cyan-100 dark:bg-cyan-500/15 dark:text-cyan-400 dark:border-cyan-500/20',
    压缩包: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/15 dark:text-slate-400 dark:border-slate-500/20',
    图片: 'bg-purple-50 text-purple-700 border-purple-100 dark:bg-purple-500/15 dark:text-purple-400 dark:border-purple-500/20',
    文本: 'bg-slate-50 text-slate-600 border-slate-100 dark:bg-slate-500/15 dark:text-slate-400 dark:border-slate-500/20'
  }
  return map[label] || 'bg-slate-50 text-slate-600 border-slate-100 dark:bg-slate-500/15 dark:text-slate-400 dark:border-slate-500/20'
}

export function FileTypeIcon({ name, className = 'h-4 w-4' }: { name: string; className?: string }): ReactElement {
  const dotIndex = name.lastIndexOf('.')
  const ext = dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : ''
  if (AUDIO_EXTENSIONS.includes(ext)) {
    return <FileAudio className={`${className} text-cyan-500`} strokeWidth={1.7} />
  }
  if (ext === 'doc' || ext === 'docx') {
    return <FileText className={`${className} text-blue-500`} strokeWidth={1.6} />
  }
  if (ext === 'pdf') {
    return <FileText className={`${className} text-red-500`} strokeWidth={1.6} />
  }
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') {
    return <FileSpreadsheet className={`${className} text-emerald-500`} strokeWidth={1.6} />
  }
  if (ext === 'ppt' || ext === 'pptx') {
    return <Presentation className={`${className} text-amber-500`} strokeWidth={1.6} />
  }
  if (ARCHIVE_EXTENSIONS.includes(ext)) {
    return <FileArchive className={`${className} text-amber-500`} strokeWidth={1.6} />
  }
  if (IMAGE_EXTENSIONS.includes(ext)) {
    return <FileImage className={`${className} text-purple-500`} strokeWidth={1.6} />
  }
  if (VIDEO_EXTENSIONS.includes(ext)) {
    return <FileVideo className={`${className} text-fuchsia-500`} strokeWidth={1.6} />
  }
  if (ext === 'txt' || ext === 'md' || ext === 'markdown') {
    return <FileText className={`${className} text-slate-400`} strokeWidth={1.6} />
  }
  if (CODE_EXTENSIONS.includes(ext)) {
    return <FileCode2 className={`${className} text-indigo-500`} strokeWidth={1.6} />
  }
  return <FileIcon className={`${className} text-slate-300`} strokeWidth={1.6} />
}
