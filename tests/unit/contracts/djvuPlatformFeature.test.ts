import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import { DJVU_PLATFORM_FEATURE } from '@contracts/djvuPlatformFeature';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';
import { cast } from '@tests/helpers/cast';

const channels = DJVU_PLATFORM_FEATURE.invokeChannels;
const eventChannels = DJVU_PLATFORM_FEATURE.eventChannels;

describe('DjVu platform feature', () => {
    it('preserves channels, timeouts, menu shape, and registry replay policy', () => {
        expect(channels).toEqual({
            startOpenForViewing: 'djvu:open:start',
            awaitOpenJob: 'djvu:open:await',
            openForViewing: 'djvu:openForViewing',
            releaseViewingPath: 'djvu:releaseViewingPath',
            convertToPdf: 'djvu:convertToPdf',
            startConvertToPdf: 'djvu:convert:start',
            awaitConvertJob: 'djvu:convert:await',
            printDjvuPath: 'djvu:printDjvuPath',
            cancel: 'djvu:cancel',
            getJobState: 'djvu:job:getState',
            subscribeJob: 'djvu:job:subscribe',
            cancelPagePreview: 'djvu:cancelPagePreview',
            searchText: 'djvu:text:search',
            cancelTextSearch: 'djvu:text:cancel',
            getInfo: 'djvu:getInfo',
            getPageSourceInfo: 'djvu:getPageSourceInfo',
            getPageSizes: 'djvu:getPageSizes',
            renderPagePreview: 'djvu:renderPagePreview',
            estimateSizes: 'djvu:estimateSizes',
            cleanupTemp: 'djvu:cleanupTemp',
            subscribeProgress: 'djvu:progress:subscribe',
        });
        expect(eventChannels).toEqual({
            onProgress: 'djvu:progress',
            onTextSearchProgress: 'djvu:text:progress',
            onMenuConvertToPdf: 'menu:convertToPdf',
        });
        expect(DJVU_PLATFORM_FEATURE.events.onMenuConvertToPdf.payload.decode(undefined))
            .toBeUndefined();
        expect(() => DJVU_PLATFORM_FEATURE.events.onMenuConvertToPdf.payload.decode('payload'))
            .toThrow('expected an undefined IPC result');
        const replay = DJVU_PLATFORM_FEATURE.events.onProgress.subscription.replay;
        expect(replay).toMatchObject({
            intervalMs: 50,
            mode: 'latest-per-key',
            owner: 'ipc-progress-pump',
            terminalRetentionMs: 30_000,
        });
        expect(replay.key({
            jobId: 'job-1',
            phase: 'printing',
            percent: 50,
        })).toBe('job-1:printing');
        expect(replay.terminal({
            jobId: 'job-1',
            phase: 'printing',
            percent: 100,
            status: 'success',
        })).toBe(true);
        expect(DJVU_PLATFORM_FEATURE.methods.startOpenForViewing.ipc.timeoutMs)
            .toBe(30 * 60 * 1_000);
        expect(DJVU_PLATFORM_FEATURE.methods.renderPagePreview.ipc.timeoutMs)
            .toBe(30 * 60 * 1_000);
    });

    it('rejects oversized preview request ids before invoking main', async () => {
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(
            cast<IpcRenderer>(ipcRenderer),
            DJVU_PLATFORM_FEATURE,
        );
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
        const client = createPlatformFeaturePreloadClient(
            cast<IpcRenderer>(ipcRenderer),
            DJVU_PLATFORM_FEATURE,
        );
        const progressCallback = vi.fn();

        client.onProgress(progressCallback);
        listeners.get(eventChannels.onProgress)?.({}, {
            jobId: 'djvu-1',
            phase: 'converting',
            percent: 25,
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            jobId: 'djvu-1',
            phase: 'printing',
            percent: 100,
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            jobId: 'djvu-terminal',
            phase: 'converting',
            percent: 100,
            status: 'failed',
            error: 'failed',
        });
        listeners.get(eventChannels.onProgress)?.({}, {
            jobId: 'djvu-2',
            phase: 'invalid',
            percent: 25,
        });
        listeners.get(eventChannels.onProgress)?.({}, {
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
        const client = createPlatformFeaturePreloadClient(
            cast<IpcRenderer>(ipcRenderer),
            DJVU_PLATFORM_FEATURE,
        );

        await expect(client.searchText('/tmp/book.djvu', 'needle', {
            requestId: 'djvu-search-1',
            pageCount: 431,
            wholeWord: true,
        })).resolves.toEqual({
            results: [],
            truncated: false,
        });

        expect(invoke).toHaveBeenCalledWith(
            channels.searchText,
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
