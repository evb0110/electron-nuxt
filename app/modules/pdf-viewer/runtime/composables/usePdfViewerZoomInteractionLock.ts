import { BrowserLogger } from '@app/utils/browserLogger';
import { wheelDetailLogThrottleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelDetailLogThrottleMs';
import { wheelZoomExpectedScrollWindowMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomExpectedScrollWindowMs';
import { wheelZoomGestureGraceMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomGestureGraceMs';
import { wheelZoomSessionLockExtensionMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionLockExtensionMs';
import type { IZoomVirtualizationLogOptions } from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';

interface IUsePdfViewerZoomInteractionLockOptions extends IZoomVirtualizationLogOptions {
    getActiveSessionId: () => number | null;
    isWheelZoomGestureLocked: (nowMs?: number) => boolean;
}

export const usePdfViewerZoomInteractionLock = (options: IUsePdfViewerZoomInteractionLockOptions) => {
    const {
        currentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        topVirtualSpacerStyle,
        bottomVirtualSpacerStyle,
        zoomVirtualizationFreeze,
        summarizeViewerStateForLog,
        getActiveSessionId,
        isWheelZoomGestureLocked,
    } = options;

    const zoomSnapSuppressed = ref(false);

    let isZoomRerenderBusyFromCore = false;
    let zoomRerenderBusyLockUntilMs = 0;
    let expectedZoomScrollUntilMs = 0;
    let zoomSnapSuppressedTimer: ReturnType<typeof setTimeout> | null = null;

    function captureZoomVirtualizationFreeze(sessionId: number | null, reason: string) {
        if (!virtualizedContinuousMode.value) {
            zoomVirtualizationFreeze.value = null;
            return;
        }

        const topSpacerHeight = Number.parseFloat(topVirtualSpacerStyle.value?.height ?? '0');
        const bottomSpacerHeight = Number.parseFloat(bottomVirtualSpacerStyle.value?.height ?? '0');

        zoomVirtualizationFreeze.value = {
            sessionId,
            capturedAtMs: Date.now(),
            windowStart: virtualWindowStart.value,
            windowEnd: virtualWindowEnd.value,
            topSpacerHeight: Number.isFinite(topSpacerHeight) ? Math.max(0, topSpacerHeight) : 0,
            bottomSpacerHeight: Number.isFinite(bottomSpacerHeight) ? Math.max(0, bottomSpacerHeight) : 0,
        };

        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'virtualization-freeze-capture',
            wheelDetailLogThrottleMs,
            `[zoom-virtualization] capture reason=${reason}`,
            {
                reason,
                freeze: zoomVirtualizationFreeze.value,
                currentPage: currentPage.value,
                visibleRange: {
                    start: visibleRange.value.start,
                    end: visibleRange.value.end,
                },
                viewer: summarizeViewerStateForLog(),
            },
        );
    }

    function releaseZoomVirtualizationFreeze(reason: string) {
        if (!zoomVirtualizationFreeze.value) {
            return;
        }

        BrowserLogger.warnThrottled(
            'pdf-zoom-debug',
            'virtualization-freeze-release',
            wheelDetailLogThrottleMs,
            `[zoom-virtualization] release reason=${reason}`,
            {
                reason,
                freeze: zoomVirtualizationFreeze.value,
                viewer: summarizeViewerStateForLog(),
            },
        );
        zoomVirtualizationFreeze.value = null;
    }

    function clearZoomSnapSuppressedTimer() {
        if (zoomSnapSuppressedTimer !== null) {
            clearTimeout(zoomSnapSuppressedTimer);
            zoomSnapSuppressedTimer = null;
        }
    }

    function shouldHoldZoomVirtualizationFreeze(nowMs = Date.now()) {
        if (!virtualizedContinuousMode.value) {
            return false;
        }

        if (isZoomRerenderBusyFromCore || zoomSnapSuppressed.value || nowMs <= expectedZoomScrollUntilMs) {
            return true;
        }

        return isWheelZoomGestureLocked(nowMs);
    }

    function maybeReleaseZoomVirtualizationFreeze(reason: string) {
        if (shouldHoldZoomVirtualizationFreeze()) {
            return;
        }
        releaseZoomVirtualizationFreeze(reason);
    }

    function scheduleZoomSnapSuppressedRelease() {
        clearZoomSnapSuppressedTimer();
        const delayMs = expectedZoomScrollUntilMs - Date.now();
        if (delayMs <= 0) {
            zoomSnapSuppressed.value = false;
            maybeReleaseZoomVirtualizationFreeze('expected-scroll-window-expired');
            return;
        }
        zoomSnapSuppressedTimer = setTimeout(() => {
            zoomSnapSuppressedTimer = null;
            if (Date.now() <= expectedZoomScrollUntilMs) {
                scheduleZoomSnapSuppressedRelease();
                return;
            }
            zoomSnapSuppressed.value = false;
            maybeReleaseZoomVirtualizationFreeze('expected-scroll-window-expired');
        }, delayMs + 32);
    }

    function markExpectedZoomScroll(ms: number) {
        expectedZoomScrollUntilMs = Math.max(
            expectedZoomScrollUntilMs,
            Date.now() + Math.max(0, ms),
        );
        zoomSnapSuppressed.value = true;
        captureZoomVirtualizationFreeze(
            getActiveSessionId(),
            'expected-scroll-window',
        );
        scheduleZoomSnapSuppressedRelease();
    }

    function setZoomRerenderBusy(busy: boolean) {
        isZoomRerenderBusyFromCore = busy;
        zoomRerenderBusyLockUntilMs = Date.now()
            + (busy ? wheelZoomSessionLockExtensionMs : wheelZoomGestureGraceMs);
        if (busy) {
            markExpectedZoomScroll(wheelZoomExpectedScrollWindowMs);
            captureZoomVirtualizationFreeze(
                getActiveSessionId(),
                'core-rerender-busy',
            );
        } else {
            maybeReleaseZoomVirtualizationFreeze('core-rerender-idle');
        }
        BrowserLogger.warn('pdf-zoom-debug', `[wheel-zoom-session] core-busy=${busy}`, {
            busy,
            lockUntilMs: zoomRerenderBusyLockUntilMs,
            activeSessionId: getActiveSessionId(),
        });
    }

    function isZoomInteractionLocked(nowMs = Date.now()) {
        const sessionLocked = isWheelZoomGestureLocked(nowMs);
        const coreLocked = isZoomRerenderBusyFromCore || nowMs <= zoomRerenderBusyLockUntilMs;
        return sessionLocked || coreLocked;
    }

    function cleanupZoomInteractionLock() {
        clearZoomSnapSuppressedTimer();
        isZoomRerenderBusyFromCore = false;
        zoomRerenderBusyLockUntilMs = 0;
        expectedZoomScrollUntilMs = 0;
        zoomSnapSuppressed.value = false;
        zoomVirtualizationFreeze.value = null;
    }

    return {
        zoomSnapSuppressed,
        captureZoomVirtualizationFreeze,
        maybeReleaseZoomVirtualizationFreeze,
        markExpectedZoomScroll,
        setZoomRerenderBusy,
        isZoomInteractionLocked,
        cleanupZoomInteractionLock,
        getIsZoomRerenderBusyFromCore: () => isZoomRerenderBusyFromCore,
        getZoomRerenderBusyLockUntilMs: () => zoomRerenderBusyLockUntilMs,
        getExpectedZoomScrollUntilMs: () => expectedZoomScrollUntilMs,
    };
};
