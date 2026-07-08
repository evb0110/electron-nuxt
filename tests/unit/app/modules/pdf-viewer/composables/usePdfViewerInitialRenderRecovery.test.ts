// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    ref,
    shallowRef,
} from 'vue';
import { cast } from '@tests/helpers/cast';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { usePdfViewerInitialRenderRecovery } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerInitialRenderRecovery';

describe('usePdfViewerInitialRenderRecovery', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    function createHarness(container: HTMLElement) {
        const reRenderVisiblePagesAndSyncCurrentPage = vi.fn(async () => {});
        const renderVisiblePages = vi.fn(async () => {});
        const syncCurrentPageFromViewport = vi.fn(async () => {});
        const recovery = usePdfViewerInitialRenderRecovery({
            viewerContainer: ref(container),
            pdfDocument: shallowRef(cast<PDFDocumentProxy>({})),
            numPages: ref(1),
            isLoading: ref(false),
            computeFitWidthScale: vi.fn(() => true),
            updateVisibleRange: vi.fn(),
            reRenderVisiblePagesAndSyncCurrentPage,
            renderVisiblePages,
            getVisibleRange: vi.fn(() => ({
                start: 1,
                end: 1,
            })),
            syncCurrentPageFromViewport,
        });

        return {
            recovery,
            reRenderVisiblePagesAndSyncCurrentPage,
            renderVisiblePages,
            syncCurrentPageFromViewport,
        };
    }

    async function letRecoveryRun() {
        await vi.advanceTimersByTimeAsync(50);
        await Promise.resolve();
    }

    it('rerenders when only a text layer exists without a page canvas', async () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="page_container">
                <div class="page_canvas"></div>
                <div class="text-layer textLayer"><span>ocr title</span></div>
            </div>
        `;
        const harness = createHarness(container);

        harness.recovery.scheduleRecoverInitialRender();
        await letRecoveryRun();

        expect(harness.reRenderVisiblePagesAndSyncCurrentPage).toHaveBeenCalledTimes(1);
    });

    it('does not rerender when the page canvas already exists', async () => {
        const container = document.createElement('div');
        container.innerHTML = `
            <div class="page_container">
                <div class="page_canvas"><canvas></canvas></div>
                <div class="text-layer textLayer"><span>searchable text</span></div>
            </div>
        `;
        const harness = createHarness(container);

        harness.recovery.scheduleRecoverInitialRender();
        await letRecoveryRun();

        expect(harness.reRenderVisiblePagesAndSyncCurrentPage).not.toHaveBeenCalled();
        expect(harness.renderVisiblePages).not.toHaveBeenCalled();
        expect(harness.syncCurrentPageFromViewport).not.toHaveBeenCalled();
    });
});
