/**
 * tsdown build for dsh-remote-vs: host halves (lib/index.js + lib/p2-*.js, ESM
 * node; dependencies and peers stay external) plus the browser client bundle
 * (lib/client.js, CJS closure factory). The client recipe mirrors the official
 * DSH client-bundle preset (see omdsh-dev/DSH-better-sidebar tsdown.config.ts):
 * - externals resolve through the loader module table at runtime,
 * - everything else inlines,
 * - the artifact registers itself via window.__ModuleLoader__.load({id, factory}).
 *
 * Types ship from lib/types (tsc -p tsconfig.build.json), not from tsdown.
 */
import { builtinModules, createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'

const require = createRequire(import.meta.url)

/** Node builtins must never survive into the browser module-loader factory. */
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map(id => `node:${id}`),
])

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

type BuildPlugin = NonNullable<UserConfig['plugins']>

/** Reject Node builtins and cross-plugin value imports in the client bundle. */
function purityGatePlugin(): BuildPlugin {
  return {
    name: 'dsh-remote-vs-client-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) {
        throw new Error(
          `client bundle purity: Node builtin "${source}" cannot run in the browser module table`,
        )
      }
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module — `
        + 'cross-plugin value imports are forbidden (type-only imports are erased and never reach this gate)',
      )
    },
  }
}

/** Virtual-id wrapper keeping plain CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Inline `.css` imports as <style> tags injected at factory execution. */
function cssInlinePlugin(): BuildPlugin {
  return {
    name: 'dsh-remote-vs-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      let abs: string
      if (source.startsWith('.') || source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) {
        abs = importer === undefined ? source : resolvePath(dirname(importer), source)
      } else {
        abs = require.resolve(source)
      }
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const css = await readFile(fileId, 'utf8')
      return [
        `const css = ${JSON.stringify(css)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-rvs-css]') === null) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.rvsCss = '1';`,
        `  tag.textContent = css;`,
        `  document.head.appendChild(tag);`,
        `}`,
        `export default "";`,
      ].join('\n')
    },
  }
}

export default [
  {
    entry: {
      index: 'src/index.ts',
      'p2-bridge': 'src/p2/bridge.ts',
      'p2-bridge-refs': 'src/p2/bridge-refs.ts',
      'p2-router-fs': 'src/p2/router-fs.ts',
      'p2-router-subprocess': 'src/p2/router-subprocess.ts',
      'p2-router-spill': 'src/p2/router-spill.ts',
      'p2-router-refs': 'src/p2/router-refs.ts',
      'p2-shell-bash': 'src/p2/shell-bash.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [purityGatePlugin(), cssInlinePlugin()],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-remote-vs", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
] satisfies UserConfig[]
