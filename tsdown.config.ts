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
import { dirname, relative, resolve as resolvePath } from 'node:path'
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

/** Compact local-time build stamp (MMDD-HHmm) injected as __RVS_BUILD__. */
function buildStamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

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
      // The VIRTUAL ID is package-relative too: rolldown emits it into
      // `//#region` comments in the bundle, so an absolute id leaks the build
      // machine's path just like the style key used to (0.11.0 audit).
      const rel = relative(process.cwd(), abs).replace(/\\/g, '/')
      return CSS_VIRTUAL_PREFIX + rel + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const relId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const fileId = resolvePath(process.cwd(), relId)
      this.addWatchFile(fileId)
      const css = await readFile(fileId, 'utf8')
      // One <style> per SOURCE FILE, keyed by its PACKAGE-RELATIVE path.
      //
      // A single shared marker looked equivalent and was not: the first sheet the
      // factory executed (vsc.css, imported by the entry) inserted its tag, and
      // every later sheet then found that marker and skipped its own injection —
      // so the change panel's stylesheet never reached the page and its rows
      // rendered as bare inline buttons.
      //
      // The key must be relative, not the absolute build-machine path: shipping
      // `E:\work_base\...\vsc.css` inside the public bundle leaked the builder's
      // directory layout (found by the release audit; fixed in 0.11.0). A
      // package-relative spelling is also identical on every machine, so two
      // builds of the same file dedupe correctly in the page.
      const relKey = relId
      return [
        `const css = ${JSON.stringify(css)};`,
        `const key = ${JSON.stringify(relKey)};`,
        `const injected = typeof document === 'undefined' ? undefined : Array.prototype.find.call(`,
        `  document.querySelectorAll('style[data-rvs-css]'),`,
        `  (tag) => tag.dataset.rvsCss === key,`,
        `);`,
        `if (typeof document !== 'undefined' && injected === undefined) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.rvsCss = key;`,
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
    /**
     * ssh2 is BUNDLED here, not installed as a dependency.
     *
     * pnpm 12 refuses an install while ANY package in the tree carries a
     * lifecycle script it has not been allowed to run: ssh2 has
     * `install: node install.js` and drags in the optional native
     * `cpu-features`, so `dsh plugin --profile web add github:…` failed with
     * `ERR_PNPM_IGNORED_BUILDS` until the user approved both by hand in the
     * profile's `pnpm-workspace.yaml`. Measured: with ssh2 out of the tree and
     * `lib/` committed, the same command completes with no `allowBuilds` entry
     * at all. The install cannot be fixed from the dependency side —
     * `dependenciesMeta: { built: false }` is ignored and `allowBuilds` is only
     * read from the installing workspace.
     *
     * Both native requires inside ssh2 are already optional upstream
     * (`try { require('cpu-features')() } catch {}` in `constants.js`,
     * `try { require('./crypto/build/Release/sshcrypto.node') } catch {}` in
     * `protocol/crypto.js`, and its `install.js` exits 0 when the build fails),
     * so the pure-JS crypto path is what ships. They stay external so the
     * bundler does not try to resolve artifacts that are never built here.
     */
    noExternal: ['ssh2'],
    external: ['cpu-features', /sshcrypto\.node$/],
    /**
     * ssh2's CJS sources read `__dirname` at module scope (`agent.js` resolves
     * its bundled `util/pagent.exe`), which does not exist in an ESM bundle —
     * importing the host half threw `ReferenceError: __dirname is not defined`
     * before this was on. Measured with `.spike/ssh2-smoke.mjs`, which drives a
     * real host through the bundled copy.
     */
    shims: true,
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
      // Baked at build time and shown in the editor info bar. The GUI serves
      // plugin bundles captured when `dsh web` started (immutable revisions,
      // refreshed only by the dev HMR watch), so a stale bundle is otherwise
      // indistinguishable from broken code — this stamp settles it at a glance.
      __RVS_BUILD__: JSON.stringify(buildStamp()),
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
