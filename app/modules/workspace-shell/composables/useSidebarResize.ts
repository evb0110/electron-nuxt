import type { Ref } from 'vue';
import { useEventListener } from '@vueuse/core';
import { SIDEBAR } from '@app/constants/pdf-layout';
import { BrowserLogger } from '@app/utils/browser-logger';

export const useSidebarResize = (deps: {showSidebar: Ref<boolean>;}) => {
    const { showSidebar } = deps;

    const sidebarWidth = ref(SIDEBAR.DEFAULT_WIDTH);
    const lastOpenSidebarWidth = ref(SIDEBAR.DEFAULT_WIDTH);
    const isResizingSidebar = ref(false);

    let resizeStartX = 0;
    let resizeStartWidth = 0;
    const sidebarWrapperStyle = computed(() => ({
        width: `${sidebarWidth.value + SIDEBAR.RESIZER_WIDTH}px`,
        minWidth: `${sidebarWidth.value + SIDEBAR.RESIZER_WIDTH}px`,
    }));

    function cleanupSidebarResizeListeners() {
        // Pointer listeners are registered for the composable lifetime and gate
        // themselves on `isResizingSidebar`, so there is nothing transient to
        // tear down between resize sessions.
    }

    function handleSidebarResize(event: PointerEvent) {
        if (!isResizingSidebar.value) {
            return;
        }
        const deltaX = event.clientX - resizeStartX;
        const nextWidth = resizeStartWidth + deltaX;

        const clampedWidth = Math.min(
            Math.max(nextWidth, SIDEBAR.MIN_WIDTH),
            SIDEBAR.MAX_WIDTH,
        );

        if (Math.round(clampedWidth) !== Math.round(sidebarWidth.value)) {
            BrowserLogger.warn('pdf-nav', `[sidebar-resize] width ${Math.round(sidebarWidth.value)}->${Math.round(clampedWidth)}`, {
                previousWidth: Math.round(sidebarWidth.value),
                nextWidth: Math.round(clampedWidth),
                deltaX: Math.round(deltaX),
                pointerX: Math.round(event.clientX),
            });
        }
        sidebarWidth.value = clampedWidth;
        lastOpenSidebarWidth.value = clampedWidth;
    }

    function stopSidebarResize() {
        if (!isResizingSidebar.value) {
            return;
        }

        isResizingSidebar.value = false;
        cleanupSidebarResizeListeners();
    }

    function startSidebarResize(event: PointerEvent) {
        if (!showSidebar.value) {
            return;
        }

        event.preventDefault();

        isResizingSidebar.value = true;
        resizeStartX = event.clientX;
        resizeStartWidth = sidebarWidth.value;
        BrowserLogger.warn('pdf-nav', '[sidebar-resize] start', {
            pointerX: Math.round(event.clientX),
            startWidth: Math.round(resizeStartWidth),
        });

        cleanupSidebarResizeListeners();
    }

    useEventListener(
        typeof window !== 'undefined' ? window : undefined,
        'pointermove',
        handleSidebarResize,
    );
    useEventListener(
        typeof window !== 'undefined' ? window : undefined,
        'pointerup',
        stopSidebarResize,
    );
    useEventListener(
        typeof window !== 'undefined' ? window : undefined,
        'pointercancel',
        stopSidebarResize,
    );

    watch(showSidebar, (isOpen) => {
        BrowserLogger.warn('pdf-nav', `[sidebar-state] open=${isOpen}`, {
            isOpen,
            sidebarWidth: Math.round(sidebarWidth.value),
            lastOpenSidebarWidth: Math.round(lastOpenSidebarWidth.value),
            isResizingSidebar: isResizingSidebar.value,
        });
        if (isOpen) {
            const width = Math.min(
                Math.max(lastOpenSidebarWidth.value, SIDEBAR.DEFAULT_WIDTH),
                SIDEBAR.MAX_WIDTH,
            );
            sidebarWidth.value = width;
            lastOpenSidebarWidth.value = width;
            return;
        }

        stopSidebarResize();
    });

    watch(sidebarWidth, (next, previous) => {
        if (Math.round(next) === Math.round(previous)) {
            return;
        }
        BrowserLogger.warn('pdf-nav', `[sidebar-width-ref] ${Math.round(previous)}->${Math.round(next)}`, {
            previous: Math.round(previous),
            next: Math.round(next),
            open: showSidebar.value,
            isResizingSidebar: isResizingSidebar.value,
        });
    });

    return {
        sidebarWidth,
        sidebarWrapperStyle,
        isResizingSidebar,
        startSidebarResize,
        cleanupSidebarResizeListeners,
    };
};
