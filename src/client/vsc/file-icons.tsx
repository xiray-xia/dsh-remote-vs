/**
 * Coloured file-type / folder icons for the remote DIRECTORY TREE
 * (`RemoteExplorer`), so a remote folder looks like the local sidebar's folder.
 *
 * Scope: the tree only. Search hits, SCM rows, commit panes and download rows
 * keep the neutral outline glyphs from `kit.tsx` — this set is deliberately not
 * the fallback of `FileIcon` / `FolderIcon`.
 *
 * Provenance
 * ----------
 * These are a straight port of the local sidebar plugin's artwork (`FileTypeIcon`
 * and its amber `FolderIcon` in dsh-sidebar's `src/client/icons.tsx`, package
 * name `dsh-sidebar`): one paper sheet whose colour and bottom-right mark carry
 * the type — TS blue + `<>`, JS yellow + `<>`, Python blue with a yellow mark,
 * Markdown blue + lines, images purple + a mountain, archives yellow + a zip,
 * `.gitignore` orange + a commit graph.
 *
 * The copy exists on purpose: the client bundle may not import another plugin's
 * values (tsdown's purity gate rejects cross-plugin imports), and dsh-sidebar
 * publishes no `fileIcon` / `folderIcon` service that `kit.tsx` could call.
 * `kit.tsx` still prefers such a service if a host ever provides one (the
 * better-sidebar lineage is where that contract would come from); this set is
 * the fallback that paints a real, typed tree in a dsh-sidebar profile.
 *
 * One deliberate difference from the source: the image mark used
 * `fill="currentColor"`, which in a tree inherits the row's dim text colour —
 * `.rvs-node-icon` sets `color: var(--rvs-fg3)` — so the mountain would render
 * grey on the purple sheet. Here the mark group pins `color` to the type colour
 * and the artwork stays the colour the palette intends.
 */
import type { ReactNode } from 'react'

/** File paper outline (shared by every file-type icon). */
const SHEET = 'M4 1.4h5.4l3.6 3.6v9.4c0 .5-.4.9-.9.9H3.1a.9.9 0 0 1-.9-.9V2.3c0-.5.4-.9.9-.9Z'
/** Top-right fold. */
const SHEET_FOLD = 'M9.4 1.4v3.6h3.6'

/** The bottom-right mark that carries the category (drawn in the type colour). */
type FileMark =
  | 'code' | 'markup' | 'style' | 'data' | 'doc' | 'image'
  | 'archive' | 'shell' | 'config' | 'git' | 'lock' | 'box' | 'table'

/** How one file type looks: sheet colour + category mark + optional mark colour. */
export interface FileLook {
  color: string
  mark: FileMark
  /** Mark colour; defaults to the sheet colour (Python = blue sheet + yellow mark). */
  markColor?: string
}

