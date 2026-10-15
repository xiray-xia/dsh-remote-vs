/**
 * File extension → CodeMirror grammar.
 *
 * Coverage matters more than elegance: a file whose extension is missing here
 * gets NO token stream at all, so CodeMirror renders every line as plain text —
 * which is exactly how a Java file looked when only the JS/PY grammars were
 * installed. The set below follows the languages this plugin's users actually
 * read (Android/APK sources, C/C++ kernels, Go/Rust tools, shell and config
 * files).
 *
 * Living in its own module (not inside `CodeEditor.tsx`) keeps it importable by
 * the self-check harness, which mounts a real editor in a DOM to prove that a
 * file of a given extension ends up with colored tokens.
 */
import { StreamLanguage } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { yaml } from '@codemirror/lang-yaml'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { go } from '@codemirror/lang-go'
import { rust } from '@codemirror/lang-rust'
import { xml } from '@codemirror/lang-xml'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { diff } from '@codemirror/legacy-modes/mode/diff'

/** The extension of a remote path ('' when it has none). */
export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  return name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : name.toLowerCase()
}

/** The grammar extension list for a file path (empty = plain text). */
export function langFor(path: string): Extension[] {
  switch (extensionOf(path)) {
    // web
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return [javascript()]
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return [javascript({ typescript: true })]
    case 'json':
    case 'jsonc':
    case 'json5':
      return [json()]
    case 'md':
    case 'markdown':
      return [markdown()]
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
      return [html()]
    case 'css':
    case 'scss':
    case 'less':
      return [css()]
    case 'xml':
    case 'svg':
    case 'xhtml':
    case 'plist':
      return [xml()]
    // jvm / android
    case 'java':
    case 'aidl':
    case 'smali':
      return [java()]
    case 'gradle':
    case 'kt':
    case 'kts':
      // No Kotlin/Groovy grammar is published; the Java grammar still colors
      // keywords, strings and comments, which beats no highlight at all.
      return [java()]
    // native
    case 'c':
    case 'h':
    case 'cc':
    case 'cpp':
    case 'cxx':
    case 'hpp':
    case 'hh':
    case 'hxx':
    case 'ino':
      return [cpp()]
    case 'go':
      return [go()]
    case 'rs':
      return [rust()]
    // scripting / config
    case 'py':
    case 'pyi':
      return [python()]
    case 'yaml':
    case 'yml':
      return [yaml()]
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'ksh':
      return [StreamLanguage.define(shell)]
    case 'mk':
    case 'makefile':
    case 'bp':
      // Makefiles / Soong blueprints: `#` comments and words, i.e. shell-ish.
      return [StreamLanguage.define(shell)]
    case 'prop':
    case 'rc':
    case 'toml':
    case 'properties':
    case 'ini':
    case 'conf':
    case 'cfg':
    case 'env':
    case 'gitignore':
    case 'dockerignore':
      return [StreamLanguage.define(properties)]
    case 'dockerfile':
      return [StreamLanguage.define(dockerFile)]
    case 'diff':
    case 'patch':
      return [StreamLanguage.define(diff)]
    default:
      return []
  }
}
