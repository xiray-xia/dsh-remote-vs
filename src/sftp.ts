/**
 * Remote file operations over SFTP. Paths are absolute POSIX paths on the
 * remote host; every entry point validates before touching the wire.
 */
import { posix } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { RemotePool } from './pool.ts'
import type { RemoteFileEntry, RemoteRead } from './protocol.ts'

/** Single-read cap (matches the fs-ssh 8 MiB window). */
export const READ_CAP = 8 * 1024 * 1024

/**
 * Hard cap for one directory listing. A pathological directory (a spool, a
 * build cache, someone's 100k-file dump) would otherwise build a single
 * 15-20 MB JSON response in this process — and `JSON.stringify` doubles that
 * peak while it serialises. High enough that no real directory is affected,
 * low enough that one cannot take the host down. The cap keeps explorer order
 * (directories first, then by name), so which entries survive is deterministic.
 */
export const LIST_ENTRY_CAP = 20000

/**
 * Cap for both per-path memory sets below (levels confirmed to exist, listings
 * already reported as truncated). Each only ever saves round trips or a repeat
 * log line, so a small window is enough and a miss costs nothing but the work
 * the code did before them.
 */
const MEMO_CAP = 512

/** SFTP status code for "no such file or directory" (ssh2 sets `error.code`). */
const SFTP_NO_SUCH_FILE = 2

const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFDIR = 0o040000

/** Assert an absolute POSIX remote path and return its normalized form. */
export function remotePath(path: string): string {
  if (typeof path !== 'string' || path === '' || path.includes('\0')) throw new Error('path must be a non-empty string')
  const normalized = posix.normalize(path.replace(/\\/g, '/'))
  if (!normalized.startsWith('/')) throw new Error('remote path must be absolute')
  return normalized
}

export class RemoteFiles {
  /**
   * `alias + level` pairs confirmed to exist on the remote (insertion order,
   * oldest evicted first). Only an optimisation: see ensureDir().
   */
  private readonly knownDirs = new Set<string>()
  /** Listings already reported as truncated; the log line stays one per path. */
  private readonly capWarned = new Set<string>()

  constructor(private readonly pool: RemotePool) {}

  async list(alias: string, dir: string): Promise<RemoteFileEntry[]> {
    const path = remotePath(dir)
    return this.pool.withSftp(alias, async (sftp) => {
      const rows = await readdirAsync(sftp, path)
      const entries = rows
        .map((row) => toEntry(path, row.filename, row.attrs))
        .sort(compareEntries)
      // The wire shape has no "truncated" flag (adding one would change the
      // protocol), so a capped listing is silent to the caller — which is why
      // the host log has to say it, once per directory rather than once per
      // listing (the explorer re-lists a directory on every write).
      if (entries.length > LIST_ENTRY_CAP) {
        const key = `${alias}\u0000${path}`
        if (!this.capWarned.has(key)) {
          this.remember(this.capWarned, key)
          // eslint-disable-next-line no-console
          console.warn(`[dsh-remote-vs] listing ${path} on ${alias} shows ${LIST_ENTRY_CAP} of ${entries.length} entries`)
        }
        return entries.slice(0, LIST_ENTRY_CAP)
      }
      return entries
    })
  }

  async stat(alias: string, file: string): Promise<RemoteFileEntry> {
    const path = remotePath(file)
    return this.pool.withSftp(alias, async (sftp) => {
      const attrs = await lstatAsync(sftp, path)
      return toEntry(posix.dirname(path), posix.basename(path), attrs)
    })
  }

  async read(alias: string, file: string): Promise<RemoteRead> {
    const path = remotePath(file)
    return this.pool.withSftp(alias, async (sftp) => {
      const attrs = await lstatAsync(sftp, path)
      const size = attrs.size
      // A zero-byte file has no window to read, and asking SFTP for zero bytes
      // is NOT a no-op: ssh2's `read()` rejects `off >= buf.length` with a
      // SYNC throw ("offset is out of bounds"), which escapes the promise
      // callback, wedges the HTTP request (endless spinner) and leaves the
      // SFTP session open — repeating it exhausts the server's MaxSessions and
      // makes SSH look dead. Empty is answered from the stat alone.
      if (size <= 0) {
        return { size: 0, binary: false, text: '', truncated: false }
      }
      const window = Math.min(size, READ_CAP)
      const buffer = await readWindow(sftp, path, 0, window)
      const binary = buffer.includes(0)
      return {
        size,
        binary,
        ...(binary ? { base64: buffer.toString('base64') } : { text: buffer.toString('utf8') }),
        truncated: size > READ_CAP,
      }
    })
  }

