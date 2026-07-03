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
    computed,
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerActivationRestore } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerActivationRestore';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { cast } from '@tests/helpers/cast';

type TActivationRestoreOptions = Parameters<typeof usePdfViewerActivationRestore>[0];
type TActivationRestoreTransactionController = NonNullable<
    TActivationRestoreOptions['transactionController']
>;

function createViewerContainer(renderedCanvasPage: number | null = null) {
    const container = document.createElement('div');
    Object.defineProperty(container, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            bottom: 600,
            height: 600,
            left: 0,
            right: 800,
            top: 0,
            width: 800,
            x: 0,
            y: 0,
            toJSON: () => ({}),
        }),
    });
    const originalQuerySelector = container.querySelector.bind(container);
    vi.spyOn(container, 'querySelector').mockImplementation((selector: string) => {
        const match = selector.match(/data-page="(\d+)"/);
        const page = match ? Number.parseInt(match[1] ?? '', 10) : null;
        if (page !== null && page === renderedCanvasPage && selector.includes('.page_canvas canvas')) {
            return document.createElement('canvas');
        }
        return originalQuerySelector(selector);
    });
    return container;
}

function createHarness(options?: {
    currentPage?: number;
    visibleRange?: {
        start: number;
        end: number
    };
    renderedCanvasPage?: number | null;
    transactionController?: TActivationRestoreTransactionController;
}) {
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(
        cast<PDFDocumentProxy>({ fingerprint: 'doc-a' }),
    );
    const renderVisiblePages = vi.fn(async () => {});
    const applySearchHighlights = vi.fn();
    const visibleRange = ref(options?.visibleRange ?? {
        start: 1,
        end: 2,
    });
    const restore = usePdfViewerActivationRestore({
        viewerContainer: ref(createViewerContainer(options?.renderedCanvasPage ?? null)),
        pdfDocument,
        isActive: computed(() => true),
        isLoading: ref(false),
        numPages: ref(4),
        currentPage: ref(options?.currentPage ?? 2),
        visibleRange,
        viewMode: computed(() => 'facing'),
        getVisiblePageRange: vi.fn(() => visibleRange.value),
        updateVisibleRange: vi.fn(),
        scrollToPage: vi.fn(),
        renderVisiblePages,
        isPageRendered: vi.fn(() => false),
        applySearchHighlights,
        transactionController: options?.transactionController,
    });
    return {
        applySearchHighlights,
        pdfDocument,
        renderVisiblePages,
        restore,
        visibleRange,
    };
}

describe('usePdfViewerActivationRestore', () => {
    beforeEach(() => {
        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(performance.now());
            return 1;
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('force-renders the current facing row when only the sibling has content', async () => {
        const {
            applySearchHighlights,
            renderVisiblePages,
            restore,
        } = createHarness({ renderedCanvasPage: 1 });
        const runId = restore.nextActivationRestoreRunId();

        await restore.renderActiveDocumentAfterActivation(runId);

        expect(renderVisiblePages).toHaveBeenNthCalledWith(1, {
            start: 1,
            end: 2,
        }, { preserveRenderedPages: true });
        expect(renderVisiblePages).toHaveBeenNthCalledWith(2, {
            start: 1,
            end: 2,
        }, {
            preserveRenderedPages: true,
            forceRerender: true,
            bufferOverride: 0,
        });
        expect(applySearchHighlights).toHaveBeenCalledOnce();
    });

    it('does not continue activation restore after the document changes', async () => {
        const {
            applySearchHighlights,
            pdfDocument,
            renderVisiblePages,
            restore,
        } = createHarness();
        renderVisiblePages.mockImplementationOnce(async () => {
            pdfDocument.value = cast<PDFDocumentProxy>({ fingerprint: 'doc-b' });
        });
        const runId = restore.nextActivationRestoreRunId();

        await restore.renderActiveDocumentAfterActivation(runId);

        expect(renderVisiblePages).toHaveBeenCalledTimes(1);
        expect(applySearchHighlights).not.toHaveBeenCalled();
    });

    it('runs activation restore rendering through a recovery transaction', async () => {
        const visibleRange = ref({
            start: 1,
            end: 2,
        });
        const transactionController: TActivationRestoreTransactionController = {
            beginTransaction: vi.fn(() => ({ id: 91 })),
            advanceTransaction: vi.fn(() => true),
            cancelActiveTransaction: vi.fn(() => true),
            isTransactionCurrent: vi.fn(() => true),
            commitVisibleRange: vi.fn((range) => {
                visibleRange.value = range;
                return true;
            }),
        };
        const {
            renderVisiblePages,
            restore,
        } = createHarness({
            visibleRange: visibleRange.value,
            transactionController,
        });
        const runId = restore.nextActivationRestoreRunId();

        await restore.renderActiveDocumentAfterActivation(runId);

        expect(transactionController.beginTransaction).toHaveBeenCalledWith({
            kind: 'recovery',
            source: 'activation-restore',
            page: 2,
            range: {
                start: 1,
                end: 2,
            },
            anchor: 'top',
        });
        expect(transactionController.commitVisibleRange).toHaveBeenCalledWith({
            start: 1,
            end: 2,
        }, { transactionId: 91 });
        expect(transactionController.advanceTransaction).toHaveBeenCalledWith(91, 'render-requested');
        expect(transactionController.advanceTransaction).toHaveBeenCalledWith(91, 'settled');
        expect(transactionController.cancelActiveTransaction).not.toHaveBeenCalled();
        expect(renderVisiblePages).toHaveBeenCalledTimes(2);
    });
});
