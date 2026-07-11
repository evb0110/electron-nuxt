import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IDocumentsFileIoCapability,
    IPdfNativePagePreview,
} from '@contracts/electronApiDocuments';
import { createNativePdfPreviewSourceFromPath } from '@app/platform/browser-api/createNativePdfPreviewSourceFromPath';
import { workspaceSurfaceBudgetController } from '@app/modules/workspace-shell/memory/workspaceSurfaceBudgetController';

describe('createNativePdfPreviewSourceFromPath', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('cancels active native preview renders when the source terminates', async () => {
        const rejectByRequestId = new Map<string, (error: Error) => void>();
        const documentFiles: Pick<
            IDocumentsFileIoCapability,
            'cancelPdfNativePagePreview' | 'getPdfNativePageSizes' | 'renderPdfNativePagePreview'
        > = {
            cancelPdfNativePagePreview: vi.fn(async (requestId: string) => {
                rejectByRequestId.get(requestId)?.(new Error('Native PDF preview canceled'));
                return {canceled: true};
            }),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async (
                _path: string,
                _pageNumber: number,
                options?: {previewRequestId?: string},
            ) => new Promise<IPdfNativePagePreview>((_resolve, reject: (error: Error) => void) => {
                const requestId = options?.previewRequestId;
                if (!requestId) {
                    throw new Error('Expected previewRequestId');
                }
                rejectByRequestId.set(requestId, reject);
            })),
        };

        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:preview'),
            revokeObjectURL: vi.fn(),
        });

        const source = createNativePdfPreviewSourceFromPath('/tmp/native-preview.pdf', documentFiles);
        const renderPromise = source.renderPageObjectUrl(1);
        await Promise.resolve();

        source.terminate();

        await expect(renderPromise).rejects.toThrow('Native PDF preview canceled');
        expect(documentFiles.cancelPdfNativePagePreview).toHaveBeenCalledWith('pdf-native-preview:1:1');
    });

    it('cancels the active request for a page when that page is reset', async () => {
        const rejectByRequestId = new Map<string, (error: Error) => void>();
        const documentFiles: Pick<
            IDocumentsFileIoCapability,
            'cancelPdfNativePagePreview' | 'getPdfNativePageSizes' | 'renderPdfNativePagePreview'
        > = {
            cancelPdfNativePagePreview: vi.fn(async (requestId: string) => {
                rejectByRequestId.get(requestId)?.(new Error('Native PDF preview canceled'));
                return {canceled: true};
            }),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async (
                _path: string,
                _pageNumber: number,
                options?: {previewRequestId?: string},
            ) => new Promise<IPdfNativePagePreview>((_resolve, reject: (error: Error) => void) => {
                const requestId = options?.previewRequestId;
                if (!requestId) {
                    throw new Error('Expected previewRequestId');
                }
                rejectByRequestId.set(requestId, reject);
            })),
        };

        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:preview'),
            revokeObjectURL: vi.fn(),
        });

        const source = createNativePdfPreviewSourceFromPath('/tmp/native-preview.pdf', documentFiles);
        const renderPromise = source.renderPageObjectUrl(2);
        await Promise.resolve();

        source.cancelPagePreview?.(2);

        await expect(renderPromise).rejects.toThrow('Native PDF preview canceled');
        expect(documentFiles.cancelPdfNativePagePreview).toHaveBeenCalledWith('pdf-native-preview:2:1');
    });

    it('leases decoded native preview surfaces until their object URLs are released', async () => {
        const documentFiles: Pick<
            IDocumentsFileIoCapability,
            'cancelPdfNativePagePreview' | 'getPdfNativePageSizes' | 'renderPdfNativePagePreview'
        > = {
            cancelPdfNativePagePreview: vi.fn(async () => ({canceled: false})),
            getPdfNativePageSizes: vi.fn(async () => []),
            renderPdfNativePagePreview: vi.fn(async () => ({
                bytes: new Uint8Array([
                    1,
                    2,
                    3,
                ]),
                width: 40,
                height: 25,
            })),
        };
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn(() => 'blob:leased-preview'),
            revokeObjectURL: vi.fn(),
        });
        const before = workspaceSurfaceBudgetController.getSnapshot();
        const source = createNativePdfPreviewSourceFromPath('/tmp/leased-preview.pdf', documentFiles);

        const rendered = await source.renderPageObjectUrl(1);

        const leased = workspaceSurfaceBudgetController.getSnapshot();
        expect(leased.reservedBytesByCategory['native-preview'])
            .toBe(before.reservedBytesByCategory['native-preview'] + 40 * 25 * 4);
        source.revokeObjectURL(rendered.objectUrl);
        expect(workspaceSurfaceBudgetController.getSnapshot().reservedBytesByCategory['native-preview'])
            .toBe(before.reservedBytesByCategory['native-preview']);
        expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:leased-preview');
    });
});
