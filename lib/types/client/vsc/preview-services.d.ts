/**
 * Host Client-Remote access for document previews.
 *
 * The reference local-workbench implementation reads bytes through
 * `remote.workspaceFiles.readBytes` and converts Office through
 * `remote.officeKit.render`. dsh-remote-vs replaces the global `fs` with a
 * transparent RouterFs, so those services can route a remote session's
 * workspace; this module keeps them as SOFT services (ctx.get) and reports
 * `unavailable` when a profile does not mount them.
 */
import type { Context } from '@deepseek-ai/cordis';
export type PreviewFailureReason = 'unavailable' | 'too-large' | 'not-found' | 'remote' | 'failed';
export type PreviewBytesResult = {
    ok: true;
    data: Uint8Array;
    size: number;
} | {
    ok: false;
    reason: PreviewFailureReason;
    detail: string;
};
export declare function installPreviewServices(ctx: Context): () => void;
export declare function readWorkspaceBytes(sessionId: string, path: string, signal?: AbortSignal): Promise<PreviewBytesResult>;
export declare function renderOfficePdf(sessionId: string, path: string, signal?: AbortSignal): Promise<PreviewBytesResult>;
