import { BrowserLogger } from '@app/utils/browser-logger';

interface IViewportPagePin {
    page: number;
    untilMs: number;
    reason: string;
}

export function useViewportPagePin(options: { summarizeViewerStateForLog: () => unknown }) {
    const viewportPagePin = ref<IViewportPagePin | null>(null);
    let viewportPagePinTimer: ReturnType<typeof setTimeout> | null = null;

    function clearPinnedViewportPage(reason = 'cleared') {
        if (viewportPagePinTimer !== null) {
            clearTimeout(viewportPagePinTimer);
            viewportPagePinTimer = null;
        }

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

        if (viewportPagePinTimer !== null) {
            clearTimeout(viewportPagePinTimer);
        }

        viewportPagePin.value = {
            page: normalizedPage,
            untilMs: Date.now() + durationMs,
            reason,
        };
        viewportPagePinTimer = setTimeout(() => {
            clearPinnedViewportPage('expired-timer');
        }, durationMs);

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
