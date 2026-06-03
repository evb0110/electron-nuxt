import {
    useEventListener,
    useLocalStorage,
} from '@vueuse/core';
import { clamp } from 'es-toolkit/math';

const ASSISTANT_PANEL = {
    DEFAULT_WIDTH: 384,
    MIN_WIDTH: 320,
    MAX_WIDTH: 560,
    RESIZER_WIDTH: 6,
} as const;

const ASSISTANT_PANEL_WIDTH_STORAGE_KEY = 'evb-viewer:assistant:panel-width';

export const useAssistantPanelResize = () => {
    const panelWidth = useLocalStorage(ASSISTANT_PANEL_WIDTH_STORAGE_KEY, ASSISTANT_PANEL.DEFAULT_WIDTH);
    const isResizingPanel = ref(false);

    let resizeStartX = 0;
    let resizeStartWidth = 0;

    function applyClampedWidth(width: number) {
        panelWidth.value = clamp(Math.round(width), ASSISTANT_PANEL.MIN_WIDTH, ASSISTANT_PANEL.MAX_WIDTH);
    }

    function handlePanelResize(event: PointerEvent) {
        if (!isResizingPanel.value) {
            return;
        }
        // The panel is docked to the right edge, so dragging its left-edge handle
        // toward the viewer (negative delta) must grow the panel.
        const deltaX = event.clientX - resizeStartX;
        applyClampedWidth(resizeStartWidth - deltaX);
    }

    function stopPanelResize() {
        if (!isResizingPanel.value) {
            return;
        }
        isResizingPanel.value = false;
    }

    function startPanelResize(event: PointerEvent) {
        event.preventDefault();
        isResizingPanel.value = true;
        resizeStartX = event.clientX;
        resizeStartWidth = panelWidth.value;
    }

    const target = typeof window !== 'undefined' ? window : undefined;
    useEventListener(target, 'pointermove', handlePanelResize);
    useEventListener(target, 'pointerup', stopPanelResize);
    useEventListener(target, 'pointercancel', stopPanelResize);

    onMounted(() => {
        // Normalize any previously persisted value that falls outside the bounds.
        applyClampedWidth(panelWidth.value);
    });

    return {
        panelWidth,
        isResizingPanel,
        startPanelResize,
    };
};
