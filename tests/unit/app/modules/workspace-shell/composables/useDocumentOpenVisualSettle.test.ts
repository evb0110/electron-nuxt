import {
    nextTick,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { useDocumentOpenVisualSettle } from '@app/modules/workspace-shell/composables/useDocumentOpenVisualSettle';

interface IHarnessOverrides {
    djvuError?: unknown;
    hasPdf?: boolean;
    isLoading?: boolean;
    pageLabelsResolved?: boolean;
    pdfDocument?: unknown;
    pdfError?: unknown;
    pdfSrc?: unknown;
    showNativeDjvuViewer?: boolean;
    showNativePdfViewer?: boolean;
    totalPages?: number;
}

function createHarness(overrides: IHarnessOverrides = {}) {
    const hasPdf = ref(overrides.hasPdf ?? false);
    const pdfSrc = ref(overrides.pdfSrc ?? null);
    const pdfDocument = ref(overrides.pdfDocument ?? null);
    const totalPages = ref(overrides.totalPages ?? 0);
    const pageLabelsResolved = ref(overrides.pageLabelsResolved ?? false);
    const isLoading = ref(overrides.isLoading ?? false);
    const pdfError = ref(overrides.pdfError ?? null);
    const djvuError = ref(overrides.djvuError ?? null);
    const showNativeDjvuViewer = ref(overrides.showNativeDjvuViewer ?? false);
    const showNativePdfViewer = ref(overrides.showNativePdfViewer ?? false);
    const markAnnotationCommentsLoading = vi.fn();

    const settle = useDocumentOpenVisualSettle({
        tabId: 'tab-1',
        hasPdf,
        pdfSrc,
        pdfDocument,
        totalPages,
        pageLabelsResolved,
        isLoading,
        pdfError,
        djvuError,
        showNativeDjvuViewer,
        showNativePdfViewer,
        markAnnotationCommentsLoading,
    });

    return {
        djvuError,
        hasPdf,
        isLoading,
        markAnnotationCommentsLoading,
        pageLabelsResolved,
        pdfDocument,
        pdfError,
        pdfSrc,
        settle,
        showNativeDjvuViewer,
        showNativePdfViewer,
        totalPages,
    };
}

async function flushSettleWatchers() {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
}

function observeSettlement(promise: Promise<void>) {
    const settled = vi.fn();
    void promise.then(settled);
    return settled;
}

async function expectStillPending(settled: ReturnType<typeof vi.fn>) {
    await flushSettleWatchers();
    expect(settled).not.toHaveBeenCalled();
}

describe('useDocumentOpenVisualSettle', () => {
    it('keeps standard PDF behavior gated on initial visual readiness', async () => {
        const harness = createHarness({
            hasPdf: true,
            pdfSrc: { path: 'fixture.pdf' },
            pdfDocument: {},
            totalPages: 1,
            pageLabelsResolved: true,
            isLoading: false,
        });
        const settled = observeSettlement(harness.settle.waitForDocumentOpenSettled());

        await expectStillPending(settled);

        harness.settle.handlePdfInitialVisualReady();

        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    });

    it.each([
        [
            'native PDF',
            'showNativePdfViewer' as const,
        ],
        [
            'native DjVu',
            'showNativeDjvuViewer' as const,
        ],
    ])('does not settle %s on viewer selection alone', async (_label, viewerFlag) => {
        const harness = createHarness({
            [viewerFlag]: true,
            isLoading: false,
            totalPages: 1,
        });
        const settled = observeSettlement(harness.settle.waitForDocumentOpenSettled());

        await expectStillPending(settled);

        harness.settle.handlePdfInitialVisualReady();

        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    });

    it.each([
        [
            'native PDF',
            'showNativePdfViewer' as const,
        ],
        [
            'native DjVu',
            'showNativeDjvuViewer' as const,
        ],
    ])('keeps %s pending after initial visual readiness while loading continues', async (_label, viewerFlag) => {
        const harness = createHarness({
            [viewerFlag]: true,
            isLoading: true,
            totalPages: 1,
        });
        const settled = observeSettlement(harness.settle.waitForDocumentOpenSettled());

        harness.settle.handlePdfInitialVisualReady();
        await expectStillPending(settled);

        harness.isLoading.value = false;

        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    });

    it('still settles immediately for document-open errors', async () => {
        const harness = createHarness({
            pdfError: new Error('open failed'),
            showNativePdfViewer: true,
            isLoading: true,
        });
        const settled = observeSettlement(harness.settle.waitForDocumentOpenSettled());

        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
    });
});
