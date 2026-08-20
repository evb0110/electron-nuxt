import {
    existsSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    mkdtemp,
    rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
    dirname,
    join,
} from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import {
    cleanupWorkingCopy,
    settleAllWorkingCopyMaterializations,
} from '@electron/file-access/workingCopyCleanup';

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

const state = vi.hoisted(() => ({
    cancelAbortableOperations: vi.fn(() => 0),
    cancelMaterialization: vi.fn(),
    ensureMaterialized: vi.fn(),
    fenceRegistrations: [] as number[],
    operations: [] as Array<{
        aborted: boolean;
        commitStarted: boolean;
        id: string;
        kind: 'abortable-work' | 'critical-write';
        workingCopyPath: string;
    }>,
    tempRoot: '',
    workingCopyMap: new Map<string, {
        admissionSnapshot?: {
            mtimeNs: bigint;
            size: bigint;
        };
        backingState: 'eager' | 'materializing';
        originalPath: string;
        ownerWebContentsId?: number;
        registeredAtMs: number;
        registrationId: number;
        role: 'current';
    }>(),
}));

vi.mock('@electron/file-access/workingCopyStore', () => ({
    clearRetiredWorkingCopyOriginals: vi.fn(),
    forgetRetiredWorkingCopyOriginal: vi.fn(),
    forgetWorkingCopyOriginalPath: (path: string) => state.workingCopyMap.delete(path),
    getWorkingCopyOwnerWebContentsId: (path: string) => state.workingCopyMap.get(path)?.ownerWebContentsId,
    rememberRetiredWorkingCopyOriginal: vi.fn(),
    runWithWorkingCopyRegistrationFence: async (
        path: string,
        registrationId: number,
        operation: (entry: unknown) => unknown,
    ) => {
        state.fenceRegistrations.push(registrationId);
        const entry = state.workingCopyMap.get(path);
        if (!entry || entry.registrationId !== registrationId) {
            return {matched: false as const};
        }
        return {
            matched: true as const,
            value: await operation(entry),
        };
    },
    workingCopyMap: state.workingCopyMap,
}));

vi.mock('@electron/file-access/workingCopyMaterialization', () => ({
    cancelWorkingCopyMaterialization: state.cancelMaterialization,
    ensureWorkingCopyMaterialized: state.ensureMaterialized,
}));

vi.mock('@electron/operation-lifecycle/mainOperationLifecycle', () => ({
    cancelAbortableMainOperationsForWorkingCopy: state.cancelAbortableOperations,
    snapshotMainOperations: () => state.operations,
}));

vi.mock('@electron/file-access/workingCopyDirectory', () => ({
    isWorkingCopyDirectoryName: (name: string) => name.startsWith('pdf-work-'),
    safeRemoveDirectory: vi.fn(async () => false),
}));

vi.mock('@electron/utils/appTempDir', () => ({
    getAppTempDir: () => state.tempRoot,
    getLegacyAppTempDirPath: () => join(dirname(state.tempRoot), 'evb-viewer'),
}));

vi.mock('@electron/file-access/workingCopyMutationQueue', () => ({drainWorkingCopyMutations: vi.fn(async () => undefined)}));

vi.mock('@electron/file-access/documentRevisionStore', () => ({
    clearWorkingCopyRevisionInitializations: vi.fn(),
    forgetWorkingCopyRevisionInitialization: vi.fn(),
    hasWorkingCopySyncRequired: vi.fn(() => false),
}));

vi.mock('@electron/file-access/pageIdentityStore', () => ({
    clearPageIdentityStoreInitializations: vi.fn(),
    forgetPageIdentityStoreInitialization: vi.fn(),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
})}));

function registerWorkingCopy(
    workingPath: string,
    originalPath: string,
    backingState: 'eager' | 'materializing',
) {
    state.workingCopyMap.set(workingPath, {
        backingState,
        originalPath,
        ownerWebContentsId: 7,
        registeredAtMs: Date.now(),
        registrationId: 73,
        role: 'current',
    });
}

