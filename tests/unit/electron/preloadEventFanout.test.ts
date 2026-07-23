import type { IpcRenderer } from 'electron';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import { createDjvuPreloadClient } from '@electron/features/djvu/createDjvuPreloadClient';
import {
    DJVU_CHANNELS,
    DJVU_EVENT_CHANNELS,
} from '@electron/features/djvu/contract';
import { createDocumentsPreloadFileClient } from '@electron/features/documents/createDocumentsPreloadFileClient';
import { createDocumentsPreloadMenuClient } from '@electron/features/documents/createDocumentsPreloadMenuClient';
import { DOCUMENTS_EVENT_CHANNELS } from '@electron/features/documents/contract';
import { createImageExportPreloadClient } from '@electron/features/image-export/createImageExportPreloadClient';
import { IMAGE_EXPORT_CHANNELS } from '@electron/features/image-export/contract';
import { createOcrPreloadClient } from '@electron/features/ocr/createOcrPreloadClient';
import { OCR_CHANNELS } from '@electron/features/ocr/contract';
import { SEARCH_PLATFORM_FEATURE } from '@contracts/searchPlatformFeature';
import { createPlatformFeaturePreloadClient } from '@electron/preload/ipcClient';
import { cast } from '@tests/helpers/cast';

type TEventHandler = (event: unknown, payload: unknown) => void;

function createIpcRendererHarness() {
    const listeners = new Map<string, TEventHandler>();
    const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => undefined);
    const ipcRenderer = {
        invoke,
        postMessage: vi.fn(),
        on: vi.fn((channel: string, handler: TEventHandler) => {
            listeners.set(channel, handler);
            return cast<IpcRenderer>(ipcRenderer);
        }),
        removeListener: vi.fn((channel: string, handler: TEventHandler) => {
            if (listeners.get(channel) === handler) {
                listeners.delete(channel);
            }
            return cast<IpcRenderer>(ipcRenderer);
        }),
    };
    return {
        ipcRenderer: cast<IpcRenderer>(ipcRenderer),
        invoke,
        listeners,
    };
}

describe('preload global event fan-out', () => {
    it('serves many document revision consumers with one native listener', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const client = createDocumentsPreloadFileClient(ipcRenderer);
        const callbacks = Array.from({length: 24}, () => vi.fn());
        const unsubscribes = callbacks.map(callback => client.onDocumentRevisionChanged(callback));

        expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(1);

        const event = {
            version: 1,
            token: requireDocumentRevisionToken('revision-2'),
            previousToken: requireDocumentRevisionToken('revision-1'),
            documentRef: '/tmp/working.pdf',
            authority: 'electron-working-copy',
            contentRevision: 2,
            mintedAt: 123,
            reason: 'write',
        } as const;
        listeners.get(DOCUMENTS_EVENT_CHANNELS.documentRevisionChanged)?.({}, event);
        expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);

        unsubscribes.slice(0, -1).forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).not.toHaveBeenCalled();
        unsubscribes.at(-1)?.();
        unsubscribes.at(-1)?.();
        expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
        expect(listeners.size).toBe(0);
    });

    it('serves many PDF optimization consumers with one native listener', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const client = createDocumentsPreloadMenuClient(ipcRenderer);
        const callbacks = Array.from({length: 24}, () => vi.fn());
        const unsubscribes = callbacks.map(callback => client.onPdfOptimizeProgress(callback));

        expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
        listeners.get(DOCUMENTS_EVENT_CHANNELS.pdfOptimizeProgress)?.({}, {
            requestId: 'optimize-1',
            preset: 'balanced',
            phase: 'optimizing',
            processed: 1,
            total: 2,
            percent: 50,
        });
        expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
    });

    it('serves many DjVu progress consumers with one listener and one main subscription', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const client = createDjvuPreloadClient(ipcRenderer);
        const callbacks = Array.from({length: 24}, () => vi.fn());
        const unsubscribes = callbacks.map(callback => client.onProgress(callback));

        expect(ipcRenderer.on).toHaveBeenCalledTimes(1);
        expect(ipcRenderer.invoke).toHaveBeenCalledTimes(1);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(DJVU_CHANNELS.subscribeProgress);
        listeners.get(DJVU_EVENT_CHANNELS.progress)?.({}, {
            jobId: 'djvu-1',
            phase: 'converting',
            percent: 25,
        });
        expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
    });

    it('fans out validated DjVu text-search progress through one native listener', () => {
        const {
            ipcRenderer,
            listeners,
        } = createIpcRendererHarness();
        const client = createDjvuPreloadClient(ipcRenderer);
        const callbacks = Array.from({length: 24}, () => vi.fn());
        const unsubscribes = callbacks.map(callback => client.onTextSearchProgress(callback));

        expect(ipcRenderer.on).toHaveBeenCalledOnce();
        listeners.get(DJVU_EVENT_CHANNELS.textSearchProgress)?.({}, {
            requestId: 'djvu-search-1',
            processed: 8,
            total: 431,
            resultsStartIndex: 0,
            results: [],
            status: 'running',
        });
        expect(callbacks.every(callback => callback.mock.calls.length === 1)).toBe(true);

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledOnce();
    });

    it('requests each related process-global progress stream only once for many consumers', () => {
        const {
            ipcRenderer,
            invoke,
        } = createIpcRendererHarness();
        const ocr = createOcrPreloadClient(ipcRenderer);
        const search = createPlatformFeaturePreloadClient(ipcRenderer, SEARCH_PLATFORM_FEATURE);
        const imageExport = createImageExportPreloadClient(ipcRenderer);
        const unsubscribes = [
            ...Array.from({length: 24}, () => ocr.onProgress(vi.fn())),
            ...Array.from({length: 24}, () => search.onProgress(vi.fn())),
            ...Array.from({length: 24}, () => imageExport.onProgress(vi.fn())),
        ];

        for (const channel of [
            OCR_CHANNELS.subscribeProgress,
            SEARCH_PLATFORM_FEATURE.invokeChannels.subscribeProgress,
            IMAGE_EXPORT_CHANNELS.subscribeProgress,
        ]) {
            expect(invoke).toHaveBeenCalledWith(channel);
            expect(invoke.mock.calls.filter(call => call[0] === channel)).toHaveLength(1);
        }
        expect(ipcRenderer.on).toHaveBeenCalledTimes(3);

        unsubscribes.forEach(unsubscribe => unsubscribe());
        expect(ipcRenderer.removeListener).toHaveBeenCalledTimes(3);
    });
});
