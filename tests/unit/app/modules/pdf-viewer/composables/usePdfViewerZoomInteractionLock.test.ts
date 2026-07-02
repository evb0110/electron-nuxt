import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePdfViewerZoomInteractionLock } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomInteractionLock';
import { wheelZoomExpectedScrollWindowMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomExpectedScrollWindowMs';
import { wheelZoomSessionLockExtensionMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionLockExtensionMs';

vi.mock('@app/utils/browserLogger', () => {
    return { BrowserLogger: {
        diagnostic: vi.fn(),
        diagnosticThrottled: vi.fn(),
    } };
});

function createZoomLockHarness() {
    const zoomVirtualizationFreeze = ref(null);
    const lock = usePdfViewerZoomInteractionLock({
        currentPage: ref(2),
        visibleRange: ref({
            start: 2,
            end: 4,
        }),
        virtualizedContinuousMode: ref(true),
        virtualWindowStart: ref(1),
        virtualWindowEnd: ref(6),
        zoomVirtualizationFreeze,
        summarizeViewerStateForLog: () => ({
            scrollTop: 0,
            scrollLeft: 0,
            clientWidth: 800,
            clientHeight: 600,
            scrollWidth: 1200,
            scrollHeight: 1800,
        }),
        getActiveSessionId: () => null,
        isWheelZoomGestureLocked: () => false,
    });
    return {
        lock,
        zoomVirtualizationFreeze,
    };
}

describe('usePdfViewerZoomInteractionLock', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('releases the current zoom rerender lock when its completion event arrives', () => {
        const {
            lock,
            zoomVirtualizationFreeze,
        } = createZoomLockHarness();

        const operationId = lock.setZoomRerenderBusy(true, { reason: 'queue-start' });
        expect(lock.isZoomInteractionLocked()).toBe(true);
        expect(zoomVirtualizationFreeze.value).not.toBeNull();

        lock.setZoomRerenderBusy(false, {
            operationId,
            reason: 'queue-render-complete',
        });

        expect(lock.isZoomInteractionLocked()).toBe(false);
        expect(lock.getExpectedZoomScrollUntilMs()).toBe(0);
        expect(zoomVirtualizationFreeze.value).toBeNull();
    });

    it('ignores stale zoom rerender completion events from older operations', () => {
        const {
            lock,
            zoomVirtualizationFreeze,
        } = createZoomLockHarness();

        const olderOperationId = lock.setZoomRerenderBusy(true, { reason: 'older-start' });
        const newerOperationId = lock.setZoomRerenderBusy(true, { reason: 'newer-start' });

        lock.setZoomRerenderBusy(false, {
            operationId: olderOperationId,
            reason: 'older-render-complete',
        });

        expect(lock.isZoomInteractionLocked()).toBe(true);
        expect(lock.getActiveZoomRerenderOperationId()).toBe(newerOperationId);
        expect(zoomVirtualizationFreeze.value).not.toBeNull();

        lock.setZoomRerenderBusy(false, {
            operationId: newerOperationId,
            reason: 'newer-render-complete',
        });

        expect(lock.isZoomInteractionLocked()).toBe(false);
        expect(zoomVirtualizationFreeze.value).toBeNull();
    });

    it('releases the expected scroll lock when the matching scroll completion arrives', () => {
        const {
            lock,
            zoomVirtualizationFreeze,
        } = createZoomLockHarness();

        const operationId = lock.markExpectedZoomScroll(
            wheelZoomExpectedScrollWindowMs,
            { reason: 'wheel-zoom' },
        );
        expect(lock.isZoomInteractionLocked()).toBe(true);
        expect(zoomVirtualizationFreeze.value).not.toBeNull();

        lock.completeExpectedZoomScroll({
            operationId,
            reason: 'viewer-scroll-applied',
        });

        expect(lock.isZoomInteractionLocked()).toBe(false);
        expect(lock.getExpectedZoomScrollUntilMs()).toBe(0);
        expect(zoomVirtualizationFreeze.value).toBeNull();
    });

    it('keeps the timer as a failsafe when completion never arrives', () => {
        const {
            lock,
            zoomVirtualizationFreeze,
        } = createZoomLockHarness();

        lock.setZoomRerenderBusy(true, { reason: 'queue-start' });

        vi.advanceTimersByTime(
            wheelZoomExpectedScrollWindowMs + wheelZoomSessionLockExtensionMs - 1,
        );
        expect(lock.isZoomInteractionLocked()).toBe(true);

        vi.advanceTimersByTime(1);

        expect(lock.isZoomInteractionLocked()).toBe(false);
        expect(zoomVirtualizationFreeze.value).toBeNull();
    });
});
