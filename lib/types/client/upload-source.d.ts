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
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    file?: (success: (file: unknown) => void, failure?: (error: unknown) => void) => void;
    createReader?: () => ReaderLike;
}
/** The slice of `FileSystemDirectoryReader` this module needs. */
export interface ReaderLike {
    readEntries: (success: (entries: EntryLike[]) => void, failure?: (error: unknown) => void) => void;
}
/** One collected file, with the browser's File object intact. */
export interface CollectedFile {
    /** Path relative to the drop target, slash-separated. */
    rel: string;
    /** Size in bytes (0 when the browser did not report one). */
    size: number;
    /** The original blob to upload. */
    blob: Blob;
}
/** Everything one walk found. */
export interface CollectedDrop {
    files: CollectedFile[];
    /** Every directory walked, relative to the drop target ('' excluded). */
    dirs: string[];
}
/**
 * Walk one entry tree into flat relative paths.
 *
 * @param entries - top-level entries from the drop.
 * @returns the files (with blobs) and every directory that was walked.
 */
export declare function collectDroppedFiles(entries: readonly EntryLike[]): Promise<CollectedDrop>;