/** Extension → look. Brand colours are tuned for readability on dark and light. */
const BY_EXT: Readonly<Record<string, FileLook>> = {  ts: { color: '#519aba', mark: 'code' },
  mts: { color: '#519aba', mark: 'code' },
  cts: { color: '#519aba', mark: 'code' },
  tsx: { color: '#4fc3f7', mark: 'code' },
  js: { color: '#d5c93f', mark: 'code' },
  mjs: { color: '#d5c93f', mark: 'code' },
  cjs: { color: '#d5c93f', mark: 'code' },
  jsx: { color: '#4fc3f7', mark: 'code' },
  json: { color: '#d2b13a', mark: 'data' },
  jsonc: { color: '#d2b13a', mark: 'data' },
  json5: { color: '#d2b13a', mark: 'data' },
  md: { color: '#4b9fe3', mark: 'doc' },
  markdown: { color: '#4b9fe3', mark: 'doc' },
  mdx: { color: '#4b9fe3', mark: 'doc' },
  py: { color: '#3572a5', mark: 'code', markColor: '#ffd75e' },
  pyi: { color: '#3572a5', mark: 'code', markColor: '#ffd75e' },
  java: { color: '#e05a4f', mark: 'code' },
  kt: { color: '#a97bff', mark: 'code' },
  c: { color: '#7f9bd6', mark: 'code' },
  h: { color: '#a074c4', mark: 'code' },
  cpp: { color: '#6295cb', mark: 'code' },
  cc: { color: '#6295cb', mark: 'code' },
  cxx: { color: '#6295cb', mark: 'code' },
  hpp: { color: '#6295cb', mark: 'code' },
  hh: { color: '#6295cb', mark: 'code' },
  cs: { color: '#b878d8', mark: 'code' },
  go: { color: '#00add8', mark: 'code' },
  rs: { color: '#dea584', mark: 'code' },
  php: { color: '#8b9be8', mark: 'code' },
  rb: { color: '#e05a4f', mark: 'code' },
  swift: { color: '#e8743b', mark: 'code' },
  lua: { color: '#5a8fe0', mark: 'code' },
  html: { color: '#e8743b', mark: 'markup' },
  htm: { color: '#e8743b', mark: 'markup' },
  vue: { color: '#41b883', mark: 'markup' },
  svelte: { color: '#ff5c33', mark: 'markup' },
  xml: { color: '#f19a38', mark: 'markup' },
  xsl: { color: '#f19a38', mark: 'markup' },
  css: { color: '#42a5f5', mark: 'style' },
  scss: { color: '#e05a8f', mark: 'style' },
  sass: { color: '#e05a8f', mark: 'style' },
  less: { color: '#42a5f5', mark: 'style' },
  yaml: { color: '#a074c4', mark: 'data' },
  yml: { color: '#a074c4', mark: 'data' },
  toml: { color: '#b08b6a', mark: 'config' },
  ini: { color: '#b08b6a', mark: 'config' },
  conf: { color: '#b08b6a', mark: 'config' },
  cfg: { color: '#b08b6a', mark: 'config' },
  env: { color: '#b08b6a', mark: 'config' },
  sh: { color: '#4ec9b0', mark: 'shell' },
  bash: { color: '#4ec9b0', mark: 'shell' },
  zsh: { color: '#4ec9b0', mark: 'shell' },
  fish: { color: '#4ec9b0', mark: 'shell' },
  ps1: { color: '#4ec9b0', mark: 'shell' },
  psm1: { color: '#4ec9b0', mark: 'shell' },
  bat: { color: '#4ec9b0', mark: 'shell' },
  cmd: { color: '#4ec9b0', mark: 'shell' },
  txt: { color: '#9aa0a6', mark: 'doc' },
  log: { color: '#9aa0a6', mark: 'doc' },
  csv: { color: '#7fb36b', mark: 'table' },
  tsv: { color: '#7fb36b', mark: 'table' },
  xlsx: { color: '#7fb36b', mark: 'table' },
  png: { color: '#b18adf', mark: 'image' },
  jpg: { color: '#b18adf', mark: 'image' },
  jpeg: { color: '#b18adf', mark: 'image' },
  gif: { color: '#b18adf', mark: 'image' },
  webp: { color: '#b18adf', mark: 'image' },
  bmp: { color: '#b18adf', mark: 'image' },
  ico: { color: '#b18adf', mark: 'image' },
  avif: { color: '#b18adf', mark: 'image' },
  svg: { color: '#b18adf', mark: 'image' },
  pdf: { color: '#d94f4f', mark: 'doc' },
  zip: { color: '#d9b64a', mark: 'archive' },
  rar: { color: '#d9b64a', mark: 'archive' },
  '7z': { color: '#d9b64a', mark: 'archive' },
  tar: { color: '#d9b64a', mark: 'archive' },
  gz: { color: '#d9b64a', mark: 'archive' },
  tgz: { color: '#d9b64a', mark: 'archive' },
  bz2: { color: '#d9b64a', mark: 'archive' },
  xz: { color: '#d9b64a', mark: 'archive' },
  lock: { color: '#8b949e', mark: 'lock' },
  dockerfile: { color: '#2496ed', mark: 'box' },
  docker: { color: '#2496ed', mark: 'box' },
  // `demo.gitignore` / `x.gitattributes` derive from the dot-file convention and
  // take the orange branch mark here; the plain names are in BY_NAME.
  gitignore: { color: '#e8703a', mark: 'git' },
  gitattributes: { color: '#e8703a', mark: 'git' },
  gitmodules: { color: '#e8703a', mark: 'git' },
  exe: { color: '#8b949e', mark: 'box' },
  dll: { color: '#8b949e', mark: 'box' },
  so: { color: '#8b949e', mark: 'box' },
  dylib: { color: '#8b949e', mark: 'box' },
}

