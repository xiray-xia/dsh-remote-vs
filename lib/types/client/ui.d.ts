/**
 * Shared presentational bits: theme-inheriting inline styles (transparent
 * surfaces, currentColor text, hairline borders) that read well in both
 * DSH light and dark themes without knowing token names.
 */
import type { CSSProperties, ReactNode } from 'react';
export declare const hairline: CSSProperties;
export declare const inputStyle: CSSProperties;
/**
 * Native dropdown that follows the DSH theme in BOTH states: the closed box
 * uses the translucent surface, while the open option popup (which Chrome
 * renders from `color-scheme`, ignoring translucent backgrounds) gets
 * explicit Canvas colors + a declared scheme so dark theme stays readable.
 */
export declare const selectStyle: CSSProperties;
/** Option rows of the open popup: explicit theme-following colors. */
export declare const optionStyle: CSSProperties;
export declare const btnStyle: CSSProperties;
export declare const btnPrimaryStyle: CSSProperties;
export declare const btnDangerStyle: CSSProperties;
export declare function Btn(props: {
    onClick: () => void;
    disabled?: boolean;
    kind?: 'normal' | 'primary' | 'danger';
    title?: string;
    children: ReactNode;
}): ReactNode;
/**
 * Inline loading spinner (SMIL rotation, no CSS dependency): a dim track
 * ring plus a bright arc rotating around it. Inherits text color.
 */
export declare function Spinner(props: {
    size?: number;
}): ReactNode;
export declare function Notice(props: {
    kind: 'info' | 'error';
    children: ReactNode;
}): ReactNode;
export declare function Field(props: {
    label: string;
    children: ReactNode;
}): ReactNode;
export declare function Row(props: {
    children: ReactNode;
    gap?: number;
}): ReactNode;
