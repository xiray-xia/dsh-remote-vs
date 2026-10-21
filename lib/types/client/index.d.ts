/**
 * Client half of dsh-remote-vs (Turn C): the explorer (four sub-views:
 * workspaces / files / terminal / git over /api/dsh-remote) on exactly one
 * surface — the better-sidebar tab when that plugin is installed, else a
 * native right-Sidebar page (same root, guide entry). Host management lives
 * in the DSH Settings dialog (`settings.section` entry). Phase 4 also
 * shadows the native directory-flow holes (Local/Remote dialog).
 */
import type { Context } from '@deepseek-ai/cordis';
import './vsc/vsc.css';
/** Services required before mounting (slots/uiWorkspace are core web services). */
export declare const inject: string[];
/** Client plugin body. */
export declare function apply(ctx: Context): void;
