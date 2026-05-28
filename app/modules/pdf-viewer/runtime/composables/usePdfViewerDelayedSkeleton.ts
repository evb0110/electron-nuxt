import type { MaybeRefOrGetter } from 'vue';

interface IUsePdfViewerDelayedSkeletonOptions {
    delayMs: number;
    trackedPages: MaybeRefOrGetter<readonly number[]>;
    blockSkeletons: MaybeRefOrGetter<boolean>;
    shouldShowSkeletonNow: (pageNumber: number) => boolean;
}

export function usePdfViewerDelayedSkeleton(options: IUsePdfViewerDelayedSkeletonOptions) {
    const visiblePages = ref(new Set<number>());
    const pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();

    function updateVisiblePage(pageNumber: number, visible: boolean) {
        if (visiblePages.value.has(pageNumber) === visible) {
            return;
        }
        const nextPages = new Set(visiblePages.value);
        if (visible) {
            nextPages.add(pageNumber);
        } else {
            nextPages.delete(pageNumber);
        }
        visiblePages.value = nextPages;
    }

    function cancelPendingTimer(pageNumber: number) {
        const timer = pendingTimers.get(pageNumber);
        if (!timer) {
            return;
        }
        clearTimeout(timer);
        pendingTimers.delete(pageNumber);
    }

    function hidePage(pageNumber: number) {
        cancelPendingTimer(pageNumber);
        updateVisiblePage(pageNumber, false);
    }

    function hideAll() {
        for (const pageNumber of Array.from(pendingTimers.keys())) {
            cancelPendingTimer(pageNumber);
        }
        if (visiblePages.value.size > 0) {
            visiblePages.value = new Set();
        }
    }

    function shouldStillShow(pageNumber: number) {
        return !toValue(options.blockSkeletons)
            && options.shouldShowSkeletonNow(pageNumber);
    }

    function schedulePage(pageNumber: number) {
        if (pendingTimers.has(pageNumber)) {
            return;
        }

        const timer = setTimeout(() => {
            pendingTimers.delete(pageNumber);
            if (shouldStillShow(pageNumber)) {
                updateVisiblePage(pageNumber, true);
            }
        }, options.delayMs);
        pendingTimers.set(pageNumber, timer);
    }

    function shouldShowSkeleton(pageNumber: number) {
        if (!shouldStillShow(pageNumber)) {
            hidePage(pageNumber);
            return false;
        }

        if (options.delayMs <= 0) {
            return true;
        }

        if (visiblePages.value.has(pageNumber)) {
            return true;
        }

        schedulePage(pageNumber);
        return false;
    }

    function markPageRendered(pageNumber: number) {
        hidePage(pageNumber);
    }

    watch(
        () => toValue(options.blockSkeletons),
        (blocked) => {
            if (blocked) {
                hideAll();
            }
        },
        { immediate: true },
    );

    watch(
        () => toValue(options.trackedPages),
        (pages) => {
            const trackedPages = new Set(pages);
            for (const pageNumber of Array.from(pendingTimers.keys())) {
                if (!trackedPages.has(pageNumber)) {
                    cancelPendingTimer(pageNumber);
                }
            }
            for (const pageNumber of Array.from(visiblePages.value)) {
                if (!trackedPages.has(pageNumber)) {
                    updateVisiblePage(pageNumber, false);
                }
            }
        },
        { immediate: true },
    );

    onScopeDispose(() => {
        hideAll();
    });

    return {
        hidePage,
        markPageRendered,
        shouldShowSkeleton,
    };
}
