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
    remove: vi.fn(),
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
    rm: mocks.remove,
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
        mocks.remove.mockImplementation(async () => {
            mocks.persisted = null;
        });
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

    it('continues with the latest pending checkpoint after an active save fails', async () => {
        const firstGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(async () => {
                await firstGate.promise;
                throw new Error('replace failed');
            })
            .mockImplementationOnce(async (source: string) => {
                mocks.persisted = mocks.staged.get(source) ?? null;
            });
        const {saveWorkspaceCheckpoint} = await import('@electron/workspaceCheckpointStore');

        const first = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        const firstResult = first.then(
            () => null,
            (error: unknown) => error,
        );
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledTimes(1));
        const second = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        const third = saveWorkspaceCheckpoint(createCheckpoint(3), 10);

        firstGate.resolve();
        await Promise.all([
            second,
            third,
        ]);

        await expect(firstResult).resolves.toEqual(new Error('replace failed'));
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(3);
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

    it('suppresses late saves from a discarded renderer until its token-bound resume', async () => {
        const firstGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(async (source: string) => {
                await firstGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
            })
            .mockImplementation(async (source: string) => {
                mocks.persisted = mocks.staged.get(source) ?? null;
            });
        const {
            discardWorkspaceCheckpoint,
            resumeWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const activeSave = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledOnce());
        const discard = discardWorkspaceCheckpoint(10);
        const lateSave = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        firstGate.resolve();

        const [
            ,
            discardToken,
        ] = await Promise.all([
            activeSave,
            discard,
            lateSave,
        ]);
        expect(mocks.persisted).toBeNull();
        expect(mocks.atomicReplace).toHaveBeenCalledOnce();

        resumeWorkspaceCheckpoint(10, discardToken);
        await saveWorkspaceCheckpoint(createCheckpoint(3), 10);
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(3);
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(2);
    });

    it('does not let a claim already behind the write barrier resume a later discard', async () => {
        const firstGate = deferred();
        mocks.atomicReplace
            .mockImplementationOnce(async (source: string) => {
                await firstGate.promise;
                mocks.persisted = mocks.staged.get(source) ?? null;
            })
            .mockImplementation(async (source: string) => {
                mocks.persisted = mocks.staged.get(source) ?? null;
            });
        const {
            claimWorkspaceCheckpoint,
            discardWorkspaceCheckpoint,
            resumeWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const activeSave = saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        await vi.waitFor(() => expect(mocks.atomicReplace).toHaveBeenCalledOnce());
        const staleClaim = claimWorkspaceCheckpoint(10);
        const discard = discardWorkspaceCheckpoint(10);
        const retiringRendererSave = saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        firstGate.resolve();

        await activeSave;
        await expect(staleClaim).resolves.toMatchObject({capturedAt: 1});
        const discardToken = await discard;
        await retiringRendererSave;
        await saveWorkspaceCheckpoint(createCheckpoint(3), 10);
        expect(mocks.persisted).toBeNull();
        expect(mocks.atomicReplace).toHaveBeenCalledOnce();

        resumeWorkspaceCheckpoint(10, discardToken);
        await saveWorkspaceCheckpoint(createCheckpoint(4), 10);
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(4);
        expect(mocks.atomicReplace).toHaveBeenCalledTimes(2);
    });

    it('rejects a stale resume token after a newer discard', async () => {
        const {
            discardWorkspaceCheckpoint,
            resumeWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        const staleToken = await discardWorkspaceCheckpoint(10);
        const currentToken = await discardWorkspaceCheckpoint(10);
        expect(() => resumeWorkspaceCheckpoint(10, staleToken)).toThrow('stale or invalid');
        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        expect(mocks.atomicReplace).not.toHaveBeenCalled();

        resumeWorkspaceCheckpoint(10, currentToken);
        await saveWorkspaceCheckpoint(createCheckpoint(2), 10);
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(2);
    });

    it('rolls back suppression when checkpoint deletion fails', async () => {
        mocks.remove.mockRejectedValueOnce(new Error('checkpoint delete failed'));
        mocks.atomicReplace.mockImplementation(async (source: string) => {
            mocks.persisted = mocks.staged.get(source) ?? null;
        });
        const {
            discardWorkspaceCheckpoint,
            saveWorkspaceCheckpoint,
        } = await import('@electron/workspaceCheckpointStore');

        await expect(discardWorkspaceCheckpoint(10)).rejects.toThrow('checkpoint delete failed');
        await saveWorkspaceCheckpoint(createCheckpoint(1), 10);
        expect(JSON.parse(mocks.persisted ?? '{}').checkpoint.capturedAt).toBe(1);
    });
});
