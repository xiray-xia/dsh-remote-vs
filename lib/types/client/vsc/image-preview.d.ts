/**
 * Inline image preview for the editor body.
 *
 * A remote image has no text to edit, so the editor shows the picture instead
 * of the "binary file" notice. Presentation only: the base64 payload comes from
 * the tab's read (the same SFTP read every other preview uses), and this
 * component owns nothing but the fit / actual-size toggle and the load-failure
 * state.
 *
 * Why an `<img>` with a `data:` URL and not an object URL: the payload already
 * arrived base64 from the file route, so there is nothing extra to fetch — and
 * nothing to revoke when the tab closes.
 */
import { type ReactNode } from 'react';
/** Props of {@link ImagePreview}. */
export interface ImagePreviewProps {
    /** `data:` URL built from the tab's base64 payload. */
    src: string;
    /** Absolute remote path (tooltip / aria label). */
    path: string;
    /** File size in bytes (shown next to the dimensions). */
    size: number;
    /** Set when the read was capped: a partial image cannot decode. */
    truncated?: boolean;
    /** i18n lookup (falls back to the inline English when the key is missing). */
    t?: (key: string) => string;
}
/** Human size for the meta line. */
export declare function imageSizeText(bytes: number): string;
/**
 * The preview body: the image, a click-to-toggle zoom, and a meta line.
 *
 * `fit` scales the picture down to the pane (the common case: look at it);
 * `actual` shows it at natural size inside a scrollable pane (inspect pixels).
 */
export declare function ImagePreview(props: ImagePreviewProps): ReactNode;