  async write(alias: string, file: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<{ size: number }> {
    const path = remotePath(file)
    const dir = posix.dirname(path)
    const data = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')
    return this.pool.withSftp(alias, async (sftp) => {
      await this.withDirRetry(alias, dir, async () => {
        await this.ensureDir(sftp, alias, dir)
        // A zero-length SFTP WRITE packet is not universally accepted (SFTPv3
        // leaves it undefined); an empty file is created by opening for
        // truncation and closing again.
        if (data.length === 0) await touchFile(sftp, path)
        else await writeFileAsync(sftp, path, data)
      })
      return { size: data.length }
    })
  }

  async mkdir(alias: string, dir: string): Promise<void> {
    const path = remotePath(dir)
    await this.pool.withSftp(alias, async (sftp) => {
      // Parents may be answered from the memo, but the directory the caller
      // asked for is always really created: "created it" is a promise a stale
      // memo could silently break (the level can be removed outside this
      // plugin), while a redundant mkdir only costs the EEXIST tolerance this
      // walk already had.
      await this.ensureDir(sftp, alias, posix.dirname(path))
      await this.mkdirLevel(sftp, path)
      this.remember(this.knownDirs, dirKey(alias, path))
    })
  }

  async remove(alias: string, target: string, recursive: boolean): Promise<void> {
    const path = remotePath(target)
    if (path === '/') throw new Error('refusing to remove /')
    await this.pool.withSftp(alias, async (sftp) => {
      const attrs = await lstatAsync(sftp, path)
      if (isSymlink(attrs.mode) || !isDir(attrs.mode)) {
        await unlinkAsync(sftp, path)
        return
      }
      if (!recursive) {
        await rmdirAsync(sftp, path)
        return
      }
      await removeTree(sftp, path)
    })
    // Whatever was remembered about this tree is now wrong, and the next mkdir
    // of the same path must not be answered from that memory.
    this.forgetDirs(alias, path)
  }

  async rename(alias: string, oldPath: string, newPath: string): Promise<void> {
    const from = remotePath(oldPath)
    const to = remotePath(newPath)
    const dir = posix.dirname(to)
    await this.pool.withSftp(alias, async (sftp) => {
      await this.withDirRetry(alias, dir, async () => {
        await this.ensureDir(sftp, alias, dir)
        await renameAsync(sftp, from, to)
      })
      // `from` may have been a directory the memo still believes in.
      this.forgetDirs(alias, from)
    })
  }

  // ------------------------------------------------------------- internals

  /**
   * Create every missing level of `dir`.
   *
   * Each level is remembered once it is confirmed (or created): without that, a
   * save walks the whole path with `mkdir` again — typically 4-6 round trips
   * whose answers can only be EEXIST — on every single write. The memo is safe
   * because every caller that could be broken by a stale entry either creates
   * its target for real (mkdir) or retries once after forgetting the prefix
   * (withDirRetry); the operations that make entries stale (remove, rename)
   * forget them outright.
   */
  private async ensureDir(sftp: SFTPWrapper, alias: string, dir: string): Promise<void> {
    if (dir === '/' || dir === '.') return
    const parts = dir.split('/').filter(part => part !== '')
    let current = ''
    for (const part of parts) {
      current += '/' + part
      const key = dirKey(alias, current)
      if (this.knownDirs.has(key)) continue
      await this.mkdirLevel(sftp, current)
      this.remember(this.knownDirs, key)
    }
  }

  /** Create one level, tolerating "already exists" (and verifying the rest). */
  private async mkdirLevel(sftp: SFTPWrapper, path: string): Promise<void> {
    try {
      await mkdirAsync(sftp, path)
    } catch (error) {
      // EEXIST (code 4, "Failure") means the level is already there.
      const code = (error as { code?: number }).code
      if (code !== 4 && code !== undefined) throw error
      if (code === undefined) {
        // Unknown failure: verify by stat before ignoring.
        try {
          await lstatAsync(sftp, path)
        } catch {
          throw error
        }
      }
    }
  }

  /**
   * Run one directory-creating operation, and if it fails because a level the
   * memo vouched for is gone (the user deleted the tree, a cleanup removed the
   * deploy root), forget that path and run it once more so the walk recreates
   * what is missing. Only "no such file" is retried: any other failure is the
   * caller's to see, and a retried operation is safe because it never got past
   * the directory walk.
   */
  private async withDirRetry<T>(alias: string, dir: string, op: () => Promise<T>): Promise<T> {
    try {
      return await op()
    } catch (error) {
      if ((error as { code?: number }).code !== SFTP_NO_SUCH_FILE) throw error
      this.forgetDirs(alias, dir)
      return await op()
    }
  }

  /** Add one key to a bounded set, evicting the oldest entry when full. */
  private remember(memo: Set<string>, key: string): void {
    if (memo.size >= MEMO_CAP) {
      const oldest = memo.values().next().value
      if (oldest !== undefined) memo.delete(oldest)
    }
    memo.add(key)
  }

  /** Forget `dir`, its parents and everything remembered under it. */
  private forgetDirs(alias: string, dir: string): void {
    const parts = dir.split('/').filter(part => part !== '')
    let current = ''
    for (const part of parts) {
      current += '/' + part
      this.knownDirs.delete(dirKey(alias, current))
    }
    const prefix = `${dirKey(alias, dir)}/`
    for (const key of [...this.knownDirs]) {
      if (key.startsWith(prefix)) this.knownDirs.delete(key)
    }
  }
}

// ------------------------------------------------------------- helpers

/** One memo key: an alias and an absolute remote path, in one string. */
function dirKey(alias: string, path: string): string {
  return `${alias}\u0000${path}`
}

function isSymlink(mode: number): boolean {
  return (mode & S_IFMT) === S_IFLNK
}

function isDir(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR
}

function toEntry(dir: string, name: string, attrs: Stats): RemoteFileEntry {
  return {
    name,
    path: posix.join(dir, name),
    isDir: isDir(attrs.mode),
    size: attrs.size,
    mtime: attrs.mtime * 1000,
    mode: attrs.mode,
    isSymlink: isSymlink(attrs.mode),
  }
}

/** Directories first, case-insensitive name order (VSCode explorer order). */
function compareEntries(a: RemoteFileEntry, b: RemoteFileEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  const la = a.name.toLowerCase()
  const lb = b.name.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

interface ReaddirRow {
  filename: string
  attrs: Stats
}

function readdirAsync(sftp: SFTPWrapper, path: string): Promise<ReaddirRow[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (error, list) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve((list as ReaddirRow[]).filter(row => row.filename !== '.' && row.filename !== '..'))
    })
  })
}

