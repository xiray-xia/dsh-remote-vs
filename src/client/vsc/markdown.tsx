/**
 * Minimal, dependency-free Markdown renderer for the remote preview pane.
 *
 * It renders React elements directly (never `dangerouslySetInnerHTML`), so raw
 * HTML in a remote document stays inert text. Coverage is the subset that
 * matters when reading a repository file: headings, fenced and inline code,
 * lists, blockquotes, rules, GFM tables, links, bold / italic / strike.
 */
import { createElement, type ReactNode } from 'react'

/** Inline formatting: code spans, links, bold, italic, strike. */
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))/g
  let last = 0
  let index = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyBase}-i${index++}`
    if (token.startsWith('`')) {
      nodes.push(createElement('code', { key }, token.slice(1, -1)))
    } else if (token.startsWith('**') || token.startsWith('__')) {
      nodes.push(createElement('strong', { key }, token.slice(2, -2)))
    } else if (token.startsWith('~~')) {
      nodes.push(createElement('del', { key }, token.slice(2, -2)))
    } else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      const label = token.slice(1, split)
      const href = token.slice(split + 2, -1)
      nodes.push(createElement('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, label))
    } else {
      nodes.push(createElement('em', { key }, token.slice(1, -1)))
    }
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** Split one table row into cells. */
function cells(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim())
}

/** Render a whole document. */
export function renderMarkdown(text: string): ReactNode {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  let key = 0
  const nextKey = (): string => `md-${key++}`

  while (i < lines.length) {
    const line = lines[i] as string

    // Fenced code.
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line)
    if (fence !== null) {
      const marker = fence[1] as string
      const body: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] as string).trimStart().startsWith(marker)) {
        body.push(lines[i] as string)
        i += 1
      }
      i += 1
      out.push(createElement('pre', { key: nextKey() }, createElement('code', null, body.join('\n'))))
      continue
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null) {
      const level = Math.min(6, (heading[1] as string).length)
      out.push(createElement(`h${level}`, { key: nextKey() }, inline(heading[2] as string, nextKey())))
      i += 1
      continue
    }

    // Horizontal rule.
    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line) && line.replace(/[\s\-*_]/g, '') === '') {
      out.push(createElement('hr', { key: nextKey() }))
      i += 1
      continue
    }

    // Table (header row + separator).
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] as string)) {
      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && (lines[i] as string).includes('|') && (lines[i] as string).trim() !== '') {
        rows.push(cells(lines[i] as string))
        i += 1
      }
      out.push(createElement('table', { key: nextKey() },
        createElement('thead', null,
          createElement('tr', null, head.map((cell, index) => createElement('th', { key: index }, inline(cell, nextKey()))))),
        createElement('tbody', null, rows.map((row, rowIndex) => createElement('tr', { key: rowIndex },
          row.map((cell, cellIndex) => createElement('td', { key: cellIndex }, inline(cell, nextKey()))))))))
      continue
    }

    // Blockquote.
    if (/^\s*>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i] as string)) {
        body.push((lines[i] as string).replace(/^\s*>\s?/, ''))
        i += 1
      }
      out.push(createElement('blockquote', { key: nextKey() }, renderMarkdown(body.join('\n'))))
      continue
    }

    // Lists.
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listMatch !== null) {
      const ordered = /^\d/.test(listMatch[2] as string)
      const items: string[] = []
      while (i < lines.length) {
        const current = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i] as string)
        if (current === null) break
        items.push(current[3] as string)
        i += 1
      }
      out.push(createElement(ordered ? 'ol' : 'ul', { key: nextKey() },
        items.map((item, index) => createElement('li', { key: index }, inline(item, nextKey())))))
      continue
    }

    // Blank line.
    if (line.trim() === '') {
      i += 1
      continue
    }

    // Paragraph: consume until a blank line or another block starter.
    const paragraph: string[] = [line]
    i += 1
    while (i < lines.length) {
      const current = lines[i] as string
      if (current.trim() === '') break
      if (/^(#{1,6})\s/.test(current) || /^\s*(```|~~~)/.test(current) || /^\s*>/.test(current)) break
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(current)) break
      paragraph.push(current)
      i += 1
    }
    out.push(createElement('p', { key: nextKey() }, inline(paragraph.join(' '), nextKey())))
  }

  return createElement('div', { className: 'rvs-markdown' }, out)
}
