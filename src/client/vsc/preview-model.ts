/**
 * Remote document preview classification and table parsing.
 *
 * Pure functions only (no React/DOM/fetch): the editor shell, the preview
 * component and the gate all read the same classification, and CSV/TSV parsing
 * can be tested in Node.
 */
export type PreviewKind =
  | 'text' | 'image' | 'markdown' | 'html' | 'svg' | 'table' | 'pdf' | 'office' | 'media'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif'])

const KIND_BY_EXTENSION: Readonly<Record<string, PreviewKind>> = {
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html', xhtml: 'html',
  csv: 'table', tsv: 'table',
  svg: 'svg',
  pdf: 'pdf',
  // Only the six extensions a LibreOffice/office-kit conversion can actually
  // claim; odt/ods/odp/docm/... fall through to the binary notice instead of a
  // guaranteed conversion error.
  doc: 'office', docx: 'office', ppt: 'office', pptx: 'office', xls: 'office', xlsx: 'office',
  mp3: 'media', wav: 'media', ogg: 'media', oga: 'media', opus: 'media', m4a: 'media',
  aac: 'media', flac: 'media', weba: 'media', mp4: 'media', m4v: 'media', webm: 'media',
  ogv: 'media', mov: 'media',
}

const MEDIA_MIME: Readonly<Record<string, { kind: 'audio' | 'video'; mime: string }>> = {
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  oga: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  weba: { kind: 'audio', mime: 'audio/webm' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  m4v: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  ogv: { kind: 'video', mime: 'video/ogg' },
  mov: { kind: 'video', mime: 'video/quicktime' },
}

export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function previewKindOf(path: string): PreviewKind {
  const ext = extensionOf(path)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return KIND_BY_EXTENSION[ext] ?? 'text'
}

export function isBytePreview(kind: PreviewKind): kind is 'pdf' | 'office' | 'media' {
  return kind === 'pdf' || kind === 'office' || kind === 'media'
}

export function hasTextSource(kind: PreviewKind): boolean {
  return kind === 'markdown' || kind === 'html' || kind === 'svg' || kind === 'table'
}

export function previewKindLabel(kind: PreviewKind): string | undefined {
  const labels: Record<PreviewKind, string | undefined> = {
    text: undefined,
    image: 'Image',
    markdown: 'Markdown',
    html: 'HTML',
    svg: 'SVG',
    table: 'Table',
    pdf: 'PDF',
    office: 'Office',
    media: 'Media',
  }
  return labels[kind]
}

export function mediaTypeOf(path: string): { kind: 'audio' | 'video'; mime: string } | undefined {
  return MEDIA_MIME[extensionOf(path)]
}

export function tableDelimiterOf(path: string): string {
  return extensionOf(path) === 'tsv' ? '\t' : ','
}

export interface TableLimits {
  maxRows: number
  maxColumns: number
  maxCells: number
}

export const DEFAULT_TABLE_LIMITS: TableLimits = {
  maxRows: 5000,
  maxColumns: 512,
  maxCells: 200_000,
}

export interface TableData {
  rows: string[][]
  columns: number
  truncated: boolean
}

/** RFC 4180 parser with explicit row/column/cell bounds. */
export function parseDelimited(
  text: string,
  delimiter: string,
  limits: TableLimits = DEFAULT_TABLE_LIMITS,
): TableData {
  if (limits.maxColumns <= 0 || limits.maxRows <= 0) {
    return { rows: [], columns: 0, truncated: text.trim() !== '' }
  }
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let columns = 0
  let stoppedAt = -1
  let dropped = false
  let touched = false

  const finishField = (): boolean => {
    if (row.length >= limits.maxColumns) return false
    row.push(field)
    field = ''
    touched = true
    return true
  }
  const finishRow = (at: number): boolean => {
    if (!finishField()) {
      if (touched && rows.length < limits.maxRows) {
        if (row.length > columns) columns = row.length
        rows.push(row)
      }
      row = []
      field = ''
      touched = false
      dropped = true
      stoppedAt = at
      return false
    }
    if (!touched || (row.length === 1 && row[0] === '')) {
      row = []
      touched = false
      return true
    }
    if (rows.length >= limits.maxRows) {
      dropped = true
      stoppedAt = at
      return false
    }
    if (rows.length > 0 && (rows.length + 1) * Math.max(columns, row.length) > limits.maxCells) {
      dropped = true
      stoppedAt = at
      return false
    }
    if (row.length > columns) columns = row.length
    rows.push(row)
    row = []
    touched = false
    return true
  }

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] as string
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"' && field === '') {
      quoted = true
      touched = true
      continue
    }
    if (char === delimiter) {
      if (!finishField()) {
        if (touched && rows.length < limits.maxRows) {
          if (row.length > columns) columns = row.length
          rows.push(row)
        }
        row = []
        field = ''
        touched = false
        dropped = true
        stoppedAt = index
        break
      }
      continue
    }
    if (char === '\r') {
      if (source[index + 1] === '\n') index += 1
      if (!finishRow(index)) break
      continue
    }
    if (char === '\n') {
      if (!finishRow(index)) break
      continue
    }
    field += char
    touched = true
  }
  if (stoppedAt === -1 && (touched || field !== '' || row.length > 0)) finishRow(source.length)
  return { rows, columns, truncated: dropped }
}
