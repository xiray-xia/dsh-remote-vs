/**
 * Remote file operations over SFTP. Paths are absolute POSIX paths on the
 * remote host; every entry point validates before touching the wire.
 */
import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import { posix } from 'node:path'
import type { OpenMode, SFTPWrapper, Stats } from 'ssh2'
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

/** Largest single upload accepted (matches the client-side planner cap). */
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024

/**
 * How long one download stream may make no progress before it is failed.
 *
 * A download has no wall-clock budget for the same reason an upload does not: a
 * big file on a slow link is healthy for minutes. What must never happen is a
 * silently dead stream pinning the SFTP session (and its channel slot) forever,
 * so progress is the bound — any chunk resets this clock.
 */
export const DOWNLOAD_IDLE_MS = 60_000

/** Upload progress bound (no body bytes and no write acknowledgements). */
export const UPLOAD_IDLE_MS = 60_000

/**
 * Parallel-transfer shape, shared by download and upload.
 *
 * A single `createReadStream`/`createWriteStream` keeps exactly ONE SFTP request
 * in flight per round trip; measured against a real host that cost about 8x
 * (4.4 MiB/s single stream vs 35.4 MiB/s for ssh2's pipelined fastGet on the
 * same link). 256 KiB chunks with 32 in-flight requests (8 MiB window) are the
 * same tuning ssh2's fastGet/fastPut use, and bound the per-transfer memory.
 */
export const TRANSFER_CHUNK_BYTES = 256 * 1024

/** In-flight chunk window (also the per-transfer memory bound: 8 MiB). */
export const TRANSFER_CONCURRENCY = 32

/**
 * Cap for both per-path memory sets below (levels confirmed to exist, listings
 * already reported as truncated). Each only ever saves round trips or a repeat
 * log line, so a small window is enough and a miss costs nothing but the work
 * the code did before them.
 */
const MEMO_CAP = 512

/** SFTP status code for "no such file or directory" (ssh2 sets `error.code`). */
const SFTP_NO_SUCH_FILE = 2
/** Generic SFTP failure — what OpenSSH returns for most non-ENOENT errors. */
const SFTP_FAILURE = 4

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

/**
 * `Content-Disposition` for one attachment (RFC 6266 + RFC 5987).
 *
 * Receivers prefer `filename*` when both forms are present (RFC 6266 §4.3),
 * which is why a non-ASCII remote name survives the round trip; the quoted
 * ASCII copy is the fallback for clients that do not understand the extended
 * form. Quotes and backslashes are stripped from that fallback so they cannot
 * break the header.
 */
