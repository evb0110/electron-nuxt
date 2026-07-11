import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import { DJVU_EVENT_CHANNELS } from '@electron/features/djvu/contract';
import type * as DjvuPreloadClientModule from '@electron/features/djvu/createDjvuPreloadClient';
import { cast } from '@tests/helpers/cast';

describe('createDjvuPreloadClient', () => {
    it('rejects oversized preview request ids before invoking main', async () => {
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const { createDjvuPreloadClient }: typeof DjvuPreloadClientModule = await import('@electron/features/djvu/createDjvuPreloadClient');
        const client = createDjvuPreloadClient(cast<IpcRenderer>(ipcRenderer));
        const oversizedRequestId = 'x'.repeat(129);

        expect(() => client.renderPagePreview('/tmp/book.djvu', 1, {previewRequestId: oversizedRequestId}))
            .toThrow('renderPagePreview.options.previewRequestId exceeds maximum length (128)');
        expect(() => client.cancelPagePreview(oversizedRequestId))
            .toThrow('cancelPagePreview.requestId exceeds maximum length (128)');
        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('drops malformed DjVu events before callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return cast<IpcRenderer>(ipcRenderer);
            }),
            removeListener: vi.fn(),
        };
        const { createDjvuPreloadClient }: typeof DjvuPreloadClientModule = await import('@electron/features/djvu/createDjvuPreloadClient');
        const client = createDjvuPreloadClient(cast<IpcRenderer>(ipcRenderer));
        const progressCallback = vi.fn();

        client.onProgress(progressCallback);
        listeners.get(DJVU_EVENT_CHANNELS.progress)?.({}, {
            jobId: 'djvu-1',
            phase: 'converting',
            percent: 25,
        });
        listeners.get(DJVU_EVENT_CHANNELS.progress)?.({}, {
            jobId: 'djvu-1',
            phase: 'printing',
            percent: 100,
        });
        listeners.get(DJVU_EVENT_CHANNELS.progress)?.({}, {
            jobId: 'djvu-terminal',
            phase: 'converting',
            percent: 100,
            status: 'failed',
            error: 'failed',
        });
        listeners.get(DJVU_EVENT_CHANNELS.progress)?.({}, {
            jobId: 'djvu-2',
            phase: 'invalid',
            percent: 25,
        });
        listeners.get(DJVU_EVENT_CHANNELS.progress)?.({}, {
            jobId: 'djvu-3',
            phase: 'converting',
            percent: 100,
            status: 'invalid',
        });

        expect(progressCallback).toHaveBeenCalledTimes(3);
        expect(progressCallback).toHaveBeenNthCalledWith(1, {
            jobId: 'djvu-1',
            phase: 'converting',
            percent: 25,
        });
        expect(progressCallback).toHaveBeenNthCalledWith(2, {
            jobId: 'djvu-1',
            phase: 'printing',
            percent: 100,
        });
        expect(progressCallback).toHaveBeenNthCalledWith(3, {
            jobId: 'djvu-terminal',
            phase: 'converting',
            percent: 100,
            status: 'failed',
            error: 'failed',
        });
    });
});
