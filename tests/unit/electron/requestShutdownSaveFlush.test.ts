import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { requestShutdownSaveFlush } from '@electron/bootstrap/requestShutdownSaveFlush';

const state = vi.hoisted(() => ({
    listener: null as null | ((event: {sender: {id: number}}, payload: unknown) => void),
    workingCopyMap: new Map<string, {
        backingState: 'lazy-original' | 'materialized';
        ownerWebContentsId?: number;
    }>(),
}));

vi.mock('electron', () => ({ipcMain: {
    on: vi.fn((_channel: string, listener: typeof state.listener) => {
        state.listener = listener;
    }),
    removeListener: vi.fn((_channel: string, listener: typeof state.listener) => {
        if (state.listener === listener) {
            state.listener = null;
        }
    }),
}}));

vi.mock('@electron/file-access/workingCopyStore', () => ({workingCopyMap: state.workingCopyMap}));

function createWindow(
    response: (requestId: string) => {
        dirtyWorkingCopyPaths?: string[];
        error?: string;
        flushedWorkingCopyPaths?: string[];
    },
) {
    return {
        id: 1,
        isDestroyed: () => false,
        webContents: {
            id: 7,
            isDestroyed: () => false,
            send: vi.fn((_channel: string, payload: {requestId: string}) => {
                state.listener?.(
                    {sender: {id: 7}},
                    {
                        requestId: payload.requestId,
                        ...response(payload.requestId),
                    },
                );
            }),
        },
    };
}

describe('requestShutdownSaveFlush', () => {
    beforeEach(() => {
        state.listener = null;
        state.workingCopyMap.clear();
    });

    it('preserves all owned working copies when the renderer flush reports a failure', async () => {
        const workingCopyPath = '/tmp/pdf-work-failed/working.pdf';
        state.workingCopyMap.set(workingCopyPath, {
            backingState: 'materialized',
            ownerWebContentsId: 7,
        });
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };

        await expect(requestShutdownSaveFlush({
            getWindows: () => [createWindow(() => ({error: 'save failed'})) as never],
            logger,
            timeoutMs: 1_000,
        })).resolves.toEqual({
            dirtyWorkingCopyPaths: [workingCopyPath],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        });
    });

    it('rejects a dirty lazy working copy reported as flushed', async () => {
        const workingCopyPath = '/tmp/pdf-work-lazy/working.pdf';
        state.workingCopyMap.set(workingCopyPath, {
            backingState: 'lazy-original',
            ownerWebContentsId: 7,
        });
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };

        await expect(requestShutdownSaveFlush({
            getWindows: () => [createWindow(() => ({flushedWorkingCopyPaths: [workingCopyPath]})) as never],
            logger,
            timeoutMs: 1_000,
        })).resolves.toEqual({
            dirtyWorkingCopyPaths: [workingCopyPath],
            flushedWorkingCopyPaths: [],
            timedOutWindowIds: [],
        });
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringContaining('WORKING_COPY_SHUTDOWN_FLUSH_UNMATERIALIZED'),
        );
    });
});
