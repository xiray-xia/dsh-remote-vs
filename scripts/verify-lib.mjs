/**
 * Loader-entry integrity check for the built plugin.
 *
 * The host loader imports these nine paths from `lib/`; a missing one is
 * `ERR_MODULE_NOT_FOUND` at plugin load, and nothing else in the build
 * reports it — tsc and the bundler both succeed with a partial `lib/`.
 *
 * This is the SINGLE source of truth for that list:
 *   - `prepare` runs it as a build guard, so a partial `lib/` rebuilds
 *     instead of being declared healthy;
 *   - `verify:lib` runs it as an explicit post-build check.
 * The previous guard probed two files while `verify:lib` checked nine, so a
 * `lib/` missing any of the other seven was accepted and shipped broken.
 *
 * Usage:
 *   node scripts/verify-lib.mjs           # report, exit 1 when incomplete
 *   node scripts/verify-lib.mjs --quiet   # exit code only (build guard)
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Every `lib/` path the DSH loader imports for this plugin. */
const LOADER_ENTRIES = [
  'index.js',
  'client.js',
  'p2-bridge.js',
  'p2-bridge-refs.js',
  'p2-router-fs.js',
  'p2-router-subprocess.js',
  'p2-router-spill.js',
  'p2-router-refs.js',
  'p2-shell-bash.js',
]

// Resolved from this file, so the check works from any cwd.
const libDir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'lib')
const missing = LOADER_ENTRIES.filter(name => !existsSync(join(libDir, name)))

if (!process.argv.includes('--quiet')) {
  if (missing.length === 0) {
    console.log(`lib/ complete: ${LOADER_ENTRIES.length} entries`)
  } else {
    console.error(`lib/ INCOMPLETE, missing: ${missing.join(', ')}`)
    console.error('Run `pnpm run build` — the plugin cannot load without these.')
  }
}

process.exit(missing.length === 0 ? 0 : 1)
