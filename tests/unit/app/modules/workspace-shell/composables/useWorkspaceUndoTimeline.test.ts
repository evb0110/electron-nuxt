import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {useWorkspaceCommandLedger} from '@app/modules/workspace-shell/composables/useWorkspaceCommandLedger';

describe('useWorkspaceCommandLedger', () => {
    it('uses direct producer registration as the natural cross-source order', async () => {
        const ledger = useWorkspaceCommandLedger();
        const calls: string[] = [];
        for (const source of [
            'file',
            'annotation',
            'metadata',
        ] as const) {
            ledger.registerCommand({
                source,
                undo: () => {
                    calls.push(`undo:${source}`);
                    return true;
                },
                cmd: () => {
                    calls.push(`redo:${source}`);
                    return true;
                },
            });
        }

        expect(ledger.nextUndoSource.value).toBe('metadata');
        await ledger.undoTimeline();
        await ledger.undoTimeline();
        await ledger.undoTimeline();
        await ledger.redoTimeline();
        await ledger.redoTimeline();
        await ledger.redoTimeline();
        expect(calls).toEqual([
            'undo:metadata',
            'undo:annotation',
            'undo:file',
            'redo:file',
            'redo:annotation',
            'redo:metadata',
        ]);
    });

    it('resets one producer without disturbing commands from other sources', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undoFile = vi.fn(() => true);
        ledger.registerCommand({
            source: 'metadata',
            undo: () => true,
            cmd: () => true,
        });
        ledger.registerCommand({
            source: 'file',
            undo: undoFile,
            cmd: () => true,
        });
        ledger.resetSource('metadata');

        expect(ledger.nextUndoSource.value).toBe('file');
        await ledger.undoTimeline();
        expect(undoFile).toHaveBeenCalledOnce();
        expect(ledger.canUndoTimeline.value).toBe(false);
    });

    it('retires a stale command when its inverse reports no work', async () => {
        const ledger = useWorkspaceCommandLedger();
        ledger.registerCommand({
            source: 'annotation',
            undo: () => false,
            cmd: () => true,
        });

        expect(await ledger.undoTimeline()).toBe(false);
        expect(ledger.nextUndoSource.value).toBeNull();
    });

    it('enforces one cross-source byte budget', async () => {
        const ledger = useWorkspaceCommandLedger();
        const undo = vi.fn(() => true);
        ledger.registerCommand({
            source: 'annotation',
            undo,
            cmd: () => true,
            estimatedBytes: 20 * 1024 * 1024,
        });
        ledger.registerCommand({
            source: 'file',
            undo,
            cmd: () => true,
            estimatedBytes: 20 * 1024 * 1024,
        });

        expect(await ledger.undoTimeline()).toBe(true);
        expect(ledger.canUndoTimeline.value).toBe(false);
        expect(undo).toHaveBeenCalledOnce();
    });
});
