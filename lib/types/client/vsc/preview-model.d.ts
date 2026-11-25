/**
 * Remote document preview classification and table parsing.
 *
 * Pure functions only (no React/DOM/fetch): the editor shell, the preview
 * component and the gate all read the same classification, and CSV/TSV parsing
 * can be tested in Node.
 */
export type PreviewKind = 'text' | 'image' | 'markdown' | 'html' | 'svg' | 'table' | 'pdf' | 'office' | 'media';
export declare function extensionOf(path: string): string;
export declare function previewKindOf(path: string): PreviewKind;
export declare function isBytePreview(kind: PreviewKind): kind is 'pdf' | 'office' | 'media';
export declare function hasTextSource(kind: PreviewKind): boolean;
export declare function previewKindLabel(kind: PreviewKind): string | undefined;
export declare function mediaTypeOf(path: string): {
    kind: 'audio' | 'video';
    mime: string;
} | undefined;
export declare function tableDelimiterOf(path: string): string;
export interface TableLimits {
    maxRows: number;
    maxColumns: number;
    maxCells: number;
}
export declare const DEFAULT_TABLE_LIMITS: TableLimits;
export interface TableData {
    rows: string[][];
    columns: number;
    truncated: boolean;
}
/** RFC 4180 parser with explicit row/column/cell bounds. */
export declare function parseDelimited(text: string, delimiter: string, limits?: TableLimits): TableData;