describe('working-copy cleanup materialization retirement', () => {
    beforeEach(async () => {
        state.tempRoot = await mkdtemp(join(tmpdir(), 'evb-working-copy-cleanup-'));
        state.cancelAbortableOperations.mockClear();
        state.cancelMaterialization.mockReset();
        state.ensureMaterialized.mockReset();
        state.fenceRegistrations.length = 0;
        state.operations.length = 0;
        state.workingCopyMap.clear();
    });

    afterEach(async () => {
        await rm(state.tempRoot, {
            force: true,
            recursive: true,
        });
    });

    it('joins demanded materialization for the captured registration before retirement', async () => {
        const originalPath = join(state.tempRoot, 'original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-demand', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'materializing');
        state.operations.push(
            {
                aborted: false,
                commitStarted: false,
                id: 'background-flight',
                kind: 'abortable-work',
                workingCopyPath: workingPath,
            },
            {
                aborted: false,
                commitStarted: false,
                id: 'demand-waiter',
                kind: 'critical-write',
                workingCopyPath: workingPath,
            },
        );
        const materialization = createDeferred<{
            logicalRef: string;
            physicalWorkingCopyPath: string;
            sourceFingerprint: string;
        }>();
        state.ensureMaterialized.mockReturnValue(materialization.promise);

        const cleanup = cleanupWorkingCopy(workingPath, 7);
        await vi.waitFor(() => {
            expect(state.ensureMaterialized).toHaveBeenCalledOnce();
        });

        expect(state.cancelMaterialization).not.toHaveBeenCalled();
        expect(existsSync(dirname(workingPath))).toBe(true);

        state.operations.length = 0;
        materialization.resolve({
            logicalRef: workingPath,
            physicalWorkingCopyPath: workingPath,
            sourceFingerprint: 'sha256-full-v1:abc',
        });
        await cleanup;

        expect(state.fenceRegistrations).toEqual([
            73,
            73,
        ]);
        expect(existsSync(dirname(workingPath))).toBe(false);
        expect(existsSync(originalPath)).toBe(true);
    });

    it('cancels and settles a background-only materializer before deletion', async () => {
        const originalPath = join(state.tempRoot, 'background-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-background', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'partial');
        registerWorkingCopy(workingPath, originalPath, 'materializing');
        state.operations.push(
            {
                aborted: false,
                commitStarted: false,
                id: 'stale-registration-flight',
                kind: 'abortable-work',
                workingCopyPath: workingPath,
            },
            {
                aborted: false,
                commitStarted: false,
                id: 'background-flight',
                kind: 'abortable-work',
                workingCopyPath: workingPath,
            },
        );
        const materialization = createDeferred<never>();
        state.ensureMaterialized.mockReturnValue(materialization.promise);
        state.cancelMaterialization.mockImplementation(() => {
            state.operations.length = 0;
            materialization.reject(new Error('cancelled'));
            return true;
        });

        await cleanupWorkingCopy(workingPath, 7);

        expect(state.cancelMaterialization).toHaveBeenCalledWith(
            'background-flight',
            'Working-copy materialization cancelled during cleanup',
        );
        expect(state.fenceRegistrations).toEqual([
            73,
            73,
        ]);
        expect(existsSync(dirname(workingPath))).toBe(false);
        expect(existsSync(originalPath)).toBe(true);
    });

    it('waits for an already-aborted shutdown flight when new demand admission is closed', async () => {
        const originalPath = join(state.tempRoot, 'shutdown-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-shutdown', 'working.pdf');
        registerWorkingCopy(workingPath, originalPath, 'materializing');
        state.operations.push({
            aborted: true,
            commitStarted: false,
            id: 'aborted-background-flight',
            kind: 'abortable-work',
            workingCopyPath: workingPath,
        });
        state.ensureMaterialized.mockRejectedValue(new Error('Main process is shutting down'));
        state.cancelMaterialization.mockImplementation(() => {
            setImmediate(() => {
                state.operations.length = 0;
            });
            return false;
        });

        await settleAllWorkingCopyMaterializations();

        expect(state.cancelMaterialization).toHaveBeenCalledWith(
            'aborted-background-flight',
            'Working-copy materialization cancelled during cleanup',
        );
        expect(state.workingCopyMap.has(workingPath)).toBe(true);
    });

    it('stops long native work on the working copy before its directory goes away', async () => {
        const originalPath = join(state.tempRoot, 'running-original.pdf');
        const workingPath = join(state.tempRoot, 'pdf-work-running', 'working.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');
        let directoryExistedAtCancel = false;
        state.cancelAbortableOperations.mockImplementation(() => {
            directoryExistedAtCancel = existsSync(dirname(workingPath));
            return 1;
        });

        await cleanupWorkingCopy(workingPath, 7);

        expect(state.cancelAbortableOperations).toHaveBeenCalledWith(workingPath, 'Working copy is closing');
        expect(directoryExistedAtCancel).toBe(true);
        expect(existsSync(dirname(workingPath))).toBe(false);
    });

    it('never deletes an original backing located under the managed directory', async () => {
        const workingPath = join(state.tempRoot, 'pdf-work-protected-original', 'working.pdf');
        const originalPath = join(dirname(workingPath), 'source.pdf');
        mkdirSync(dirname(workingPath), {recursive: true});
        writeFileSync(originalPath, 'original');
        writeFileSync(workingPath, 'managed');
        registerWorkingCopy(workingPath, originalPath, 'eager');

        await cleanupWorkingCopy(workingPath, 7);

        expect(existsSync(originalPath)).toBe(true);
        expect(state.fenceRegistrations).toEqual([73]);
    });
});
