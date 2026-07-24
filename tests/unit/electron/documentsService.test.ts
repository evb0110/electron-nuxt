import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    backingEntry: {
        backingState: 'lazy-original' as const,
        originalPath: '/private/source.pdf',
        ownerWebContentsId: 7,
        registeredAtMs: 0,
        registrationId: 1,
        role: 'current' as const,
    },
    progressListener: null as null | ((progress: {
        bytesCopied: number;
        documentRef: string;
        errorCode?: 'WORKING_COPY_MATERIALIZATION_NO_SPACE';
        operationId: string;
        percent: number;
        phase: 'copying' | 'finalizing';
        reason: 'background';
        status: 'running' | 'completed' | 'failed';
        totalBytes: number;
    }) => void),
}));

vi.mock('@electron/file-access/workingCopyMaterialization', () => ({
    onWorkingCopyBackingSwapCacheInvalidation: vi.fn(),
    onWorkingCopyMaterializationProgress: (listener: typeof mocks.progressListener) => {
        mocks.progressListener = listener;
        return vi.fn();
    },
}));

vi.mock('@electron/file-access/workingCopyStore', () => ({
    getWorkingCopyBackingEntry: () => mocks.backingEntry,
    normalizePathForLookup: (path: string) => path,
}));

const { createDocumentsService } = await import('@electron/features/documents/createDocumentsService');

function emitProgress(percent: number, status: 'running' | 'completed' | 'failed' = 'running') {
    mocks.progressListener?.({
        bytesCopied: percent,
        documentRef: '/tmp/managed.pdf',
        ...(status === 'failed'
            ? {errorCode: 'WORKING_COPY_MATERIALIZATION_NO_SPACE' as const}
            : {}),
        operationId: 'materialize-1',
        percent,
        phase: status === 'running' ? 'copying' : 'finalizing',
        reason: 'background',
        status,
        totalBytes: 100,
    });
}

describe('documents service working-copy backing status', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.progressListener = null;
        mocks.backingEntry.backingState = 'lazy-original';
        delete (mocks.backingEntry as {sourceBackingErrorCode?: string}).sourceBackingErrorCode;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('queries a renderer-safe status without exposing the original path', async () => {
        const service = createDocumentsService();

        expect(service.getWorkingCopyBackingStatus(
            {senderId: 7},
            '/tmp/managed.pdf',
        )).toEqual({
            documentRef: '/tmp/managed.pdf',
            failure: null,
            progress: 0,
            state: 'lazy-original',
        });
    });

    it('publishes typed status changes while preserving monotonic progress', () => {
        const service = createDocumentsService();
        const listener = vi.fn();
        service.onWorkingCopyBackingStatusChanged(listener);

        emitProgress(10);
        emitProgress(40);
        emitProgress(25);

        expect(listener).toHaveBeenCalledTimes(3);
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({status: expect.objectContaining({progress: 0.4})}));

        emitProgress(40, 'completed');
        expect(listener).toHaveBeenCalledTimes(4);
        expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({
            ownerWebContentsId: 7,
            status: {
                documentRef: '/tmp/managed.pdf',
                failure: null,
                progress: 1,
                state: 'materialized',
            },
        }));
    });
});