/** Exact file name → look (extension-less files and conventional names hit here first). */
const BY_NAME: Readonly<Record<string, FileLook>> = {
  dockerfile: { color: '#2496ed', mark: 'box' },
  'docker-compose.yml': { color: '#2496ed', mark: 'box' },
  'docker-compose.yaml': { color: '#2496ed', mark: 'box' },
  makefile: { color: '#b08b6a', mark: 'config' },
  gnumakefile: { color: '#b08b6a', mark: 'config' },
  'cmakelists.txt': { color: '#b08b6a', mark: 'config' },
  '.gitignore': { color: '#e8703a', mark: 'git' },
  '.gitattributes': { color: '#e8703a', mark: 'git' },
  '.gitmodules': { color: '#e8703a', mark: 'git' },
  '.npmrc': { color: '#b08b6a', mark: 'config' },
  '.editorconfig': { color: '#b08b6a', mark: 'config' },
  '.prettierrc': { color: '#b08b6a', mark: 'config' },
  'package-lock.json': { color: '#8b949e', mark: 'lock' },
  'pnpm-lock.yaml': { color: '#8b949e', mark: 'lock' },
  'yarn.lock': { color: '#8b949e', mark: 'lock' },
  license: { color: '#9aa0a6', mark: 'doc' },
  readme: { color: '#4b9fe3', mark: 'doc' },
}

/** Unrecognised file: grey document. */
const FALLBACK: FileLook = { color: '#8b949e', mark: 'doc' }

/**
 * The extension / exact-name tables, exposed read-only for the gate's full-table
 * snapshot: one changed hex or mark must turn `scripts/check-file-icons.mjs`
 * red, instead of shipping a silently different palette.
 *
 * `baseName` stays private on purpose — `kit.tsx` already exports a `baseName`
 * with different semantics (POSIX only, strips a trailing slash), and exporting
 * both invites the wrong import.
 */
export const FILE_TYPE_LOOKS: Readonly<Record<string, FileLook>> = BY_EXT
export const FILE_NAME_LOOKS: Readonly<Record<string, FileLook>> = BY_NAME

/** Drawing commands for a category mark (coordinates sit on the sheet's lower half). */
const MARKS: Readonly<Record<FileMark, ReactNode>> = {
  code: (
    <>
      <path d="M6.4 7.8 5 9.6l1.4 1.8" />
      <path d="M9.6 7.8 11 9.6l-1.4 1.8" />
    </>
  ),
  markup: (
    <>
      <path d="M5.8 7.9 4.4 9.8l1.4 1.9" />
      <path d="M8.6 7.5l-1.6 4.6" />
      <path d="M10.2 7.9l1.4 1.9-1.4 1.9" />
    </>
  ),
  style: (
    <>
      <path d="M7.1 7.6 6.3 12M9.7 7.6l-.8 4.4" />
      <path d="M5.5 9h4.9M5.3 10.6h4.9" />
    </>
  ),
  data: (
    <>
      <path d="M7.1 7.4c-.9 0-.9.7-.9 1.3s0 1.2-.9 1.2c.9 0 .9.6.9 1.2s0 1.3.9 1.3" />
      <path d="M8.9 7.4c.9 0 .9.7.9 1.3s0 1.2.9 1.2c-.9 0-.9.6-.9 1.2s0 1.3-.9 1.3" />
    </>
  ),
  doc: <path d="M5.2 7.8h5.6M5.2 9.7h5.6M5.2 11.6h3.6" />,
  image: (
    <>
      <circle cx="6.4" cy="8.1" r=".85" fill="currentColor" stroke="none" />
      <path d="M4.8 12.2l2.1-2.6 1.5 1.7 1.2-1.3 1.8 2.2Z" fill="currentColor" stroke="none" />
    </>
  ),
  archive: (
    <>
      <path d="M4.8 7.6h6.4v4.6H4.8z" />
      <path d="M4.8 9h6.4" />
      <path d="M7.2 7.6v1.4M7.2 10.4h1.6" />
    </>
  ),
  shell: (
    <>
      <path d="M5.2 8.2 6.9 9.8l-1.7 1.6" />
      <path d="M8.3 11.4h2.7" />
    </>
  ),
  config: (
    <>
      <path d="M5 8.2h6M5 11h6" />
      <circle cx="7" cy="8.2" r="1.05" />
      <circle cx="9.4" cy="11" r="1.05" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="7.7" r="1" />
      <circle cx="9.8" cy="10.9" r="1" />
      <path d="M6 8.7v1.3M9.8 8.6c0 1.4-3.8 1.3-3.8 2.3" />
    </>
  ),
  lock: (
    <>
      <rect x="5.4" y="8.6" width="5.2" height="3.8" rx="1" />
      <path d="M6.6 8.6V7.4a1.4 1.4 0 0 1 2.8 0v1.2" />
    </>
  ),
  box: (
    <>
      <path d="M4.6 8.4h2v1.8h-2zM6.9 8.4h2v1.8h-2zM6.9 10.5h2v1.8h-2zM4.6 12.6h6.8" />
    </>
  ),
  table: (
    <>
      <path d="M4.8 7.6h6.4v4.6H4.8z" />
      <path d="M4.8 9.1h6.4M4.8 10.7h6.4M7.5 7.6v4.6" />
    </>
  ),
}

