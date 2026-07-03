import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createPdfViewerTransactionMachineState,
    reducePdfViewerTransactionMachine,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionReducer';
import type {
    IPdfViewerTransactionCancellation,
    IPdfViewerTransactionDocumentRef,
    IPdfViewerTransactionBeginEvent,
    IPdfViewerTransactionFitPlan,
    IPdfViewerTransactionScrollPlan,
    TPdfViewerTransactionKind,
    TPdfViewerTransactionSource,
} from '@app/modules/pdf-viewer/engine/pdf-viewer-transaction/pdfViewerTransactionTypes';

const documentRef: IPdfViewerTransactionDocumentRef = {
    document: null,
    documentLoadToken: 1,
    documentVersion: 10,
};

const fitPlan: IPdfViewerTransactionFitPlan = {
    mode: 'none',
    scalePage: null,
    hydrateRange: null,
    invalidateRangeAfterScaleChange: false,
    suppressLegacyPagedRowRender: false,
};

const scrollPlan: IPdfViewerTransactionScrollPlan = {
    preferExactDom: true,
    commitCurrentPageOnScroll: true,
    suppressSnapAfterScroll: true,
    holdProgrammaticNavigationMs: 0,
};

const reloadCancellation: IPdfViewerTransactionCancellation = {
    reason: 'reload',
    cancelInFlightRenders: true,
    bumpRenderVersion: true,
    clearTimers: true,
    preserveVisualContent: true,
};

function beginEvent(options: {
    kind: TPdfViewerTransactionKind;
    source: TPdfViewerTransactionSource;
    page?: number | undefined;
}): IPdfViewerTransactionBeginEvent {
    const page = options.page ?? 1;
    return {
        type: 'BEGIN',
        transaction: {
            kind: options.kind,
            source: options.source,
            documentRef,
            target: {
                page,
                range: {
                    start: page,
                    end: page,
                },
                anchor: 'top',
            },
            fitPlan,
            scrollPlan,
            createdAtMs: 100,
            userViewportInteractionEpoch: 0,
        },
    };
}

describe('pdf viewer transaction reducer', () => {
    it('supersedes an active authoritative transaction and records the cancelled id', () => {
        const first = reducePdfViewerTransactionMachine(
            createPdfViewerTransactionMachineState(),
            beginEvent({
                kind: 'navigation',
                source: 'paged-navigation',
                page: 2,
            }),
        );
        const second = reducePdfViewerTransactionMachine(
            first,
            beginEvent({
                kind: 'navigation',
                source: 'continuous-navigation',
                page: 3,
            }),
        );

        expect(first.active?.id).toBe(1);
        expect(second.active?.id).toBe(2);
        expect(second.cancelled).toHaveLength(1);
        expect(second.cancelled[0]).toMatchObject({
            id: 1,
            state: 'cancelled',
            cancellation: {
                reason: 'superseded',
                supersededByTransactionId: 2,
            },
        });
    });

    it('ignores stale stage changes from superseded transactions', () => {
        const first = reducePdfViewerTransactionMachine(
            createPdfViewerTransactionMachineState(),
            beginEvent({
                kind: 'navigation',
                source: 'paged-navigation',
                page: 2,
            }),
        );
        const second = reducePdfViewerTransactionMachine(
            first,
            beginEvent({
                kind: 'navigation',
                source: 'paged-navigation',
                page: 4,
            }),
        );
        const stale = reducePdfViewerTransactionMachine(second, {
            type: 'ADVANCE',
            transactionId: first.active?.id ?? 0,
            state: 'render-settled',
        });

        expect(stale).toBe(second);
        expect(stale.active?.target?.page).toBe(4);
    });

    it('cancels reload-affecting work and bumps render version when requested', () => {
        const active = reducePdfViewerTransactionMachine(
            createPdfViewerTransactionMachineState(),
            beginEvent({
                kind: 'navigation',
                source: 'paged-navigation',
            }),
        );
        const cancelled = reducePdfViewerTransactionMachine(active, {
            type: 'CANCEL',
            cancellation: reloadCancellation,
        });

        expect(cancelled.active).toBeNull();
        expect(cancelled.renderVersion).toBe(1);
        expect(cancelled.cancelled[0]).toMatchObject({
            id: 1,
            state: 'cancelled',
            cancellation: {
                reason: 'reload',
                bumpRenderVersion: true,
            },
        });
    });

    it('does not let warm or recovery work supersede authoritative navigation', () => {
        const active = reducePdfViewerTransactionMachine(
            createPdfViewerTransactionMachineState(),
            beginEvent({
                kind: 'navigation',
                source: 'paged-navigation',
                page: 2,
            }),
        );
        const warm = reducePdfViewerTransactionMachine(
            active,
            beginEvent({
                kind: 'warm',
                source: 'continuous-warm',
                page: 3,
            }),
        );
        const recovery = reducePdfViewerTransactionMachine(
            active,
            beginEvent({
                kind: 'recovery',
                source: 'mounted-page-recovery',
                page: 4,
            }),
        );

        expect(warm).toBe(active);
        expect(recovery).toBe(active);
        expect(active.active?.target?.page).toBe(2);
    });
});
