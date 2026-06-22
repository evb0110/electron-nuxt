import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
    shallowRef,
} from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdf';
import { cast } from '@tests/helpers/cast';

vi.mock('@app/utils/asyncHelpers', () => ({waitForVisualFrames: vi.fn(async () => {})}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {diagnostic: vi.fn()}}));

const { usePdfViewerCurrentPageSync } = await import(
    '@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync'
);

describe('usePdfViewerCurrentPageSync', () => {
    it('invalidates stabilized current-page sync when the document changes mid-sample', async () => {
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(cast({}));
        const emitCurrentPage = vi.fn();
        const getMostVisiblePage = vi.fn(() => 2);
        const scope = effectScope();

        try {
            const sync = scope.run(() => usePdfViewerCurrentPageSync({
                viewerContainer: ref(cast<HTMLElement>({
                    clientHeight: 800,
                    clientWidth: 600,
                    scrollLeft: 0,
                    scrollTop: 0,
                    querySelectorAll: () => [],
                })),
                numPages: ref(10),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                currentPage: ref(1),
                pdfDocument,
                isLoading: ref(false),
                getMostVisiblePage,
                updateCurrentPage: vi.fn(() => 2),
                emitCurrentPage,
            }));
            if (!sync) {
                throw new Error('Failed to create current-page sync');
            }

            const syncPromise = sync.syncCurrentPageFromViewport({
                source: 'test',
                stabilize: true,
            });
            expect(getMostVisiblePage).toHaveBeenCalledOnce();

            pdfDocument.value = null;
            await syncPromise;

            expect(emitCurrentPage).not.toHaveBeenCalled();
        } finally {
            scope.stop();
        }
    });
});
