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
import { usePdfViewerTransactionController } from '@app/modules/pdf-viewer/runtime/transactions/usePdfViewerTransactionController';
import type { IPdfNavigationState } from '@app/modules/pdf-viewer/runtime/navigation/navigationMachine';

function createNavigationState(overrides: Partial<IPdfNavigationState> = {}) {
    return shallowRef<IPdfNavigationState>({
        anchor: 'top',
        currentPage: 1,
        source: 'paged',
        status: 'navigating',
        targetPage: 3,
        txn: 7,
        ...overrides,
    });
}

describe('usePdfViewerTransactionController', () => {
    it('exposes active navigation transaction diagnostics', () => {
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState(),
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(2),
        });

        expect(controller.activeTransaction.value).toMatchObject({
            id: 7,
            kind: 'navigation',
            source: 'paged-navigation',
            target: {
                page: 3,
                range: {
                    start: 3,
                    end: 3,
                },
            },
            userViewportInteractionEpoch: 2,
        });
    });

    it('commits visible range and current page only for the active transaction id', () => {
        const currentPage = ref(1);
        const visibleRange = ref({
            start: 1,
            end: 1,
        });
        const emitCurrentPage = vi.fn();
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState(),
            currentPage,
            visibleRange,
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(0),
            emitCurrentPage,
        });

        expect(controller.commitVisibleRange({
            start: 3,
            end: 3,
        }, { transactionId: 99 })).toBe(false);
        expect(visibleRange.value).toEqual({
            start: 1,
            end: 1,
        });

        expect(controller.commitVisibleRange({
            start: 3,
            end: 3,
        }, { transactionId: 7 })).toBe(true);
        expect(visibleRange.value).toEqual({
            start: 3,
            end: 3,
        });

        expect(controller.commitCurrentPage(4, {
            previousPage: 1,
            transactionId: 99,
        })).toBe(false);
        expect(currentPage.value).toBe(1);

        expect(controller.commitCurrentPage(3, {
            previousPage: 1,
            transactionId: 7,
        })).toBe(true);
        expect(currentPage.value).toBe(3);
        expect(emitCurrentPage).toHaveBeenCalledWith(3);
    });

    it('creates explicit producer render transactions and rejects stale requests after supersession', () => {
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState({
                status: 'idle',
                targetPage: null,
            }),
            currentPage: ref(2),
            visibleRange: ref({
                start: 2,
                end: 2,
            }),
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(4),
            getDocumentVersion: () => 12,
        });

        const zoomRequest = controller.beginRenderTransaction({
            kind: 'zoom',
            source: 'zoom-change',
            page: 2,
            range: {
                start: 2,
                end: 2,
            },
            renderVersion: 5,
            preserveRenderedPages: true,
            forceRerender: true,
            priority: 'interactive',
        });

        expect(zoomRequest).toMatchObject({
            transactionId: 1,
            renderRequestId: 1,
            documentVersion: 12,
            renderVersion: 5,
            source: 'zoom-change',
            priority: 'interactive',
        });
        expect(zoomRequest && controller.isRenderRequestCurrent(zoomRequest)).toBe(true);

        const resizeTransaction = controller.beginTransaction({
            kind: 'resize',
            source: 'resize-settle',
            page: 3,
        });

        expect(resizeTransaction?.id).toBe(2);
        expect(zoomRequest && controller.isRenderRequestCurrent(zoomRequest)).toBe(false);
        expect(controller.transactionState.value.cancelled[0]).toMatchObject({
            id: 1,
            cancellation: {
                reason: 'superseded',
                supersededByTransactionId: 2,
            },
        });
    });

    it('does not let recovery producer transactions supersede active navigation', () => {
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState(),
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(0),
        });

        const recoveryTransaction = controller.beginTransaction({
            kind: 'recovery',
            source: 'mounted-page-recovery',
            page: 4,
        });

        expect(recoveryTransaction).toBeNull();
        expect(controller.activeTransaction.value).toMatchObject({
            id: 7,
            kind: 'navigation',
            source: 'paged-navigation',
        });
    });

    it('records cancellation metadata for active producer transactions', () => {
        const controller = usePdfViewerTransactionController({
            navigationState: createNavigationState({
                status: 'idle',
                targetPage: null,
            }),
            currentPage: ref(1),
            visibleRange: ref({
                start: 1,
                end: 1,
            }),
            numPages: ref(10),
            viewMode: ref('single'),
            pdfDocument: shallowRef(null),
            userViewportInteractionEpoch: ref(0),
        });

        const transaction = controller.beginTransaction({
            kind: 'reload',
            source: 'reload',
            page: 1,
        });

        expect(transaction?.id).toBe(1);
        expect(controller.cancelActiveTransaction({
            reason: 'reload',
            cancelInFlightRenders: true,
            bumpRenderVersion: true,
            clearTimers: true,
            preserveVisualContent: true,
        })).toBe(true);
        expect(controller.transactionState.value.renderVersion).toBe(1);
        expect(controller.transactionState.value.cancelled[0]).toMatchObject({
            id: 1,
            state: 'cancelled',
            cancellation: {
                reason: 'reload',
                bumpRenderVersion: true,
            },
        });
    });
});
