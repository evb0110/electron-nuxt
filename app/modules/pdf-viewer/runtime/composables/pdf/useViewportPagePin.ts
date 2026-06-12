import { BrowserLogger } from '@app/utils/browserLogger';
import { useTimeoutFn } from '@vueuse/core';

interface IViewportPagePin {
    page: number;
    untilMs: number;
    reason: string;
}

export function useViewportPagePin(options: { summarizeViewerStateForLog: () => unknown }) {
    const viewportPagePin = ref<IViewportPagePin | null>(null);
    const viewportPagePinDurationMs = ref(900);

    function clearPinnedViewportPage(reason = 'cleared') {
        stopViewportPagePinTimer();

        const existingPin = viewportPagePin.value;
        if (!existingPin) {
            return;
        }

        viewportPagePin.value = null;
        BrowserLogger.warn('pdf-nav', `[viewer-page-pin] cleared page=${existingPin.page} reason=${reason}`, {
            page: existingPin.page,
            pinReason: existingPin.reason,
            clearReason: reason,
            viewer: options.summarizeViewerStateForLog(),
        });
    }

    const {
        start: startViewportPagePinTimer,
        stop: stopViewportPagePinTimer,
    } = useTimeoutFn(() => {
        clearPinnedViewportPage('expired-timer');
    }, viewportPagePinDurationMs, { immediate: false });

    function getPinnedViewportPage() {
        const existingPin = viewportPagePin.value;
        if (!existingPin) {
            return null;
        }

        if (Date.now() > existingPin.untilMs) {
            clearPinnedViewportPage('expired-read');
            return null;
        }

        return existingPin.page;
    }

    function pinCurrentPageDuringRecovery(
        page: number,
        pinOptions?: {
            durationMs?: number;
            reason?: string;
        },
    ) {
        const normalizedPage = Math.max(1, Math.floor(page));
        const durationMs = Math.max(120, pinOptions?.durationMs ?? 900);
        const reason = pinOptions?.reason ?? 'reload-recovery';

        stopViewportPagePinTimer();

        viewportPagePin.value = {
            page: normalizedPage,
            untilMs: Date.now() + durationMs,
            reason,
        };
        viewportPagePinDurationMs.value = durationMs;
        startViewportPagePinTimer();

        BrowserLogger.warn('pdf-nav', `[viewer-page-pin] pinned page=${normalizedPage} reason=${reason}`, {
            page: normalizedPage,
            durationMs,
            reason,
            viewer: options.summarizeViewerStateForLog(),
        });
    }

    onScopeDispose(() => {
        clearPinnedViewportPage('scope-dispose');
    });

    return {
        viewportPagePin,
        clearPinnedViewportPage,
        getPinnedViewportPage,
        pinCurrentPageDuringRecovery,
    };
}
