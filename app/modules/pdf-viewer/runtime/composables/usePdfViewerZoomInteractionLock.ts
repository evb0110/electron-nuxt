import { BrowserLogger } from '@app/utils/browserLogger';
import { wheelDetailLogThrottleMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelDetailLogThrottleMs';
import { wheelZoomExpectedScrollWindowMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomExpectedScrollWindowMs';
import { wheelZoomSessionLockExtensionMs } from '@app/modules/pdf-viewer/runtime/zoom/wheelZoomSessionLockExtensionMs';
import type {
    IZoomVirtualizationLogOptions,
    TZoomInteractionLockOperationId,
} from '@app/modules/pdf-viewer/runtime/zoom/pdfViewerZoomTypes';

interface IUsePdfViewerZoomInteractionLockOptions extends IZoomVirtualizationLogOptions {
    getActiveSessionId: () => number | null;
    isWheelZoomGestureLocked: (nowMs?: number) => boolean;
}

interface IZoomInteractionLockCompletionOptions {
    operationId?: TZoomInteractionLockOperationId | null | undefined;
    reason: string;
}

interface IZoomInteractionLockStartOptions {
    operationId?: TZoomInteractionLockOperationId | null | undefined;
    reason?: string | undefined;
}

export const usePdfViewerZoomInteractionLock = (options: IUsePdfViewerZoomInteractionLockOptions) => {
    const {
        currentPage,
        visibleRange,
        virtualizedContinuousMode,
        virtualWindowStart,
        virtualWindowEnd,
        zoomVirtualizationFreeze,
        summarizeViewerStateForLog,
        getActiveSessionId,
        isWheelZoomGestureLocked,
    } = options;

    const zoomSnapSuppressed = ref(false);

    let isZoomRerenderBusyFromCore = false;
    let zoomRerenderBusyLockUntilMs = 0;
    let expectedZoomScrollUntilMs = 0;
    let nextZoomInteractionLockOperationId = 0;
    let activeExpectedZoomScrollOperationId: TZoomInteractionLockOperationId | null = null;
    let activeZoomRerenderOperationId: TZoomInteractionLockOperationId | null = null;
    let zoomSnapSuppressedTimer: ReturnType<typeof setTimeout> | null = null;
    let zoomRerenderBusyFailsafeTimer: ReturnType<typeof setTimeout> | null = null;

    function captureZoomVirtualizationFreeze(sessionId: number | null, reason: string) {
        if (!virtualizedContinuousMode.value) {
            zoomVirtualizationFreeze.value = null;
            return;
        }

        zoomVirtualizationFreeze.value = {
            sessionId,
            capturedAtMs: Date.now(),
            windowStart: virtualWindowStart.value,
            windowEnd: virtualWindowEnd.value,
        };

        BrowserLogger.diagnosticThrottled(
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

        BrowserLogger.diagnosticThrottled(
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

    function clearZoomRerenderBusyFailsafeTimer() {
        if (zoomRerenderBusyFailsafeTimer !== null) {
            clearTimeout(zoomRerenderBusyFailsafeTimer);
            zoomRerenderBusyFailsafeTimer = null;
        }
    }

    function beginZoomInteractionLockOperation(
        operationId?: TZoomInteractionLockOperationId | null,
    ) {
        if (typeof operationId === 'number') {
            if (operationId < nextZoomInteractionLockOperationId) {
                return null;
            }
            nextZoomInteractionLockOperationId = operationId;
            return operationId;
        }

        nextZoomInteractionLockOperationId += 1;
        return nextZoomInteractionLockOperationId;
    }

    function completeExpectedZoomScroll(options: IZoomInteractionLockCompletionOptions) {
        const operationId = options.operationId ?? activeExpectedZoomScrollOperationId;
        if (
            operationId === null
            || operationId === undefined
            || activeExpectedZoomScrollOperationId !== operationId
        ) {
            return false;
        }

        clearZoomSnapSuppressedTimer();
        activeExpectedZoomScrollOperationId = null;
        expectedZoomScrollUntilMs = 0;
        zoomSnapSuppressed.value = false;
        maybeReleaseZoomVirtualizationFreeze(options.reason);
        return true;
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

    function scheduleZoomSnapSuppressedRelease(operationId: TZoomInteractionLockOperationId) {
        clearZoomSnapSuppressedTimer();
        const delayMs = expectedZoomScrollUntilMs - Date.now();
        if (delayMs <= 0) {
            completeExpectedZoomScroll({
                operationId,
                reason: 'expected-scroll-window-expired',
            });
            return;
        }
        zoomSnapSuppressedTimer = setTimeout(() => {
            zoomSnapSuppressedTimer = null;
            if (activeExpectedZoomScrollOperationId !== operationId) {
                return;
            }
            if (Date.now() <= expectedZoomScrollUntilMs) {
                scheduleZoomSnapSuppressedRelease(operationId);
                return;
            }
            completeExpectedZoomScroll({
                operationId,
                reason: 'expected-scroll-window-expired',
            });
        }, delayMs + 32);
    }

    function markExpectedZoomScroll(ms: number, options: IZoomInteractionLockStartOptions = {}) {
        const operationId = beginZoomInteractionLockOperation(options.operationId);
        if (operationId === null) {
            return null;
        }

        activeExpectedZoomScrollOperationId = operationId;
        expectedZoomScrollUntilMs = Math.max(
            expectedZoomScrollUntilMs,
            Date.now() + Math.max(0, ms),
        );
        zoomSnapSuppressed.value = true;
        captureZoomVirtualizationFreeze(
            getActiveSessionId(),
            options.reason ?? 'expected-scroll-window',
        );
        scheduleZoomSnapSuppressedRelease(operationId);
        return operationId;
    }

    function completeZoomRerenderBusy(options: IZoomInteractionLockCompletionOptions) {
        const operationId = options.operationId ?? activeZoomRerenderOperationId;
        if (
            operationId === null
            || operationId === undefined
            || activeZoomRerenderOperationId !== operationId
        ) {
            return false;
        }

        clearZoomRerenderBusyFailsafeTimer();
        activeZoomRerenderOperationId = null;
        isZoomRerenderBusyFromCore = false;
        zoomRerenderBusyLockUntilMs = 0;
        completeExpectedZoomScroll({
            operationId,
            reason: options.reason,
        });
        maybeReleaseZoomVirtualizationFreeze(options.reason);
        return true;
    }

    function scheduleZoomRerenderBusyFailsafe(operationId: TZoomInteractionLockOperationId) {
        clearZoomRerenderBusyFailsafeTimer();
        zoomRerenderBusyFailsafeTimer = setTimeout(() => {
            zoomRerenderBusyFailsafeTimer = null;
            completeZoomRerenderBusy({
                operationId,
                reason: 'core-rerender-failsafe',
            });
        }, wheelZoomExpectedScrollWindowMs + wheelZoomSessionLockExtensionMs);
    }

    function setZoomRerenderBusy(
        busy: boolean,
        options: IZoomInteractionLockStartOptions = {},
    ) {
        if (busy) {
            const operationId = beginZoomInteractionLockOperation(options.operationId);
            if (operationId === null) {
                return activeZoomRerenderOperationId;
            }

            activeZoomRerenderOperationId = operationId;
            isZoomRerenderBusyFromCore = true;
            zoomRerenderBusyLockUntilMs = Date.now()
                + wheelZoomExpectedScrollWindowMs
                + wheelZoomSessionLockExtensionMs;
            markExpectedZoomScroll(wheelZoomExpectedScrollWindowMs, {
                operationId,
                reason: options.reason ?? 'core-rerender-busy',
            });
            captureZoomVirtualizationFreeze(
                getActiveSessionId(),
                'core-rerender-busy',
            );
            scheduleZoomRerenderBusyFailsafe(operationId);
            BrowserLogger.diagnostic('pdf-zoom-debug', `[wheel-zoom-session] core-busy=${busy}`, {
                busy,
                operationId,
                lockUntilMs: zoomRerenderBusyLockUntilMs,
                activeSessionId: getActiveSessionId(),
            });
            return operationId;
        }

        completeZoomRerenderBusy({
            operationId: options.operationId,
            reason: options.reason ?? 'core-rerender-idle',
        });
        BrowserLogger.diagnostic('pdf-zoom-debug', `[wheel-zoom-session] core-busy=${busy}`, {
            busy,
            operationId: options.operationId ?? null,
            lockUntilMs: zoomRerenderBusyLockUntilMs,
            activeSessionId: getActiveSessionId(),
        });
        return activeZoomRerenderOperationId;
    }

    function isZoomInteractionLocked(nowMs = Date.now()) {
        const sessionLocked = isWheelZoomGestureLocked(nowMs);
        const coreLocked = isZoomRerenderBusyFromCore || nowMs <= zoomRerenderBusyLockUntilMs;
        const expectedScrollLocked = nowMs <= expectedZoomScrollUntilMs;
        return sessionLocked || coreLocked || expectedScrollLocked;
    }

    function cleanupZoomInteractionLock() {
        clearZoomSnapSuppressedTimer();
        clearZoomRerenderBusyFailsafeTimer();
        isZoomRerenderBusyFromCore = false;
        zoomRerenderBusyLockUntilMs = 0;
        expectedZoomScrollUntilMs = 0;
        activeExpectedZoomScrollOperationId = null;
        activeZoomRerenderOperationId = null;
        zoomSnapSuppressed.value = false;
        zoomVirtualizationFreeze.value = null;
    }

    return {
        zoomSnapSuppressed,
        captureZoomVirtualizationFreeze,
        maybeReleaseZoomVirtualizationFreeze,
        markExpectedZoomScroll,
        completeExpectedZoomScroll,
        setZoomRerenderBusy,
        isZoomInteractionLocked,
        cleanupZoomInteractionLock,
        getIsZoomRerenderBusyFromCore: () => isZoomRerenderBusyFromCore,
        getZoomRerenderBusyLockUntilMs: () => zoomRerenderBusyLockUntilMs,
        getExpectedZoomScrollUntilMs: () => expectedZoomScrollUntilMs,
        getActiveExpectedZoomScrollOperationId: () => activeExpectedZoomScrollOperationId,
        getActiveZoomRerenderOperationId: () => activeZoomRerenderOperationId,
    };
};
