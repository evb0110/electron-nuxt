// @vitest-environment happy-dom

import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { usePdfViewerActivationRestore } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { cast } from '@tests/helpers/cast';

function createHarness() {
    const documentA = cast<PDFDocumentProxy>({fingerprint: 'a'});
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(documentA);
    const isActive = ref(true);
    const visibleRange = ref({
        start: 1,
        end: 2,
    });
    const renderVisiblePages = vi.fn(async () => {});
    const scrollToPage = vi.fn();
    const applySearchHighlights = vi.fn();
    const viewerContainer = document.createElement('div');
    Object.defineProperties(viewerContainer, {
        clientHeight: {value: 700},
        clientWidth: {value: 900},
    });
    const restore = usePdfViewerActivationRestore({
        viewerContainer: ref(viewerContainer),
        pdfDocument,
        isActive: computed(() => isActive.value),
        isLoading: ref(false),
        numPages: ref(8),
        currentPage: ref(6),
        visibleRange,
        viewMode: computed(() => 'facing'),
        getVisiblePageRange: () => visibleRange.value,
        updateVisibleRange: vi.fn(),
        scrollToPage,
        renderVisiblePages,
        applySearchHighlights,
    });
    return {
        applySearchHighlights,
        isActive,
        pdfDocument,
        renderVisiblePages,
        restore,
        scrollToPage,
    };
}

describe('usePdfViewerActivationRestore', () => {
    it('resumes through one semantic scroll and one normal render demand', async () => {
        const harness = createHarness();
        const runId = harness.restore.nextActivationRestoreRunId();

        await harness.restore.renderActiveDocumentAfterActivation(runId);

        expect(harness.scrollToPage).toHaveBeenCalledOnce();
        expect(harness.scrollToPage).toHaveBeenCalledWith(6);
        expect(harness.renderVisiblePages).toHaveBeenCalledOnce();
        expect(harness.renderVisiblePages).toHaveBeenCalledWith({
            start: 5,
            end: 6,
        }, {preserveRenderedPages: true});
        expect(harness.applySearchHighlights).toHaveBeenCalledOnce();
    });

    it('fences a late completion after a newer activation run', async () => {
        const harness = createHarness();
        let finish!: () => void;
        harness.renderVisiblePages.mockImplementationOnce(() => new Promise<void>((resolve) => {
            finish = resolve;
        }));
        const oldRun = harness.restore.nextActivationRestoreRunId();
        const pending = harness.restore.renderActiveDocumentAfterActivation(oldRun);
        await vi.waitFor(() => expect(harness.renderVisiblePages).toHaveBeenCalledOnce());
        harness.restore.nextActivationRestoreRunId();
        finish();
        await pending;

        expect(harness.applySearchHighlights).not.toHaveBeenCalled();
    });

    it('fences a late completion after the document changes', async () => {
        const harness = createHarness();
        harness.renderVisiblePages.mockImplementationOnce(async () => {
            harness.pdfDocument.value = cast<PDFDocumentProxy>({fingerprint: 'b'});
        });
        const runId = harness.restore.nextActivationRestoreRunId();
        await harness.restore.renderActiveDocumentAfterActivation(runId);
        expect(harness.applySearchHighlights).not.toHaveBeenCalled();
    });
});
