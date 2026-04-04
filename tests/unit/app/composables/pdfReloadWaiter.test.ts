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
import {
    capturePdfReloadSnapshot,
    createPdfReloadWaiter,
} from '@app/composables/pdf/pdfReloadWaiter';
import type { PDFDocumentProxy } from 'pdfjs-dist';

function cast<T>(value: unknown): T {
    return value as T;
}

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
});
