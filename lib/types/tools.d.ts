/**
 * Agent tools: the model-facing counterpart of the remote GUI. Every tool
 * talks to the same pool/files the web UI uses. Hosts must be configured in
 * the GUI first (agents cannot create hosts).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { RemotePool } from './pool.ts';
import type { RemoteStore } from './store.ts';
/** Agent-facing host row (schema-strict projection of RemoteHostSummary). */
export interface AgentHostRow {
    alias: string;
    host: string;
    port: number;
    user: string;
    auth: 'key' | 'password';
    keyReady: boolean;
    managedKey: boolean;
    description?: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
}
/** Schema-strict exec outcome (exitCode null folds to undefined). */
export interface AgentExecOut {
    success: boolean;
    exitCode?: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    durationMs: number;
    error?: string;
}
export interface RemoteToolsDeps {
    store: RemoteStore;
    pool: RemotePool;
}
export declare function remoteHostsTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool>;
export declare function remoteExecTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool>;
export declare function remoteLsTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool>;
export declare function remoteReadTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool>;
export declare function remoteWriteTool(deps: RemoteToolsDeps): ReturnType<typeof defineTool>;