function lstatAsync(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.lstat(path, (error, attrs) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve(attrs)
    })
  })
}

/**
 * Read one window of a file.
 *
 * Every failure path must end in a settle: the caller's `finally` (close the
 * handle, end the session, release the pooled connection) only runs once this
 * promise settles. A synchronous throw from the ssh2 client library therefore
 * has to be converted into a rejection — otherwise the HTTP request hangs
 * forever and the SFTP channel leaks.
 */
function readWindow(sftp: SFTPWrapper, path: string, offset: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, 'r', (openError, handle) => {
      if (openError !== undefined && openError !== null) {
        reject(openError)
        return
      }
      const settle = (error: unknown, data: Buffer | undefined): void => {
        try {
          sftp.close(handle, () => {
            if (error !== undefined && error !== null) reject(error)
            else resolve(data ?? Buffer.alloc(0))
          })
        } catch (closeError) {
          reject(error ?? closeError)
        }
      }
      if (length <= 0) {
        settle(null, Buffer.alloc(0))
        return
      }
      try {
        const buffer = Buffer.alloc(length)
        sftp.read(handle, buffer, 0, length, offset, (readError, bytesRead, data) => {
          if (readError !== undefined && readError !== null) {
            settle(readError, undefined)
            return
          }
          const count = typeof bytesRead === 'number' ? bytesRead : length
          const end = Math.max(0, Math.min(count, data.length))
          settle(null, data.subarray(0, end))
        })
      } catch (error) {
        settle(error, undefined)
      }
    })
  })
}

function writeFileAsync(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, (error) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

/** Create (or truncate) an empty file without sending a zero-length WRITE. */
function touchFile(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.open(path, 'w', (openError, handle) => {
      if (openError !== undefined && openError !== null) {
        reject(openError)
        return
      }
      try {
        sftp.close(handle, (closeError) => {
          if (closeError !== undefined && closeError !== null) reject(closeError)
          else resolve()
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}

function mkdirAsync(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (error) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

function unlinkAsync(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (error) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

function rmdirAsync(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (error) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

function renameAsync(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve()
    })
  })
}

async function removeTree(sftp: SFTPWrapper, dir: string): Promise<void> {
  const rows = await readdirAsync(sftp, dir)
  for (const row of rows) {
    const child = posix.join(dir, row.filename)
    if (isSymlink(row.attrs.mode) || !isDir(row.attrs.mode)) {
      await unlinkAsync(sftp, child)
    } else {
      await removeTree(sftp, child)
    }
  }
  await rmdirAsync(sftp, dir)
}
