import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canSyncPdfNavigationFromViewport,
    createPdfNavigationMachineState,
    getPdfNavigationStatusForSource,
    getPdfNavigationTargetPageForSource,
    getPdfNavigationTxnForSource,
    isPdfNavigationTargetCurrent,
    isPdfNavigationTxnCurrent,
    reducePdfNavigationMachine,
} from '@app/modules/pdf-viewer/runtime/navigation/navigationMachine';

describe('pdf navigation machine', () => {
    it('starts idle', () => {
        expect(createPdfNavigationMachineState()).toEqual({
            anchor: null,
            currentPage: null,
            source: null,
            status: 'idle',
            targetPage: null,
            txn: 0,
        });
    });

    it('supersedes an in-flight navigation with one current transaction', () => {
        const first = reducePdfNavigationMachine(createPdfNavigationMachineState(), {
            type: 'NAVIGATE',
            source: 'paged',
            targetPage: 2,
            anchor: 'top',
        });
        const second = reducePdfNavigationMachine(first, {
            type: 'NAVIGATE',
            source: 'paged',
            targetPage: 3,
            anchor: 'center',
        });

        expect(second).toMatchObject({
            status: 'navigating',
            targetPage: 3,
            txn: 2,
        });
        expect(isPdfNavigationTxnCurrent(second, first.txn)).toBe(false);
        expect(isPdfNavigationTxnCurrent(second, second.txn)).toBe(true);
    });

    it('settles only the matching current target', () => {
        const navigating = reducePdfNavigationMachine(createPdfNavigationMachineState(), {
            type: 'NAVIGATE',
            source: 'wheel',
            targetPage: 4,
        });
        const stale = reducePdfNavigationMachine(navigating, {
            type: 'SCROLL_APPLIED',
            txn: navigating.txn - 1,
            page: 4,
        });
        const wrongPage = reducePdfNavigationMachine(navigating, {
            type: 'SCROLL_APPLIED',
            txn: navigating.txn,
            page: 5,
        });
        const settling = reducePdfNavigationMachine(navigating, {
            type: 'SCROLL_APPLIED',
            txn: navigating.txn,
            page: 4,
        });

        expect(stale).toBe(navigating);
        expect(wrongPage).toBe(navigating);
        expect(settling.status).toBe('settling');
    });

    it('completes only the matching current render', () => {
        const navigating = reducePdfNavigationMachine(createPdfNavigationMachineState(), {
            type: 'NAVIGATE',
            source: 'search',
            targetPage: 7,
        });
        const settling = reducePdfNavigationMachine(navigating, {
            type: 'SCROLL_APPLIED',
            txn: navigating.txn,
            page: 7,
        });
        const idle = reducePdfNavigationMachine(settling, {
            type: 'RENDER_SETTLED',
            txn: navigating.txn,
            page: 7,
        });

        expect(idle).toEqual({
            anchor: null,
            currentPage: 7,
            source: null,
            status: 'idle',
            targetPage: null,
            txn: navigating.txn,
        });
    });

    it('keeps the target page authoritative before render settles', () => {
        const navigating = reducePdfNavigationMachine(createPdfNavigationMachineState(0, 1), {
            type: 'NAVIGATE',
            source: 'paged',
            targetPage: 5,
        });
        const staleViewport = reducePdfNavigationMachine(navigating, {
            type: 'VIEWPORT_CURRENT_PAGE',
            page: 1,
        });

        expect(navigating.currentPage).toBe(5);
        expect(staleViewport.currentPage).toBe(5);
    });

    it('accepts viewport current-page sync after matching render settle', () => {
        const navigating = reducePdfNavigationMachine(createPdfNavigationMachineState(0, 1), {
            type: 'NAVIGATE',
            source: 'continuous',
            targetPage: 6,
        });
        const settling = reducePdfNavigationMachine(navigating, {
            type: 'SCROLL_APPLIED',
            txn: navigating.txn,
            page: 6,
        });
        const idle = reducePdfNavigationMachine(settling, {
            type: 'RENDER_SETTLED',
            txn: navigating.txn,
            page: 6,
        });
        const synced = reducePdfNavigationMachine(idle, {
            type: 'VIEWPORT_CURRENT_PAGE',
            page: 4,
        });

        expect(idle.status).toBe('idle');
        expect(synced.currentPage).toBe(4);
    });

    it('ignores stale current-page commits from older transactions', () => {
        const first = reducePdfNavigationMachine(createPdfNavigationMachineState(0, 1), {
            type: 'NAVIGATE',
            source: 'paged',
            targetPage: 2,
        });
        const second = reducePdfNavigationMachine(first, {
            type: 'NAVIGATE',
            source: 'paged',
            targetPage: 3,
        });
        const staleCommit = reducePdfNavigationMachine(second, {
            type: 'CURRENT_PAGE_COMMITTED',
            txn: first.txn,
            page: 2,
        });

        expect(staleCommit.currentPage).toBe(3);
        expect(staleCommit).toBe(second);
    });

    it('invalidates active work on cancel, document change, or user scroll', () => {
        const navigating = reducePdfNavigationMachine(createPdfNavigationMachineState(), {
            type: 'NAVIGATE',
            source: 'continuous',
            targetPage: 8,
        });

        for (const type of [
            'CANCEL',
            'DOCUMENT_CHANGED',
            'USER_SCROLL',
        ] as const) {
            const idle = reducePdfNavigationMachine(navigating, { type });

            expect(idle).toMatchObject({
                status: 'idle',
                targetPage: null,
                txn: navigating.txn + 1,
            });
        }
    });

    it('allows viewport-derived current page sync only while idle', () => {
        const idle = createPdfNavigationMachineState();
        const navigating = reducePdfNavigationMachine(idle, {
            type: 'NAVIGATE',
            source: 'paged',
            targetPage: 2,
        });
        const settling = reducePdfNavigationMachine(navigating, {
            type: 'SCROLL_APPLIED',
            txn: navigating.txn,
            page: 2,
        });

        expect(canSyncPdfNavigationFromViewport(idle)).toBe(true);
        expect(canSyncPdfNavigationFromViewport(navigating)).toBe(false);
        expect(canSyncPdfNavigationFromViewport(settling)).toBe(false);
    });

    it('reports source-scoped active target state', () => {
        const continuous = reducePdfNavigationMachine(createPdfNavigationMachineState(), {
            type: 'NAVIGATE',
            source: 'continuous',
            targetPage: 12,
        });
        const settling = reducePdfNavigationMachine(continuous, {
            type: 'SCROLL_APPLIED',
            txn: continuous.txn,
            page: 12,
        });

        expect(getPdfNavigationStatusForSource(settling, 'continuous')).toBe('settling');
        expect(getPdfNavigationStatusForSource(settling, 'search')).toBe('idle');
        expect(getPdfNavigationTargetPageForSource(settling, 'continuous')).toBe(12);
        expect(getPdfNavigationTargetPageForSource(settling, 'paged')).toBeNull();
        expect(getPdfNavigationTxnForSource(settling, 'continuous')).toBe(settling.txn);
        expect(getPdfNavigationTxnForSource(settling, 'paged')).toBeNull();
        expect(isPdfNavigationTargetCurrent(
            settling,
            'continuous',
            settling.txn,
            12,
        )).toBe(true);
        expect(isPdfNavigationTargetCurrent(
            settling,
            'continuous',
            settling.txn,
            11,
        )).toBe(false);
    });
});
