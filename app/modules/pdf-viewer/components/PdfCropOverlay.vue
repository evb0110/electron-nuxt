<template>
    <div
        v-if="active"
        ref="overlayRef"
        class="crop-overlay is-active"
        role="dialog"
        aria-modal="true"
        :aria-label="hintLabel"
        tabindex="0"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="cancelSelection"
        @contextmenu="handleContextMenu"
        @wheel="handleWheel"
        @keydown="handleKeyboardKey"
    >
        <div
            v-if="selectionRect"
            class="crop-selection"
            :style="selectionStyle"
        />
        <div v-if="!selectionRect" class="crop-hint">
            {{ hintLabel }}
        </div>
    </div>
</template>

<script setup lang="ts">
import type {
    IRegionSelectionOverlayBaseProps,
    IRegionSelectionOverlayEmits,
} from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfRegionSelectionOverlay';
import { pdfCropSelectionKeyboardKey } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfCropSelection';
import { useEmittedPdfRegionSelectionOverlay } from '@app/modules/pdf-viewer/runtime/composables/pdf/useEmittedPdfRegionSelectionOverlay';
import { regionRectStyle } from '@app/modules/pdf-viewer/engine/region-selection/regionRectStyle';

const {
    active,
    selectionRect,
    hintLabel,
} = defineProps<IRegionSelectionOverlayBaseProps>();
const emit = defineEmits<IRegionSelectionOverlayEmits>();
const overlayRef = ref<HTMLElement | null>(null);
const keyboardController = inject(pdfCropSelectionKeyboardKey, null);

const {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handleContextMenu,
    handleWheel,
} = useEmittedPdfRegionSelectionOverlay({
    get active() {
        return active;
    },
    get selectionRect() {
        return selectionRect;
    },
    get hintLabel() {
        return hintLabel;
    },
}, emit);

const selectionStyle = computed(() => regionRectStyle(selectionRect));

function cancelSelection() {
    emit('cancel');
}

let previouslyFocusedElement: HTMLElement | null = null;

function focusOverlay() {
    if (typeof document !== 'undefined') {
        const activeElement = document.activeElement;
        if (activeElement instanceof HTMLElement && activeElement !== overlayRef.value) {
            previouslyFocusedElement = activeElement;
        }
    }
    void nextTick(() => overlayRef.value?.focus({preventScroll: true}));
}

function restoreFocus() {
    const element = previouslyFocusedElement;
    previouslyFocusedElement = null;
    if (element?.isConnected) {
        void nextTick(() => element.focus({preventScroll: true}));
    }
}

function handleKeyboardKey(event: KeyboardEvent) {
    if (event.key === 'Tab') {
        event.preventDefault();
        overlayRef.value?.focus({preventScroll: true});
        return;
    }
    if (keyboardController?.handleKeyboardKey(event)) {
        return;
    }
    if (event.key === 'Escape') {
        event.preventDefault();
        cancelSelection();
    }
}

watch(() => active, (isActive) => {
    if (isActive) {
        focusOverlay();
    } else {
        restoreFocus();
    }
}, {
    flush: 'post',
    immediate: true,
});

onBeforeUnmount(restoreFocus);
</script>

<style scoped>
.crop-overlay {
    position: absolute;
    inset: 0;
    z-index: var(--app-z-pdf-selection-overlay);
    overflow: hidden;
    pointer-events: none;
    user-select: none;
}

.crop-overlay.is-active {
    pointer-events: auto;
    cursor: crosshair;
}

.crop-overlay:focus-visible {
    outline: 2px solid var(--app-toolbar-focus-ring);
    outline-offset: -2px;
}

.crop-selection {
    position: absolute;
    box-sizing: border-box;
    border-radius: var(--app-crop-selection-radius);
    border: var(--app-crop-selection-border-width) solid var(--app-crop-selection-border);
    box-shadow: 0 0 0 9999px var(--app-crop-cutout-fill);
}

.crop-hint {
    position: absolute;
    top: var(--app-crop-hint-offset-top);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--app-crop-hint-padding);
    border-radius: var(--app-crop-hint-radius);
    border: 1px solid var(--app-crop-hint-border);
    background: var(--app-crop-hint-bg);
    color: var(--app-crop-hint-fg);
    font-size: var(--app-crop-hint-font-size);
    line-height: 1;
    pointer-events: none;
    animation: crop-hint-enter 180ms ease-out;
}

@keyframes crop-hint-enter {
    from {
        opacity: 0;
        transform: translateX(-50%) translateY(-4px);
    }

    to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
    }
}
</style>
