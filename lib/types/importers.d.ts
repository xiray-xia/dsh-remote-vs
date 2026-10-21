import type { HostPayload } from './store.ts';
import type { ImportReport } from './protocol.ts';
export interface ParsedImport {
    payloads: HostPayload[];
    skipped: {
        alias: string;
        reason: string;
    }[];
}
/** Parse OpenSSH client config text into host payloads. */
export declare function parseSshConfig(text: string): ParsedImport;
/** Read the default ~/.ssh/config (throws when missing). */
export declare function readDefaultSshConfig(): string;
/** Migrate entries from the third-party dsh-ssh.json (one-shot copy). */
export declare function migrateDshSsh(home?: string): ParsedImport;
/** Merge parsed payloads into the report shape after applying them. */
export declare function toReport(imported: string[], skipped: {
    alias: string;
    reason: string;
}[]): ImportReport;