/** Basename of a path that may use either separator. */
function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** Resolve a path's look from its name / extension. */
export function lookOf(path: string): FileLook {
  const name = baseName(path).toLowerCase()
  const named = BY_NAME[name]
  if (named !== undefined) return named
  if (name.startsWith('.env')) return { color: '#b08b6a', mark: 'config' }
  const dot = name.lastIndexOf('.')
  // dot === 0 is a dot-file such as `.bashrc` with no extension: fall through.
  if (dot <= 0) return FALLBACK
  return BY_EXT[name.slice(dot + 1)] ?? FALLBACK
}

/** Props for {@link FileTypeIcon} / {@link FolderGlyph}. */
export interface FileIconProps {
  /** Workspace-relative path (any separator); only the basename is read. */
  path: string
  /** Edge length in px, default 16. */
  size?: number
  className?: string
}

/**
 * Coloured file-type icon: sheet + top-right fold + bottom-right category mark.
 *
 * At 16 px this reads better than two-letter badges and does not depend on font
 * rendering.
 */
export function FileTypeIcon(props: FileIconProps): ReactNode {
  const size = props.size ?? 16
  const look = lookOf(props.path)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={props.className}
      aria-hidden="true"
    >
      <path
        d={SHEET}
        fill={look.color}
        fillOpacity={0.14}
        stroke={look.color}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <path d={SHEET_FOLD} stroke={look.color} strokeWidth={1} strokeLinejoin="round" />
      <g
        stroke={look.markColor ?? look.color}
        strokeWidth={1.15}
        strokeLinecap="round"
        strokeLinejoin="round"
        // Pins currentColor for the image mark to the type colour: the tree row
        // sets a dim text colour that would otherwise grey the mountain out.
        style={{ color: look.markColor ?? look.color }}
      >
        {MARKS[look.mark]}
      </g>
    </svg>
  )
}

/** Every extension the file-type icon recognises (reporting / gate). */
export const FILE_TYPE_EXTENSIONS: readonly string[] = Object.keys(BY_EXT).sort()

/** Props for the amber folder glyph. */
export interface FolderGlyphProps {
  /** Expanded: the front flap drops down and reveals the inner sheet (VSCode-like). */
  open?: boolean
  /** Edge length in px, default 16. */
  size?: number
  className?: string
}

/**
 * Amber folder icon. The folder colour is content colour, in the same scheme as
 * the file types — it does not follow the skin.
 */
export function FolderGlyph(props: FolderGlyphProps): ReactNode {
  const size = props.size ?? 16
  return props.open === true
    ? (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={props.className} aria-hidden="true">
        <path
          d="M1.9 12V4.3c0-.6.4-1 1-1h3.2l1.5 1.7h5.6c.6 0 1 .4 1 1v5.4"
          fill="#c69a3f"
          stroke="#a8781c"
          strokeWidth=".9"
          strokeLinejoin="round"
        />
        <path
          d="M2 12.6 3.5 8c.1-.4.5-.7.9-.7h9.5c.7 0 1.2.7 1 1.4l-1.3 3.8c-.1.4-.5.7-.9.7H2.9c-.6 0-1-.5-.9-1.1Z"
          fill="#e7b95d"
          stroke="#a8781c"
          strokeWidth=".9"
          strokeLinejoin="round"
        />
      </svg>
    )
    : (
      <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={props.className} aria-hidden="true">
        <path
          d="M1.9 12.3V4.2c0-.6.4-1 1-1h3.2l1.5 1.7h5.6c.6 0 1 .4 1 1v6.4c0 .6-.4 1-1 1H2.9c-.6 0-1-.4-1-1Z"
          fill="#d9ab4e"
          stroke="#a8781c"
          strokeWidth=".9"
          strokeLinejoin="round"
        />
        <path d="M2.6 5.3h10.8" stroke="#a8781c" strokeWidth=".9" opacity=".45" />
      </svg>
    )
}
