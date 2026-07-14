import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import {
    DJVU_CHANNELS,
    DJVU_EVENT_CHANNELS,
} from '@electron/features/djvu/contract';
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

    it('normalizes bounded native text-search requests before invoking main', async () => {
        const invoke = vi.fn().mockResolvedValue({
            results: [],
            truncated: false,
        });
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke,
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const {createDjvuPreloadClient}: typeof DjvuPreloadClientModule =
            await import('@electron/features/djvu/createDjvuPreloadClient');
        const client = createDjvuPreloadClient(cast<IpcRenderer>(ipcRenderer));

        await expect(client.searchText('/tmp/book.djvu', 'needle', {
            requestId: 'djvu-search-1',
            pageCount: 431,
            wholeWord: true,
        })).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(invoke).toHaveBeenCalledWith(
            DJVU_CHANNELS.searchText,
            '/tmp/book.djvu',
            'needle',
            {
                requestId: 'djvu-search-1',
                pageCount: 431,
                matchCase: false,
                wholeWord: true,
                useRegex: false,
            },
        );
        expect(() => client.searchText('/tmp/book.djvu', 'needle', {
            requestId: 'x'.repeat(129),
            pageCount: 431,
        })).toThrow('searchText.options.requestId exceeds maximum length (128)');
        expect(() => client.searchText('/tmp/book.djvu', 'needle', {
            requestId: 'djvu-search-2',
            pageCount: 0,
        })).toThrow('searchText.options.pageCount must be a positive safe integer');
    });
});
