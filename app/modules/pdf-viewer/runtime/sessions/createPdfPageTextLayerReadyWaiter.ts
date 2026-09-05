import type { TPageNumber } from '@contracts/pageNumbers';

import { PDF_PAGE_TEXT_LAYER_TIMEOUT_MS } from '@app/constants/timeouts';

interface IPageTextLayerReadyWaiter {
    signal: AbortSignal;
    resolve: (ready: boolean) => void;
    reject: (error: unknown) => void;
    onAbort: () => void;
    timeoutId: number;
}

export function createPdfPageTextLayerReadyWaiter(options: {isReady: (pageNumber: TPageNumber) => boolean;}) {
    const waitersByPage = new Map<TPageNumber, Set<IPageTextLayerReadyWaiter>>();

    function settle(
        pageNumber: TPageNumber,
        waiter: IPageTextLayerReadyWaiter,
        ready: boolean,
        error?: unknown,
    ) {
        const waiters = waitersByPage.get(pageNumber);
        if (!waiters?.delete(waiter)) {
            return;
        }
        if (waiters.size === 0) {
            waitersByPage.delete(pageNumber);
        }
        waiter.signal.removeEventListener('abort', waiter.onAbort);
        window.clearTimeout(waiter.timeoutId);
        if (error !== undefined) {
            waiter.reject(error);
        } else {
            waiter.resolve(ready);
        }
    }

    function resolveReady() {
        for (const [
            pageNumber,
            waiters,
        ] of waitersByPage) {
            if (!options.isReady(pageNumber)) {
                continue;
            }
            for (const waiter of [...waiters]) {
                settle(pageNumber, waiter, true);
            }
        }
    }

    function settleAll() {
        for (const [
            pageNumber,
            waiters,
        ] of waitersByPage) {
            for (const waiter of [...waiters]) {
                settle(pageNumber, waiter, false);
            }
        }
    }

    function waitForPageTextLayerReady(pageNumber: TPageNumber, signal: AbortSignal) {
        if (options.isReady(pageNumber)) {
            return Promise.resolve(true);
        }
        if (signal.aborted) {
            return Promise.reject(new DOMException('PDF text layer readiness wait was cancelled', 'AbortError'));
        }
        return new Promise<boolean>((resolve, reject) => {
            const onAbort = () => {
                settle(
                    pageNumber,
                    waiter,
                    false,
                    new DOMException('PDF text layer readiness wait was cancelled', 'AbortError'),
                );
            };
            const waiter: IPageTextLayerReadyWaiter = {
                signal,
                resolve,
                reject,
                onAbort,
                timeoutId: window.setTimeout(
                    () => settle(pageNumber, waiter, false),
                    PDF_PAGE_TEXT_LAYER_TIMEOUT_MS,
                ),
            };
            let waiters = waitersByPage.get(pageNumber);
            if (!waiters) {
                waiters = new Set();
                waitersByPage.set(pageNumber, waiters);
            }
            waiters.add(waiter);
            signal.addEventListener('abort', onAbort, {once: true});
            resolveReady();
        });
    }

    return {
        resolveReady,
        settleAll,
        waitForPageTextLayerReady,
    };
}
