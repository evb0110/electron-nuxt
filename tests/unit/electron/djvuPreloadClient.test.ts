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
        const readyCallback = vi.fn();
        const errorCallback = vi.fn();

        client.onProgress(progressCallback);
        client.onViewingReady(readyCallback);
        client.onViewingError(errorCallback);
        listeners.get(DJVU_EVENT_CHANNELS.progress)?.({}, {
            jobId: 'djvu-1',
            phase: 'converting',
            percent: 25,
        });
        listeners.get(DJVU_EVENT_CHANNELS.progress)?.({}, {
            jobId: 'djvu-2',
            phase: 'invalid',
            percent: 25,
        });
        listeners.get(DJVU_EVENT_CHANNELS.viewingReady)?.({}, {
            pdfPath: '/tmp/view.pdf',
            isPartial: true,
            jobId: 'view-1',
        });
        listeners.get(DJVU_EVENT_CHANNELS.viewingReady)?.({}, {
            pdfPath: '/tmp/view.pdf',
            isPartial: 'yes',
        });
        listeners.get(DJVU_EVENT_CHANNELS.viewingError)?.({}, {
            error: 'failed',
            jobId: 'view-1',
        });
        listeners.get(DJVU_EVENT_CHANNELS.viewingError)?.({}, {error: 42});

        expect(progressCallback).toHaveBeenCalledOnce();
        expect(progressCallback).toHaveBeenCalledWith({
            jobId: 'djvu-1',
            phase: 'converting',
            percent: 25,
        });
        expect(readyCallback).toHaveBeenCalledOnce();
        expect(readyCallback).toHaveBeenCalledWith({
            pdfPath: '/tmp/view.pdf',
            isPartial: true,
            jobId: 'view-1',
        });
        expect(errorCallback).toHaveBeenCalledOnce();
        expect(errorCallback).toHaveBeenCalledWith({
            error: 'failed',
            jobId: 'view-1',
        });
    });
});
