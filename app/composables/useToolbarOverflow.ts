import {
    useRafFn,
    tryOnMounted,
    useEventListener,
    useMutationObserver,
    useResizeObserver,
} from '@vueuse/core';

const MAX_COLLAPSE_TIER = 5;
const OVERFLOW_TOLERANCE_PX = 0.5;
const EXPAND_RETRY_WIDTH_DELTA_PX = 8;

function normalizeCollapseTier(tier: number) {
    return Math.max(0, Math.min(tier, MAX_COLLAPSE_TIER));
}

function shouldSkipExpandRetry(options: {
    tier: number;
    width: number;
    failedTier: number | null;
    failedWidth: number;
}) {
    return options.failedTier === options.tier
        && options.width <= (options.failedWidth + EXPAND_RETRY_WIDTH_DELTA_PX);
}

export const useToolbarOverflow = () => {
    const toolbarRef = ref<HTMLElement | null>(null);
    const collapseTier = ref(0);

    let isRecalculating = false;
    let needsRecalculation = false;
    let suppressMutationEvents = false;
    let failedExpandTier: number | null = null;
    let failedExpandWidth = 0;
    let rafPending = false;

    function isElementOverflowing(el: HTMLElement) {
        return (el.scrollWidth - el.clientWidth) > OVERFLOW_TOLERANCE_PX;
    }

    function hasOutOfBoundsChildren(el: HTMLElement) {
        const containerRect = el.getBoundingClientRect();
        if (containerRect.width <= 0) {
            return false;
        }

        return Array.from(el.children).some((child) => {
            if (!(child instanceof HTMLElement)) {
                return false;
            }

            const childRect = child.getBoundingClientRect();
            if (childRect.width <= 0) {
                return false;
            }

            return childRect.left < (containerRect.left - OVERFLOW_TOLERANCE_PX)
                || childRect.right > (containerRect.right + OVERFLOW_TOLERANCE_PX);
        });
    }

    function isOverflowing(toolbar: HTMLElement) {
        if (isElementOverflowing(toolbar) || hasOutOfBoundsChildren(toolbar)) {
            return true;
        }

        const centerSection = toolbar.querySelector<HTMLElement>('.toolbar-center');
        if (!centerSection) {
            return false;
        }

        return isElementOverflowing(centerSection) || hasOutOfBoundsChildren(centerSection);
    }

    async function waitForLayout() {
        await nextTick();
    }

    async function recalculateCollapseTier() {
        suppressMutationEvents = true;
        const toolbar = toolbarRef.value;
        if (!toolbar) {
            collapseTier.value = 0;
            suppressMutationEvents = false;
            return;
        }

        try {
            let tier = normalizeCollapseTier(collapseTier.value);
            collapseTier.value = tier;
            await waitForLayout();

            let currentToolbar = toolbarRef.value;
            if (!currentToolbar) {
                return;
            }

            let collapsedDuringPass = false;

            while (tier < MAX_COLLAPSE_TIER && isOverflowing(currentToolbar)) {
                tier += 1;
                collapseTier.value = tier;
                collapsedDuringPass = true;
                await waitForLayout();

                currentToolbar = toolbarRef.value;
                if (!currentToolbar) {
                    return;
                }
            }

            if (collapsedDuringPass) {
                failedExpandTier = null;
                return;
            }

            while (tier > 0) {
                currentToolbar = toolbarRef.value;
                if (!currentToolbar) {
                    return;
                }

                const currentTierWidth = currentToolbar.clientWidth;

                if (shouldSkipExpandRetry({
                    tier,
                    width: currentTierWidth,
                    failedTier: failedExpandTier,
                    failedWidth: failedExpandWidth,
                })) {
                    return;
                }

                const candidateTier = tier - 1;
                collapseTier.value = candidateTier;
                await waitForLayout();

                currentToolbar = toolbarRef.value;
                if (!currentToolbar || isOverflowing(currentToolbar)) {
                    collapseTier.value = tier;
                    failedExpandTier = tier;
                    failedExpandWidth = currentTierWidth;
                    return;
                }

                failedExpandTier = null;
                tier = candidateTier;
            }
        } finally {
            suppressMutationEvents = false;
        }
    }

    async function runRecalculation() {
        if (isRecalculating) {
            needsRecalculation = true;
            return;
        }

        isRecalculating = true;
        try {
            await recalculateCollapseTier();
        } finally {
            isRecalculating = false;
            if (needsRecalculation) {
                needsRecalculation = false;
                scheduleRecalculation();
            }
        }
    }

    const {
        pause: pauseRaf,
        resume: resumeRaf,
    } = useRafFn(() => {
        if (!rafPending) {
            pauseRaf();
            return;
        }

        rafPending = false;
        pauseRaf();
        void runRecalculation();
    }, { immediate: false });

    function scheduleRecalculation() {
        if (typeof window === 'undefined') {
            return;
        }

        if (isRecalculating) {
            needsRecalculation = true;
            return;
        }

        rafPending = true;
        resumeRaf();
    }

    watch(toolbarRef, () => {
        scheduleRecalculation();
    }, { flush: 'post' });

    useResizeObserver(toolbarRef, () => {
        scheduleRecalculation();
    });

    useMutationObserver(toolbarRef, () => {
        if (suppressMutationEvents) {
            needsRecalculation = true;
            return;
        }
        scheduleRecalculation();
    }, {
        subtree: true,
        childList: true,
        characterData: false,
    });

    useEventListener(typeof window !== 'undefined' ? window : undefined, 'resize', () => {
        scheduleRecalculation();
    });

    tryOnMounted(() => {
        scheduleRecalculation();
    });

    const hasOverflowItems = computed(() => collapseTier.value > 0);

    function isCollapsed(tier: number) {
        return collapseTier.value >= tier;
    }

    return {
        toolbarRef,
        collapseTier,
        hasOverflowItems,
        isCollapsed,
    };
};
