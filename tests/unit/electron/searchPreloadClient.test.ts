import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IpcRenderer } from 'electron';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';

const SEARCH_CHANNELS = SEARCH_PLATFORM_FEATURE.invokeChannels;
const SEARCH_EVENT_CHANNELS = SEARCH_PLATFORM_FEATURE.eventChannels;

describe('derived Search preload client', () => {
    it('normalizes search requests before invoking main', async () => {
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(async () => ({
                results: [],
                truncated: false,
            })),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(ipcRenderer as IpcRenderer, SEARCH_PLATFORM_FEATURE);

        await client.run('  /tmp/work.pdf  ', 'needle', {
            requestId: '  search-1  ',
            pageCount: 12,
            matchCase: true,
            wholeWord: false,
            useRegex: false,
        });

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(SEARCH_CHANNELS.run, {
            pdfPath: '/tmp/work.pdf',
            query: 'needle',
            requestId: 'search-1',
            pageCount: 12,
            matchCase: true,
            wholeWord: false,
            useRegex: false,
        });
    });

    it('rejects invalid preload search requests before invoking main', async () => {
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(ipcRenderer as IpcRenderer, SEARCH_PLATFORM_FEATURE);

        expect(() => client.run('/tmp/work.pdf', 'needle', {requestId: 'x'.repeat(129)}))
            .toThrow('requestId exceeds maximum length (128)');
        expect(ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('labels rejected search invokes with the IPC channel and original cause', async () => {
        const cause = Object.assign(new Error('path denied'), {errorEnvelope: {
            code: 'SEARCH_PATH_DENIED',
            message: 'Search path denied',
            retryable: false,
            timestamp: 123,
        }});
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(async () => {
                throw cause;
            }),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(ipcRenderer as IpcRenderer, SEARCH_PLATFORM_FEATURE);

        await expect(client.run('/tmp/work.pdf', 'needle')).rejects.toMatchObject({
            name: 'PlatformIpcInvokeError',
            channel: SEARCH_CHANNELS.run,
            cause,
        });
    });

    it('rejects malformed search results returned across IPC', async () => {
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(async () => ({
                results: [{
                    pageNumber: 0,
                    pageMatchIndex: 0.5,
                    matchIndex: 0,
                    startOffset: -1,
                    endOffset: 4,
                    excerpt: {
                        prefix: false,
                        suffix: false,
                        before: '',
                        match: 'term',
                        after: '',
                    },
                    words: [null],
                }],
                truncated: false,
            })),
            on: vi.fn(),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(ipcRenderer as IpcRenderer, SEARCH_PLATFORM_FEATURE);

        await expect(client.run('/tmp/work.pdf', 'term')).rejects.toMatchObject({
            name: 'PlatformIpcInvokeError',
            channel: SEARCH_CHANNELS.run,
        });
    });

    it('drops malformed search progress events before callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer: Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'> = {
            invoke: vi.fn(),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
                return ipcRenderer as IpcRenderer;
            }),
            removeListener: vi.fn(),
        };
        const client = createPlatformFeaturePreloadClient(ipcRenderer as IpcRenderer, SEARCH_PLATFORM_FEATURE);
        const callback = vi.fn();

        client.onProgress(callback);
        listeners.get(SEARCH_EVENT_CHANNELS.onProgress)?.({}, {
            requestId: 'search-1',
            processed: 1,
            total: 2,
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 4,
                endOffset: 8,
                excerpt: {
                    prefix: false,
                    suffix: true,
                    before: 'one ',
                    match: 'term',
                    after: ' two',
                },
            }],
            resultsStartIndex: 5,
            truncated: false,
            canceled: false,
        });
        listeners.get(SEARCH_EVENT_CHANNELS.onProgress)?.({}, {
            requestId: 'search-canceled',
            processed: 0,
            total: 0,
            canceled: true,
        });
        listeners.get(SEARCH_EVENT_CHANNELS.onProgress)?.({}, {
            requestId: 'search-2',
            processed: '1',
            total: 2,
        });
        listeners.get(SEARCH_EVENT_CHANNELS.onProgress)?.({}, {
            requestId: 'search-3',
            processed: 1,
            total: 2,
            results: [{
                pageNumber: 1,
                pageMatchIndex: 0,
                matchIndex: 0,
                startOffset: 4,
                endOffset: 8,
                excerpt: {match: 'term'},
            }],
        });
        listeners.get(SEARCH_EVENT_CHANNELS.onProgress)?.({}, {
            requestId: 'search-4',
            processed: 1,
            total: 2,
            canceled: 'yes',
        });

        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback).toHaveBeenCalledWith(expect.objectContaining({
            requestId: 'search-1',
            processed: 1,
            resultsStartIndex: 5,
            results: [expect.objectContaining({pageNumber: 1})],
        }));
        expect(callback).toHaveBeenCalledWith({
            requestId: 'search-canceled',
            processed: 0,
            total: 0,
            canceled: true,
        });
    });
});
