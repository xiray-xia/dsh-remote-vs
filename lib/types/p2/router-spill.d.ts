import { SpillStore } from '@deepseek-ai/dsh-spill';
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill';
export default class TransparentSpillStore extends SpillStore {
    static inject: string[];
    private get local();
    private get remote();
    private effective;
    saveText(input: SaveTextSpill): Promise<SpillRef>;
    /** Explicit remote policy: mirrored mode, spill dir as the fence root. */
    private policyFor;
}