export function attachmentHeader(fileName: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control bytes is the point
  const fallback = fileName.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`
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
      let rows: ReaddirRow[]
      try {
        rows = await readdirAsync(sftp, path)
      } catch (error) {
        // Listing a FILE used to answer "No such file" for a file that plainly
        // exists, which sends the caller looking for the wrong problem.
        throw (await explainSftpFailure(sftp, path, 'directory', error)) ?? error
      }
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
      const attrs = await lstatAsync(sftp, path).catch(async (error: unknown) => {
        // The stat fails first for a path that is not there, so without this the
        // caller got a bare "No such file" naming no path, while `list` and
        // `write` already said which one.
        throw (await explainSftpFailure(sftp, path, 'file', error)) ?? error
      })
      // Checked from the stat that was already needed, rather than after a
      // failed read: asking the server to read a directory yields nothing but
      // "Failure", and this pre-check costs no extra round trip.
      if (isDir(attrs.mode)) throw new Error(`not a file: ${path} is a directory`)
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
      try {
        await this.withDirRetry(alias, dir, async () => {
          await this.ensureDir(sftp, alias, dir)
          // A zero-length SFTP WRITE packet is not universally accepted (SFTPv3
          // leaves it undefined); an empty file is created by opening for
          // truncation and closing again.
          if (data.length === 0) await touchFile(sftp, path)
          else await writeFileAsync(sftp, path, data)
        })
      } catch (error) {
        // Wrapped OUTSIDE the retry: withDirRetry keys off `error.code`, so
        // translating any earlier would break its re-create-the-directory path.
        throw (await explainSftpFailure(sftp, path, 'file', error)) ?? error
      }
      return { size: data.length }
    })
  }

  /**
   * Stream one upload into a remote file, atomically.
   *
   * Streaming, not `write()`: an upload is whatever the user dragged, so the
   * body must never be buffered whole in Host memory (the JSON `write` op caps
   * at 10 MiB of base64 for exactly that reason). Directories are created
   * first — a drop can name a path several levels below the target — and the
   * source is piped straight into the SFTP write stream.
   *
   * The bytes go to a SIDE file (`.part-<id>` next to the target) and are
   * renamed into place only once the body ended cleanly. Writing the real path
   * directly left a half file behind whenever the upload was cancelled, which
   * then looked like a complete file in the explorer (2026-10-20 user report).
   * On any failure the side file is removed, so a cancelled upload leaves the
   * remote folder exactly as it was.
   *
   * @param alias - host alias.
   * @param file - absolute remote destination path.
   * @param source - request body stream (or any readable).
   * @param maxBytes - hard ceiling; exceeding it destroys the stream and fails.
   * @param overwrite - replace an existing target (the route already asked).
   * @returns the number of bytes written.
   */
  async upload(
    alias: string,
    file: string,
    source: NodeJS.ReadableStream,
    maxBytes = UPLOAD_MAX_BYTES,
    overwrite = true,
  ): Promise<{ size: number }> {
    const path = remotePath(file)
    const dir = posix.dirname(path)
    const partial = `${path}.part-${randomBytes(4).toString('hex')}`
    // No wall-clock deadline: a large body on a slow upload link is healthy for
    // minutes; `streamIntoFile` bounds a dead transfer by progress instead
    // (the old 60 s wrapper turned a healthy 64 MiB upload into a timeout).
    return this.pool.withSftp(alias, async (sftp) => {
      try {
        await this.withDirRetry(alias, dir, async () => {
          await this.ensureDir(sftp, alias, dir)
        })
        const size = await streamIntoFile(sftp, partial, source, maxBytes)
        // Move into place. SFTP v3 `rename` refuses to clobber, so an overwrite
        // removes the old file first — the same window a normal editor save has.
        if (overwrite) await unlinkAsync(sftp, path).catch(() => undefined)
        await renameAsync(sftp, partial, path)
        this.remember(this.knownDirs, dirKey(alias, dir))
        return { size }
      } catch (error) {
        // Never leave the side file: a cancelled upload must be invisible.
        await unlinkAsync(sftp, partial).catch(() => undefined)
        throw (await explainSftpFailure(sftp, path, 'file', error)) ?? error
      }
    }, { timeoutMs: 0 })
  }

  /**
   * Stream one remote file into an HTTP response (download to the local machine).
   *
   * Streaming, not `read()`: `read()` caps at 8 MiB because it answers a JSON
   * editor read, while a download is whatever the user pointed at — a log, a
   * binary, an artifact. The file is opened through one SFTP handle before the
   * headers are written: symlinks are followed (lstat's size is the link
   * target's string length, not the file's), directories are refused, and the
   * content length comes from the same handle the body is read through. The
   * session has no wall-clock deadline (see `DOWNLOAD_IDLE_MS`); the caller's
   * response close and stream errors are both handled, so a cancelled download
   * never leaves the SFTP session or its channel slot pinned.
   *
   * @param alias - host alias.
   * @param file - absolute remote source path.
   * @param res - HTTP response to write the file into.
   */
  async download(alias: string, file: string, res: ServerResponse): Promise<void> {
    const path = remotePath(file)
    await this.pool.withSftp(alias, async (sftp) => {
      const link = await lstatAsync(sftp, path).catch(async (error: unknown) => {
        throw (await explainSftpFailure(sftp, path, 'file', error)) ?? error
      })
      // Same pre-check as read(): asking SFTP to open a directory yields a bare
      // "Failure", while the stat that was needed anyway already says what the
      // path is.
      if (isDir(link.mode)) throw new Error(`not a file: ${path} is a directory`)
      // A symlink must be OPENED, not trusted: lstat reports the LINK's size
      // (the target string), while the body comes from the file the link names.
      // Framing one against the other breaks the response for every symlink,
      // and a link to a directory only fails once opened. One handle supplies
      // the real type and length, and the stream below is bounded by that
      // length so a file that grows mid-transfer cannot overrun the framing.
      const handle = await openAsync(sftp, path).catch(async (error: unknown) => {
        throw (await explainFollowFailure(sftp, path, error)) ?? error
      })
      try {
        const attrs = await fstatAsync(sftp, handle)
        if (isDir(attrs.mode)) throw new Error(`not a file: ${path} is a directory`)
        // The client can disappear while the stat is in flight; there is nobody
        // left to stream to, and writing headers to a closed response would turn
        // "user cancelled" into a spurious Host error.
        if (res.destroyed) return
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(attrs.size),
          'content-disposition': attachmentHeader(posix.basename(path)),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        if (attrs.size <= 0) {
          res.end()
          return
        }
        // Parallel ordered reads; the writer here owns the response, never the
        // handle, so the finally below always closes it exactly once.
        await pipeHandleToResponse(sftp, handle, attrs.size, res)
      } finally {
        await closeAsync(sftp, handle)
      }
    }, { timeoutMs: 0 })
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

/** What is actually at a path — the question a raw SFTP status never answers. */
type PathKind =
  | { kind: 'missing' }
  | { kind: 'symlink' }
  | { kind: 'dir' }
  | { kind: 'file'; size: number }

async function pathKind(sftp: SFTPWrapper, path: string): Promise<PathKind> {
  try {
    const attrs = await lstatAsync(sftp, path)
    if (isSymlink(attrs.mode)) return { kind: 'symlink' }
    if (isDir(attrs.mode)) return { kind: 'dir' }
    return { kind: 'file', size: attrs.size }
  } catch {
    return { kind: 'missing' }
  }
}

function describeKind(kind: PathKind): string {
  switch (kind.kind) {
    case 'missing': return 'not present'
    case 'symlink': return 'a symbolic link'
    case 'dir': return 'a directory'
    default: return `a regular file (${kind.size} bytes)`
  }
}

/**
 * Replace an opaque SFTP status with the fact the caller actually needs.
 *
 * ssh2 forwards the server's own status text, and OpenSSH returns just two of
 * them for a wide range of problems: `No such file` (2) and `Failure` (4).
 * Both leaked straight to the caller, with results that were not merely vague
 * but wrong: listing a *file* reported "No such file" for a file that plainly
 * exists, and reading a *directory* reported only "Failure". An agent given
 * either message cannot tell a wrong path from a wrong KIND of path, so it
 * guesses — which is worse than a longer message.
 *
 * Only those two statuses are explained, and only when the path really is
 * missing or really is the wrong kind. Any other failure (permissions, a full
 * disk, a transport error) keeps its original error, because that message is
 * already the most accurate thing available and guessing over it would make
 * things worse.
 *
 * Called on the failure path only, so a working operation pays nothing.
 */
async function explainSftpFailure(
  sftp: SFTPWrapper,
  path: string,
  wanted: 'directory' | 'file',
  cause: unknown,
): Promise<Error | undefined> {
  const code = (cause as { code?: number } | undefined)?.code
  if (code !== SFTP_NO_SUCH_FILE && code !== SFTP_FAILURE) return undefined
  const kind = await pathKind(sftp, path)
  if (kind.kind === 'missing') {
    return new Error(wanted === 'directory' ? `no such directory: ${path}` : `no such file: ${path}`)
  }
  if (wanted === 'directory' && kind.kind !== 'dir') {
    return new Error(`not a directory: ${path} is ${describeKind(kind)}`)
  }
  if (wanted === 'file' && kind.kind === 'dir') {
    return new Error(`not a file: ${path} is a directory`)
  }
  return undefined
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

function statAsync(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (error, attrs) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve(attrs)
    })
  })
}

function openAsync(sftp: SFTPWrapper, path: string, flags: OpenMode = 'r'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, flags, (error, handle) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve(handle)
    })
  })
}

/** Read exactly `buffer.length` bytes at `position` (SFTP may answer short reads). */
async function readHandleFully(sftp: SFTPWrapper, handle: Buffer, buffer: Buffer, position: number): Promise<void> {
  let filled = 0
  while (filled < buffer.length) {
    const read = await new Promise<number>((resolve, reject) => {
      sftp.read(handle, buffer.subarray(filled), 0, buffer.length - filled, position + filled, (error, bytesRead) => {
        if (error !== undefined && error !== null) reject(error)
        else resolve(bytesRead)
      })
    })
    if (read <= 0) throw new Error(`short read at ${position + filled}`)
    filled += read
  }
}

/**
 * Copy one open remote-file handle into an HTTP response with a bounded
 * parallel read window.
 *
 * `res` must already carry its headers (including content-length). Workers
 * pread 256 KiB chunks out of order into a bounded map, and one ordered writer
 * copies them to the socket, so the response bytes stay ordered while up to
 * `TRANSFER_CONCURRENCY` READs stay in flight. A closed response (user cancel)
 * resolves quietly — the route treats that as a cancellation, not an error —
 * and a no-progress watchdog fails a silently dead transfer.
 */
async function pipeHandleToResponse(
  sftp: SFTPWrapper,
  handle: Buffer,
  size: number,
  res: ServerResponse,
): Promise<void> {
  const chunkBytes = TRANSFER_CHUNK_BYTES
  const totalChunks = Math.ceil(size / chunkBytes)
  const windowChunks = Math.min(TRANSFER_CONCURRENCY, totalChunks)
  const ready = new Map<number, Buffer>()
  const chunkWaiters = new Map<number, () => void>()
  const slotWaiters: Array<() => void> = []
  let slots = windowChunks
  let nextRead = 0
  let cancelled = false
  let failure: Error | undefined
  let lastActivity = Date.now()

  const wakeSlots = (): void => {
    for (const wake of slotWaiters.splice(0)) wake()
  }
  const wakeChunks = (): void => {
    for (const wake of chunkWaiters.values()) wake()
    chunkWaiters.clear()
  }
  const signalChunk = (index: number): void => {
    const wake = chunkWaiters.get(index)
    if (wake !== undefined) {
      chunkWaiters.delete(index)
      wake()
    }
  }
  const fail = (error: unknown): void => {
    if (failure !== undefined) return
    failure = error instanceof Error ? error : new Error(String(error))
    wakeSlots()
    wakeChunks()
  }
  const acquire = async (): Promise<void> => {
    while (slots <= 0) await new Promise<void>(resolve => slotWaiters.push(resolve))
    slots -= 1
  }
  const release = (): void => {
    slots += 1
    const wake = slotWaiters.shift()
    if (wake !== undefined) wake()
  }
  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelled || failure !== undefined) return
      await acquire()
      if (cancelled || failure !== undefined) {
        release()
        return
      }
      const index = nextRead++
      if (index >= totalChunks) {
        release()
        return
      }
      const start = index * chunkBytes
      const length = Math.min(chunkBytes, size - start)
      const buffer = Buffer.allocUnsafe(length)
      try {
        await readHandleFully(sftp, handle, buffer, start)
      } catch (error) {
        release()
        fail(error)
        return
      }
      lastActivity = Date.now()
      ready.set(index, buffer)
      signalChunk(index)
    }
  }
  const waitChunk = (index: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (ready.has(index) || failure !== undefined) resolve()
      else chunkWaiters.set(index, resolve)
    })
  const waitDrain = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (cancelled || failure !== undefined) {
        resolve()
        return
      }
      res.once('drain', resolve)
    })
  const onResponseClose = (): void => {
    if (res.writableEnded) return
    cancelled = true
    wakeSlots()
    wakeChunks()
  }
  res.on('close', onResponseClose)
  const idle = setInterval(() => {
    if (cancelled || failure !== undefined) return
    if (Date.now() - lastActivity < DOWNLOAD_IDLE_MS) return
    // Buffered output waiting on a slow socket is not a dead transfer.
    if (res.writableLength > 0) {
      lastActivity = Date.now()
      return
    }
    fail(new Error(`download stalled: no bytes for ${DOWNLOAD_IDLE_MS / 1000}s`))
  }, Math.min(5_000, DOWNLOAD_IDLE_MS))
  idle.unref?.()

  const workers = Array.from({ length: windowChunks }, () => worker())
  try {
    for (let index = 0; index < totalChunks; index += 1) {
      if (cancelled) break
      if (failure !== undefined) break
      if (!ready.has(index)) await waitChunk(index)
      if (cancelled) break
      if (failure !== undefined) break
      const buffer = ready.get(index)
      if (buffer === undefined) continue
      ready.delete(index)
      if (!res.write(buffer)) await waitDrain()
      release()
      lastActivity = Date.now()
    }
  } finally {
    clearInterval(idle)
    res.removeListener('close', onResponseClose)
    const drained = Promise.all(workers.map(workerPromise => workerPromise.catch(() => undefined)))
    if (failure !== undefined || cancelled) {
      // An in-flight READ cannot be aborted at the SFTP layer: do not block the
      // request on it. The caller's `withSftp` finally closes the session, which
      // settles those reads; the workers then find `cancelled` and exit.
      cancelled = true
      wakeSlots()
      wakeChunks()
      await Promise.race([drained, new Promise<void>((resolve) => setTimeout(resolve, 250))])
    } else {
      await drained
    }
  }
  if (failure !== undefined) {
    res.destroy(failure)
    throw failure
  }
  if (!cancelled) res.end()
}

function fstatAsync(sftp: SFTPWrapper, handle: Buffer): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.fstat(handle, (error, attrs) => {
      if (error !== undefined && error !== null) reject(error)
      else resolve(attrs)
    })
  })
}

function closeAsync(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    try {
      sftp.close(handle, () => resolve())
    } catch {
      resolve()
    }
  })
}

/**
 * Explain an `open` failure after lstat already saw a symlink: lstat reports
 * the LINK's type, so "the thing at the end of the link is a directory" only
 * shows up after the follow. `stat` follows the link and answers the question
 * a raw SFTP status never does.
 */
async function explainFollowFailure(sftp: SFTPWrapper, path: string, cause: unknown): Promise<Error | undefined> {
  const code = (cause as { code?: number } | undefined)?.code
  if (code !== SFTP_NO_SUCH_FILE && code !== SFTP_FAILURE) return undefined
  let attrs: Stats
  try {
    attrs = await statAsync(sftp, path)
  } catch (error) {
    const followCode = (error as { code?: number } | undefined)?.code
    return followCode === SFTP_NO_SUCH_FILE ? new Error(`no such file: ${path}`) : undefined
  }
  if (isDir(attrs.mode)) return new Error(`not a file: ${path} is a directory`)
  return undefined
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

/**
 * Stream one readable request body into a new remote file with a bounded
 * parallel write window.
 *
 * The mirror of `pipeHandleToResponse`: incoming bytes are cut into
 * `TRANSFER_CHUNK_BYTES` pieces and up to `TRANSFER_CONCURRENCY` WRITEs are in
 * flight at their own offsets. A single `createWriteStream` keeps one WRITE per
 * round trip and was far slower on the same link (~1 MiB/s, so a 64 MiB body
 * could not even finish inside the old 60 s session deadline).
 *
 * The producer is paused while more than two windows of chunks are waiting, so
 * Host memory stays bounded. Aborted clients (no `end`) fail instead of hanging:
 * a stuck upload used to pin the SFTP session and block every later operation.
 *
 * @param sftp - live SFTP session.
 * @param path - absolute remote destination.
 * @param source - request body stream.
 * @param maxBytes - ceiling in bytes.
 * @returns the byte count written.
 */
function streamIntoFile(
  sftp: SFTPWrapper,
  path: string,
  source: NodeJS.ReadableStream,
  maxBytes: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const chunkBytes = TRANSFER_CHUNK_BYTES
    const windowChunks = TRANSFER_CONCURRENCY
    const chunks = new Map<number, Buffer>()
    let nextChunk = 0
    let nextWrite = 0
    let pendingWrites = 0
    let received = 0
    let carry: Buffer | undefined
    let handle: Buffer | undefined
    let ended = false
    let settled = false
    let lastActivity = Date.now()
    let idle: ReturnType<typeof setInterval> | undefined

    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (idle !== undefined) clearInterval(idle)
      try {
        source.pause()
      } catch {
        // Source already gone.
      }
      if (error === undefined) {
        resolve(received)
        return
      }
      try {
        (source as unknown as { destroy?: (error?: Error) => void }).destroy?.(error)
      } catch {
        // Already destroyed.
      }
      if (handle !== undefined) {
        const current = handle
        handle = undefined
        void closeAsync(sftp, current)
      }
      reject(error)
    }

    const pump = (): void => {
      const current = handle
      if (settled || current === undefined) return
      while (pendingWrites < windowChunks && chunks.has(nextWrite)) {
        const index = nextWrite++
        const buffer = chunks.get(index)
        if (buffer === undefined) break
        chunks.delete(index)
        pendingWrites += 1
        sftp.write(current, buffer, 0, buffer.length, index * chunkBytes, (error) => {
          pendingWrites -= 1
          if (settled) return
          if (error !== undefined && error !== null) {
            finish(error instanceof Error ? error : new Error(String(error)))
            return
          }
          lastActivity = Date.now()
          pump()
          maybeFinish()
          try {
            if (chunks.size < windowChunks) source.resume()
          } catch {
            // Source ended.
          }
        })
      }
    }

    const maybeFinish = (): void => {
      if (settled || !ended) return
      if (pendingWrites > 0 || chunks.size > 0) return
      const current = handle
      handle = undefined
      if (current === undefined) {
        finish()
        return
      }
      closeAsync(sftp, current).then(() => finish(), () => finish())
    }

    const enqueue = (buffer: Buffer): void => {
      chunks.set(nextChunk, buffer)
      nextChunk += 1
      try {
        if (chunks.size + pendingWrites >= windowChunks * 2) source.pause()
      } catch {
        // Source already gone.
      }
      pump()
    }

    const pushData = (chunk: Buffer): void => {
      const data = carry === undefined ? chunk : Buffer.concat([carry, chunk])
      let offset = 0
      while (data.length - offset >= chunkBytes) {
        enqueue(Buffer.from(data.subarray(offset, offset + chunkBytes)))
        offset += chunkBytes
      }
      carry = offset < data.length ? Buffer.from(data.subarray(offset)) : undefined
    }

    source.on('data', (chunk: Buffer) => {
      if (settled) return
      received += chunk.length
      if (received > maxBytes) {
        finish(new Error(`upload exceeds the ${formatBytes(maxBytes)} limit`))
        return
      }
      lastActivity = Date.now()
      pushData(chunk)
    })
    source.on('end', () => {
      if (settled || ended) return
      ended = true
      if (carry !== undefined) {
        const tail = carry
        carry = undefined
        enqueue(tail)
      }
      maybeFinish()
    })
    source.on('error', (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
    // A client that gives up (the explorer's ✕, a closed tab) never sends 'end',
    // and without this the promise below never settles: the SFTP session stays
    // held, every later operation on that host queues behind it, and the next
    // `stat` looks like a dead host (2026-10-20: an aborted 64 MB upload made the
    // following drop sit at "正在读取拖放内容…" forever).
    const aborted = (): void => finish(new Error('upload aborted by the client'))
    source.on('aborted', aborted)
    source.on('close', () => {
      // `complete` is false when the request ended before its body finished.
      const complete = (source as unknown as { complete?: boolean }).complete
      if (complete === false) aborted()
    })

    idle = setInterval(() => {
      if (settled) return
      if (Date.now() - lastActivity < UPLOAD_IDLE_MS) return
      finish(new Error(`SFTP upload stalled: no progress for ${UPLOAD_IDLE_MS / 1000}s`))
    }, Math.min(5_000, UPLOAD_IDLE_MS))
    idle.unref?.()

    openAsync(sftp, path, 'w').then((opened) => {
      handle = opened
      pump()
      maybeFinish()
    }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

/** Human-facing size for an upload cap ("2 GiB", "16 KiB"). */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    const gib = bytes / (1024 * 1024 * 1024)
    return `${gib % 1 === 0 ? gib : gib.toFixed(1)} GiB`
  }
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MiB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`
  return `${bytes} B`
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
