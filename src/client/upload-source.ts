/**
 * Turn a drop's `FileSystemEntry` tree into flat relative paths.
 *
 * `DataTransfer.files` flattens a dropped FOLDER into nothing useful (the
 * browser exposes only the files it lists at the top), so a folder drop has to
 * be walked through the entry API: directories are read in batches until the
 * reader answers an empty list, and each file's path is the chain of parent
 * directory names.
 *
 * Kept free of React and of `DataTransfer` itself (the caller extracts the
 * entries) so a gate can drive it with plain objects.
 */

/** The slice of `FileSystemEntry` this module needs. */
export interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (success: (file: unknown) => void, failure?: (error: unknown) => void) => void
  createReader?: () => ReaderLike
}

/** The slice of `FileSystemDirectoryReader` this module needs. */
export interface ReaderLike {
  readEntries: (
    success: (entries: EntryLike[]) => void,
    failure?: (error: unknown) => void,
  ) => void
}

/** One collected file, with the browser's File object intact. */
export interface CollectedFile {
  /** Path relative to the drop target, slash-separated. */
  rel: string
  /** Size in bytes (0 when the browser did not report one). */
  size: number
  /** The original blob to upload. */
  blob: Blob
}

/** Everything one walk found. */
export interface CollectedDrop {
  files: CollectedFile[]
  /** Every directory walked, relative to the drop target ('' excluded). */
  dirs: string[]
}

/** Hard cap on walked directories: a symlinked tree must not hang the tab. */
const MAX_DIRECTORIES = 5_000

/**
 * How long one `entry.file()` may take before the walk gives up on it.
 *
 * The entry API can simply never call back — a drag whose backing FileSystem is
 * gone (an entry produced by an injected/synthetic drag is exactly that) leaves
 * the promise pending forever, and a pending promise here means the drop appears
 * to do NOTHING: no bar, no error, no request. A timeout turns that silence into
 * a rejection the caller can fall back from (`DataTransfer.files` is populated
 * for real drags, so the file still uploads).
 */
const ENTRY_FILE_TIMEOUT_MS = 1_500

function readFile(entry: EntryLike): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    const read = entry.file?.bind(entry)
    if (read === undefined) {
      reject(new Error(`no file reader for ${entry.name}`))
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`the browser never delivered "${entry.name}" (entry API timed out)`))
    }, ENTRY_FILE_TIMEOUT_MS)
    timer.unref?.()
    read(
      (file) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(file as Blob)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Read one directory to exhaustion (the API answers in batches). */
function readAllEntries(reader: ReaderLike): Promise<EntryLike[]> {
  return new Promise<EntryLike[]>((resolve, reject) => {
    const all: EntryLike[] = []
    const step = (): void => {
      reader.readEntries(
        (batch) => {
          if (batch.length === 0) {
            resolve(all)
            return
          }
          all.push(...batch)
          step()
        },
        (error) => reject(error instanceof Error ? error : new Error(String(error))),
      )
    }
    step()
  })
}

/**
 * Walk one entry tree into flat relative paths.
 *
 * @param entries - top-level entries from the drop.
 * @returns the files (with blobs) and every directory that was walked.
 */
export async function collectDroppedFiles(entries: readonly EntryLike[]): Promise<CollectedDrop> {
  const files: CollectedFile[] = []
  const dirs: string[] = []
  let walkedDirs = 0

  const walk = async (entry: EntryLike, prefix: string): Promise<void> => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isFile) {
      const blob = await readFile(entry)
      files.push({ rel, size: typeof blob.size === 'number' ? blob.size : 0, blob })
      return
    }
    if (!entry.isDirectory) return
    walkedDirs += 1
    if (walkedDirs > MAX_DIRECTORIES) throw new Error('too many directories in the drop')
    dirs.push(rel)
    const readerFactory = entry.createReader
    if (readerFactory === undefined) return
    const children = await readAllEntries(readerFactory.call(entry))
    for (const child of children) await walk(child, rel)
  }

  for (const entry of entries) await walk(entry, '')
  return { files, dirs }
}
