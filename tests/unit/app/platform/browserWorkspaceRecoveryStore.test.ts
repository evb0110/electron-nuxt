import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    claimBrowserWorkspaceRecoveryOwner,
    clearBrowserWorkspaceRecovery,
    loadBrowserWorkspaceRecoveries,
    loadBrowserWorkspaceRecovery,
    saveBrowserWorkspaceRecovery,
} from '@app/platform/browser/browserWorkspaceRecoveryStore';
import { FakeIndexedDbFactory } from '@tests/unit/app/platform/browserPlatformTestDoubles';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';

const checkpoint: IWorkspaceCheckpoint = {
    version: 1,
    capturedAt: 1,
    activePaneId: 'pane-1',
    activeTabId: 'tab-1',
    layout: {
        type: 'leaf',
        paneId: 'pane-1',
    },
    panes: [{
        paneId: 'pane-1',
        tabIds: ['tab-1'],
        activeTabId: 'tab-1',
    }],
    tabs: [{
        tabId: 'tab-1',
        paneId: 'pane-1',
        fileName: 'recovered.pdf',
        sourceRef: 'browser://documents/source.pdf',
        workingCopyRef: 'browser://documents/recovery.pdf',
        requiresSaveAsOnFirstSave: true,
        isDirty: true,
        isDjvu: false,
        currentPage: 1,
        zoom: 1,
        zoomMode: 'custom',
    }],
};

describe('browserWorkspaceRecoveryStore', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('indexedDB', new FakeIndexedDbFactory());
    });

    it('publishes and clears only committed recovery checkpoints', async () => {
        await expect(saveBrowserWorkspaceRecovery('window:1', 0, checkpoint, [
            'browser://documents/recovery.pdf',
            'browser://documents/not-in-checkpoint.pdf',
        ])).resolves.toEqual({
            saved: true,
            generation: 1,
        });

        await expect(loadBrowserWorkspaceRecovery('window:1')).resolves.toEqual({
            ownerId: 'window:1',
            generation: 1,
            checkpoint,
            snapshotRefs: ['browser://documents/recovery.pdf'],
            updatedAt: expect.any(Number),
        });

        await expect(clearBrowserWorkspaceRecovery('window:1', 1))
            .resolves.toEqual({
                saved: true,
                generation: 0,
            });
        await expect(loadBrowserWorkspaceRecovery('window:1')).resolves.toBeNull();
    });

    it('isolates concurrent window owners and rejects stale owner generations', async () => {
        await Promise.all([
            saveBrowserWorkspaceRecovery('window:10', 0, checkpoint, ['browser://documents/recovery.pdf']),
            saveBrowserWorkspaceRecovery('window:20', 0, {
                ...checkpoint,
                capturedAt: 2,
            }, ['browser://documents/recovery.pdf']),
        ]);

        await expect(loadBrowserWorkspaceRecoveries()).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({
                ownerId: 'window:10',
                generation: 1,
            }),
            expect.objectContaining({
                ownerId: 'window:20',
                generation: 1,
            }),
        ]));
        await expect(saveBrowserWorkspaceRecovery(
            'window:10',
            0,
            {
                ...checkpoint,
                capturedAt: 3,
            },
            ['browser://documents/recovery.pdf'],
        )).resolves.toEqual({
            saved: false,
            generation: 1,
        });
        await expect(clearBrowserWorkspaceRecovery('window:10', 0))
            .resolves.toEqual({
                saved: false,
                generation: 1,
            });
        await expect(loadBrowserWorkspaceRecovery('window:20'))
            .resolves.toEqual(expect.objectContaining({
                ownerId: 'window:20',
                generation: 1,
            }));
    });

    it('moves an orphan journal to a fresh owner in one compare-and-swap transaction', async () => {
        await saveBrowserWorkspaceRecovery(
            'window:closed',
            0,
            checkpoint,
            ['browser://documents/recovery.pdf'],
        );

        await expect(claimBrowserWorkspaceRecoveryOwner(
            'window:closed',
            'window:new',
            1,
        )).resolves.toEqual({
            claimed: true,
            generation: 2,
        });
        await expect(loadBrowserWorkspaceRecovery('window:closed')).resolves.toBeNull();
        await expect(loadBrowserWorkspaceRecovery('window:new')).resolves.toEqual(
            expect.objectContaining({
                ownerId: 'window:new',
                generation: 2,
                snapshotRefs: ['browser://documents/recovery.pdf'],
            }),
        );
    });
});
