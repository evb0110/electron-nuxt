import {
    tryOnMounted,
    useEventListener,
    useMutationObserver,
    useRafFn,
    useResizeObserver,
} from '@vueuse/core';

const MAX_COLLAPSE_TIER = 5;
const OVERFLOW_TOLERANCE_PX = 0.5;
const NON_LAYOUT_ATTRIBUTE_NAMES = new Set([
    'aria-disabled',
    'aria-label',
    'aria-pressed',
    'class',
    'disabled',
    'title',
]);

export const useToolbarOverflow = () => {
    const toolbarRef = ref<HTMLElement | null>(null);
    const collapseTier = ref(0);

    let isRecalculating = false;
    let needsRecalculation = false;
    let suppressMutationEvents = false;
    let rafPending = false;
    let lastStableState: {
        tier: number
        clientWidth: number
        scrollWidth: number
    } | null = null;

    function isElementOverflowing(el: HTMLElement) {
        return (el.scrollWidth - el.clientWidth) > OVERFLOW_TOLERANCE_PX;
    }

    function hasOutOfBoundsDescendants(el: HTMLElement) {
        const containerRect = el.getBoundingClientRect();
        if (containerRect.width <= 0) {
            return false;
        }

        return Array.from(el.querySelectorAll<HTMLElement>('*')).some((child) => {
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
        if (isElementOverflowing(toolbar) || hasOutOfBoundsDescendants(toolbar)) {
            return true;
        }

        const centerSection = toolbar.querySelector<HTMLElement>('.toolbar-center');
        if (!centerSection) {
            return false;
        }

        return isElementOverflowing(centerSection) || hasOutOfBoundsDescendants(centerSection);
    }

    async function waitForLayout() {
        await nextTick();
    }

    async function recalculateCollapseTier() {
        suppressMutationEvents = true;
        const toolbar = toolbarRef.value;
        if (!toolbar) {
            collapseTier.value = 0;
            lastStableState = null;
            suppressMutationEvents = false;
            return;
        }

        try {
            if (
                lastStableState
                && collapseTier.value === lastStableState.tier
                && toolbar.clientWidth === lastStableState.clientWidth
                && toolbar.scrollWidth === lastStableState.scrollWidth
                && !isOverflowing(toolbar)
            ) {
                return;
            }

            for (let tier = 0; tier <= MAX_COLLAPSE_TIER; tier += 1) {
                collapseTier.value = tier;
                await waitForLayout();

                const currentToolbar = toolbarRef.value;
                if (!currentToolbar) {
                    return;
                }

                if (!isOverflowing(currentToolbar)) {
                    lastStableState = {
                        tier,
                        clientWidth: currentToolbar.clientWidth,
                        scrollWidth: currentToolbar.scrollWidth,
                    };
                    return;
                }
            }

            collapseTier.value = MAX_COLLAPSE_TIER;
            lastStableState = {
                tier: MAX_COLLAPSE_TIER,
                clientWidth: toolbar.clientWidth,
                scrollWidth: toolbar.scrollWidth,
            };
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

    function shouldRecalculateForMutations(mutations: MutationRecord[]) {
        return mutations.some((mutation) => {
            if (mutation.type !== 'attributes') {
                return true;
            }

            const attributeName = mutation.attributeName;
            return !attributeName || !NON_LAYOUT_ATTRIBUTE_NAMES.has(attributeName);
        });
    }

    useMutationObserver(toolbarRef, (mutations) => {
        if (suppressMutationEvents) {
            needsRecalculation = true;
            return;
        }
        if (!shouldRecalculateForMutations(mutations)) {
            return;
        }
        scheduleRecalculation();
    }, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
    });

    useEventListener(typeof window !== 'undefined' ? window : undefined, 'resize', () => {
        scheduleRecalculation();
    });

    tryOnMounted(() => {
        scheduleRecalculation();
        if (typeof document === 'undefined') {
            return;
        }

        void document.fonts?.ready.then(() => {
            scheduleRecalculation();
        });
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
