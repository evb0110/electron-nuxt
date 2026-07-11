import {
    mkdtemp,
    readFile,
    rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    claimWorkspaceCheckpoint,
    saveWorkspaceCheckpoint,
} from '@electron/workspaceCheckpointStore';

const state = vi.hoisted(() => ({
    userDataPath: '',
    owners: new Map<string, number>(),
}));

vi.mock('electron', () => ({app: {getPath: () => state.userDataPath}}));

vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyOwnerWebContentsId: (path: string) => state.owners.get(path),
    claimWorkingCopyOwnership: (path: string, expectedOwner: number, nextOwner: number) => {
        if (state.owners.get(path) !== expectedOwner) {
            return false;
        }
        state.owners.set(path, nextOwner);
        return true;
    },
    setWorkingCopyOriginalPath: (path: string, _originalPath: string, owner: number) => {
        state.owners.set(path, owner);
        return Promise.resolve();
    },
}));

const workingCopyRef = '/tmp/evb-working/draft.pdf';
const checkpoint = {
    version: 1 as const,
    capturedAt: 123,
    activePaneId: 'pane-1',
    activeTabId: 'tab-1',
    layout: {
        type: 'leaf' as const,
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
        fileName: 'draft.pdf',
        sourceRef: '/documents/draft.pdf',
        workingCopyRef,
        isDirty: true,
        isDjvu: false,
        currentPage: 2,
        zoom: 1,
        zoomMode: 'fit-width' as const,
    }],
};

describe('workspace checkpoint store', () => {
    beforeEach(async () => {
        state.userDataPath = await mkdtemp(join(tmpdir(), 'evb-workspace-checkpoint-'));
        state.owners.clear();
    });

    afterEach(async () => {
        await rm(state.userDataPath, {
            force: true,
            recursive: true,
        });
    });

    it('atomically persists, claims once, and transfers working-copy ownership', async () => {
        state.owners.set(workingCopyRef, 11);
        await saveWorkspaceCheckpoint(checkpoint, 11);

        const stored = JSON.parse(await readFile(join(state.userDataPath, 'workspace-checkpoint.json'), 'utf8'));
        expect(stored).toMatchObject({
            version: 1,
            ownerWebContentsId: 11,
        });

        await expect(claimWorkspaceCheckpoint(22)).resolves.toEqual(checkpoint);
        expect(state.owners.get(workingCopyRef)).toBe(22);
        await expect(claimWorkspaceCheckpoint(33)).resolves.toBeNull();
    });

    it('rejects checkpoints that reference another renderer working copy', async () => {
        state.owners.set(workingCopyRef, 99);
        await expect(saveWorkspaceCheckpoint(checkpoint, 11)).rejects.toThrow('unowned working copy');
    });
});
