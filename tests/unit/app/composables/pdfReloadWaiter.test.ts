import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { capturePdfReloadSnapshot } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/capturePdfReloadSnapshot';
import { createPdfReloadWaiter } from '@app/modules/pdf-viewer/engine/pdf-reload-waiter/createPdfReloadWaiter';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { cast } from '@tests/helpers/cast';

describe('capturePdfReloadSnapshot', () => {
    it('prefers the captured anchor page over the fallback page', () => {
        const result = capturePdfReloadSnapshot({
            scrollToPage: vi.fn(),
            captureScrollSnapshot: () => ({
                width: 100,
                height: 200,
                centerX: 50,
                centerY: 80,
                anchorPage: 7,
            }),
        }, 3);

        expect(result.pageToRestore).toBe(7);
        expect(result.scrollSnapshot?.anchorPage).toBe(7);
    });
});

describe('createPdfReloadWaiter', () => {
    it('restores the provided scroll snapshot after the PDF document reloads', async () => {
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ id: 'before' }));
        const restoreScrollSnapshot = vi.fn();

        const waiter = createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                restoreScrollSnapshot,
            }),
            resetSearchCache: vi.fn(),
            pageToRestore: 5,
            scrollSnapshot: {
                width: 300,
                height: 400,
                centerX: 120,
                centerY: 220,
                anchorPage: 5,
            },
        });

        pdfDocument.value = cast({ id: 'after' });
        await waiter.promise;

        expect(restoreScrollSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ anchorPage: 5 }),
            { fallbackPage: 5 },
        );
    });

    it('uses page-only restoration when scroll snapshot capture is disabled', async () => {
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ id: 'before' }));
        const scrollToPage = vi.fn();
        const restoreScrollSnapshot = vi.fn();

        const waiter = createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef: ref({
                scrollToPage,
                restoreScrollSnapshot,
            }),
            resetSearchCache: vi.fn(),
            pageToRestore: 6,
            captureScrollSnapshot: false,
        });

        pdfDocument.value = cast({ id: 'after' });
        await waiter.promise;

        expect(scrollToPage).toHaveBeenCalledWith(6);
        expect(restoreScrollSnapshot).not.toHaveBeenCalled();
    });

    it('can wait for reload completion without restoring scroll', async () => {
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ id: 'before' }));
        const scrollToPage = vi.fn();
        const restoreScrollSnapshot = vi.fn();
        const resetSearchCache = vi.fn();

        const waiter = createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef: ref({
                scrollToPage,
                restoreScrollSnapshot,
            }),
            resetSearchCache,
            pageToRestore: 8,
            scrollSnapshot: {
                width: 300,
                height: 400,
                centerX: 120,
                centerY: 220,
                anchorPage: 8,
            },
            restoreScroll: false,
        });

        pdfDocument.value = cast({ id: 'after' });
        await waiter.promise;

        expect(resetSearchCache).toHaveBeenCalledTimes(1);
        expect(scrollToPage).not.toHaveBeenCalled();
        expect(restoreScrollSnapshot).not.toHaveBeenCalled();
    });

    it('waits for the viewer load-settle hook before restoring scroll state', async () => {
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({ id: 'before' }));
        const restoreScrollSnapshot = vi.fn();
        let resolveViewerSettle = () => {};
        const viewerSettlePromise = new Promise<void>((resolve) => {
            resolveViewerSettle = resolve;
        });

        const waiter = createPdfReloadWaiter({
            pdfDocument,
            pdfViewerRef: ref({
                scrollToPage: vi.fn(),
                restoreScrollSnapshot,
                waitForViewerLoadSettled: () => viewerSettlePromise,
            }),
            resetSearchCache: vi.fn(),
            pageToRestore: 4,
            scrollSnapshot: {
                width: 300,
                height: 400,
                centerX: 120,
                centerY: 220,
                anchorPage: 4,
            },
        });

        pdfDocument.value = cast({ id: 'after' });
        await Promise.resolve();

        expect(restoreScrollSnapshot).not.toHaveBeenCalled();

        resolveViewerSettle();
        await waiter.promise;

        expect(restoreScrollSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ anchorPage: 4 }),
            { fallbackPage: 4 },
        );
    });
});
