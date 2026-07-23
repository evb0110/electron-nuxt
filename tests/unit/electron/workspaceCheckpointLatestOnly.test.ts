import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IWorkspaceCheckpoint } from '@contracts/workspaceCheckpoint';

function deferred() {
    let resolve: () => void = () => {};
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve,
    };
}

const mocks = vi.hoisted(() => ({
    atomicReplace: vi.fn(),
    persisted: null as string | null,
    staged: new Map<string, string>(),
    tempIndex: 0,
}));

vi.mock('electron', () => ({app: {getPath: () => '/profile'}}));
vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(async () => {
        if (mocks.persisted === null) {
            throw new Error('missing');
        }
        return mocks.persisted;
    }),
    rm: vi.fn(async () => {
        mocks.persisted = null;
    }),
    writeFile: vi.fn(async (path: string, value: string) => {
        mocks.staged.set(path, value);
    }),
}));
vi.mock('@electron/utils/atomicReplace', () => ({
    atomicReplace: mocks.atomicReplace,
    makeSiblingTempPath: () => `/profile/checkpoint-${mocks.tempIndex += 1}.tmp`,
}));
vi.mock('@electron/file-access/workingCopyStore', () => ({
    claimWorkingCopyOwnership: vi.fn(),
    getWorkingCopyOriginalPath: vi.fn(() => null),
    getWorkingCopyOwnerWebContentsId: vi.fn(() => undefined),
    setWorkingCopyOriginalPath: vi.fn(),
}));

function createCheckpoint(capturedAt: number): IWorkspaceCheckpoint {
    return {
        version: 1,
        capturedAt,
        activePaneId: 'pane-1',
        activeTabId: null,
        layout: {
            type: 'leaf',
            paneId: 'pane-1',
        },
        panes: [{
            paneId: 'pane-1',
            tabIds: [],
            activeTabId: null,
        }],
        tabs: [],
    };
}

describe('workspace checkpoint latest-only writer', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.persisted = null;
        mocks.staged.clear();
        mocks.tempIndex = 0;
    });

    it('commits the active save and only the latest pending checkpoint', async () => {
        const firstGate = deferred();
        const secondGate = deferred();
        const committed: number[] = [];
        mocks.atomicReplace
            .mockImplementationOnce(async (source: string) => {
                await firstGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
                committed.push(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt);
            })
            .mockImplementationOnce(async (source: string) => {
                await secondGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
                committed.push(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt);
            });
        const {saveWorkspaceCheckpoint} = await import('@electron/workspaceCheckpointStore');

        const first = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(1));
        const second = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        const third = saveWorkspaceCheckpoint(createCheckpoint(3), 10);
        let secondSettled = false;
        void second.finally(() => {
            secondSettled = true;
        });

        firstGate.resolve();
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(2));
        expect(secondSettled).toBe(false);
        secondGate.resolve();
        await Promise.all([
            first,
            second,
            third,
        ]);

        expect(committed).toEqual([
            1,
            3,
        ]);
    });

    it('drains pending saves before claim removes the checkpoint', async () => {
        const firstGate = deferred();
        const secondGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(async (source: string) => {
                await firstGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
            })
            .mockImplementationOnce(async (source: string) => {
                await secondGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
            });
        const {
            claimWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const first = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(1));
        const latest = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        const claim = claimWorkspaceCheckpoint(20);

        firstGate.resolve();
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(2));
        secondGate.resolve();

        await Promise.all([
            first,
            latest,
        ]);
        await expect(claim).resolves.toMatchObject({capturedAt: 2});
        expect(mocks.persisted).toBeNull();
    });

    it('drains pending saves before clear removes the checkpoint', async () => {
        const firstGate = deferred();
        mocks.atomicReplace.mockImplementationOnce(async (source: string) => {
            await firstGate.promise;
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const {
            clearWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const save = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledOnce());
        const clear = clearWorkspaceCheckpoint();
        firstGate.resolve();

        await save;
        await clear;
        expect(mocks.persisted).toBeNull();
    });
});
