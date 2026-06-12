import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';

const documentsClientMock = vi.hoisted(() => ({
    openDocumentDirect: vi.fn(async (path: string) => ({ path })),
    openPdfDirect: vi.fn(async (path: string) => ({ path })),
    openDocumentDirectBatch: vi.fn(async (paths: string[]) => paths),
    openPdfDirectBatch: vi.fn(async (paths: string[]) => paths),
    recentFiles: { get: vi.fn(async () => []) },
}));
const pageOpsClientMock = vi.hoisted(() => ({ rotate: vi.fn() }));
const imageExportClientMock = vi.hoisted(() => ({ exportPdfToImages: vi.fn() }));

vi.mock('@electron/features/documents/createDocumentsPreloadClient', () => ({createDocumentsPreloadClient: () => documentsClientMock}));
vi.mock('@electron/features/documents/createDocumentsPreloadPageOpsClient', () => ({createDocumentsPreloadPageOpsClient: () => pageOpsClientMock}));
vi.mock('@electron/features/image-export/createImageExportPreloadClient', () => ({createImageExportPreloadClient: () => imageExportClientMock}));
vi.mock('@electron/features/ocr/createOcrPreloadClient', () => ({ createOcrPreloadClient: () => ({}) }));
vi.mock('@electron/features/search/createSearchPreloadClient', () => ({ createSearchPreloadClient: () => ({}) }));
vi.mock('@electron/features/djvu/createDjvuPreloadClient', () => ({ createDjvuPreloadClient: () => ({}) }));
vi.mock('@electron/preload/debugLogBuffer', () => ({ getDebugLogMessages: () => [] }));

describe('createElectronApi', () => {
    it('keeps page operations and image export out of the documents capability', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
        );
        expect('pageOps' in api.documents).toBe(false);
        expect('exportPdfToImages' in api.documents).toBe(false);
        expect(api.pageOps).toBe(pageOpsClientMock);
        expect(api.imageExport).toBe(imageExportClientMock);
        expect(typeof api.system.getMemoryInfo).toBe('function');
    });

    it('awaits renderer file-open authorization before single-file direct open', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => 'token' });
        const invocations: string[] = [];
        const allowDeferred: { resolve?: () => void } = {};
        const ipcRenderer = {
            invoke: vi.fn((channel: string) => {
                invocations.push(channel);
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenToken) {
                    return Promise.resolve();
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpen) {
                    return new Promise<void>((resolve) => {
                        allowDeferred.resolve = resolve;
                    });
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '/tmp/from-picker.pdf' },
        );

        expect(api.documents.getPathForFile({} as File)).toBe('/tmp/from-picker.pdf');
        const openPromise = api.documents.openPdfDirect('/tmp/from-picker.pdf');
        await Promise.resolve();
        expect(documentsClientMock.openPdfDirect).not.toHaveBeenCalled();

        if (!allowDeferred.resolve) {
            throw new Error('Expected renderer file-open authorization to be pending');
        }
        allowDeferred.resolve();
        await expect(openPromise).resolves.toEqual({ path: '/tmp/from-picker.pdf' });
        expect(invocations).toContain(DOCUMENTS_CHANNELS.allowRendererFileOpen);
        expect(documentsClientMock.openDocumentDirect).toHaveBeenCalledWith('/tmp/from-picker.pdf');
    });
});
