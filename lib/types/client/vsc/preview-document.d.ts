/**
 * Document previews for remote files.
 *
 * Text sources (Markdown/HTML/SVG/CSV) are rendered from the editor buffer. PDF,
 * audio/video and Office bytes never pass through `fs.read` (it is a UTF-8 API
 * with a 4 MiB cap): they are streamed from the existing `/download` route into
 * a blob URL, and Office is first converted to PDF by a LibreOffice already
 * present on the REMOTE host. When that engine is missing the notice says so;
 * the plugin never claims a corrupt file.
 */
import { type ReactNode } from 'react';
import { type PreviewKind } from './preview-model.ts';
/** Never assemble a larger preview body than this in the tab. */
export declare const MAX_PREVIEW_BYTES: number;
export declare function officeExtensionOf(path: string): string | undefined;
/**
 * Convert one remote Office document to PDF on the remote host.
 *
 * Paths and the extension are quoted/validated here; the only value that ends
 * up in the shell is the remote path. A missing engine is reported as
 * `@@RVS_NO_SOFFICE` (notice), not as a corrupt document.
 */
export declare function officeConvertCommand(path: string): string;
/** Fetch one remote file body through the streaming download route. */
export declare function fetchRemoteBytes(alias: string, path: string, signal?: AbortSignal): Promise<Uint8Array>;
export declare function BytePreview(props: {
    alias: string;
    path: string;
    kind: 'pdf' | 'office' | 'media';
    revision: number;
    t: (key: string) => string;
}): ReactNode;
export declare function SvgPreview(props: {
    path: string;
    text: string;
    truncated: boolean;
    t: (key: string) => string;
}): ReactNode;
export declare function TablePreview(props: {
    path: string;
    text: string;
    truncated: boolean;
    t: (key: string) => string;
}): ReactNode;
export declare function previewLabelFor(kind: PreviewKind): string | undefined;
