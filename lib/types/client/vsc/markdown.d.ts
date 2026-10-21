/**
 * Minimal, dependency-free Markdown renderer for the remote preview pane.
 *
 * It renders React elements directly (never `dangerouslySetInnerHTML`), so raw
 * HTML in a remote document stays inert text. Coverage is the subset that
 * matters when reading a repository file: headings, fenced and inline code,
 * lists, blockquotes, rules, GFM tables, links, bold / italic / strike.
 */
import { type ReactNode } from 'react';
/** Render a whole document. */
export declare function renderMarkdown(text: string): ReactNode;
