<template>
    <div
        v-if="placement"
        ref="frameRef"
        class="pdf-image-placement"
        :style="frameStyle"
        @mousedown.stop.prevent
        @mouseup.stop
        @click.stop
        @dblclick.stop
        @contextmenu.prevent.stop
    >
        <img
            class="pdf-image-placement__preview"
            :src="placement.previewUrl"
            :alt="placement.fileName"
            draggable="false"
        >
        <button
            type="button"
            class="pdf-image-placement__surface"
            :disabled="busy"
            :aria-label="t('annotations.imageLabel')"
            @mousedown.stop.prevent
            @pointerdown.stop.prevent="handleMovePointerDown"
        />
        <div class="pdf-image-placement__resizers">
            <button
                v-for="handle in handles"
                :key="handle"
                type="button"
                class="pdf-image-placement__resizer"
                :class="`pdf-image-placement__resizer--${handle}`"
                :disabled="busy"
                :aria-label="t('annotations.imageLabel')"
                @mousedown.stop.prevent
                @pointerdown.stop.prevent="handleResizePointerDown(handle, $event)"
            />
        </div>
        <div class="pdf-image-placement__controls">
            <button
                type="button"
                class="pdf-image-placement__action pdf-image-placement__action--secondary"
                :disabled="busy"
                @mousedown.stop.prevent
                @click.stop="emit('cancel')"
            >
                {{ t('annotations.cancelImagePlacement') }}
            </button>
            <button
                type="button"
                class="pdf-image-placement__action pdf-image-placement__action--primary"
                :disabled="busy"
                @mousedown.stop.prevent
                @click.stop="emit('finalize')"
            >
                {{ t('annotations.embedImageToPage') }}
            </button>
        </div>
    </div>
</template>

<script setup lang="ts">
import { clamp } from 'es-toolkit/math';
import type {
    IPdfImagePlacementDraft,
    IPdfImagePlacementRectUpdate,
} from '@app/types/pdf-image-placement';

type TResizeHandle = 'nw' | 'ne' | 'se' | 'sw';

const {
    placement,
    busy = false,
} = defineProps<{
    placement: IPdfImagePlacementDraft | null;
    busy?: boolean;
}>();

const emit = defineEmits<{
    updateRect: [payload: IPdfImagePlacementRectUpdate];
    finalize: [];
    cancel: [];
}>();

const { t } = useTypedI18n();
const frameRef = ref<HTMLElement | null>(null);
const handles: TResizeHandle[] = [
    'nw',
    'ne',
    'se',
    'sw',
];

const frameStyle = computed((): Record<string, string> => {
    if (!placement) {
        return {};
    }

    return {
        left: `${placement.x * 100}%`,
        top: `${placement.y * 100}%`,
        width: `${placement.width * 100}%`,
        height: `${placement.height * 100}%`,
    };
});

interface IContainerRect {
    width: number;
    height: number;
}

interface IRectPx {
    left: number;
    top: number;
    width: number;
    height: number;
}

interface IActiveInteraction {
    mode: 'move' | 'resize';
    handle?: TResizeHandle;
    pointerId: number;
    originRectPx: IRectPx;
    startClientX: number;
    startClientY: number;
    containerRect: IContainerRect;
    aspectRatio: number;
}

let activeInteraction: IActiveInteraction | null = null;

function getContainerRect(): IContainerRect | null {
    const pageContainer = frameRef.value?.parentElement;
    if (!pageContainer) {
        return null;
    }
    const rect = pageContainer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return {
        width: rect.width,
        height: rect.height,
    };
}

function getOriginRectPx(containerRect: IContainerRect, placement: IPdfImagePlacementDraft): IRectPx {
    return {
        left: placement.x * containerRect.width,
        top: placement.y * containerRect.height,
        width: placement.width * containerRect.width,
        height: placement.height * containerRect.height,
    };
}

function toNormalizedRect(containerRect: IContainerRect, rectPx: IRectPx): IPdfImagePlacementRectUpdate {
    return {
        x: clamp(rectPx.left / containerRect.width, 0, 1),
        y: clamp(rectPx.top / containerRect.height, 0, 1),
        width: clamp(rectPx.width / containerRect.width, 0, 1),
        height: clamp(rectPx.height / containerRect.height, 0, 1),
    };
}

function startInteraction(
    mode: IActiveInteraction['mode'],
    event: PointerEvent,
    handle?: TResizeHandle,
) {
    if (!placement || busy) {
        return;
    }

    const containerRect = getContainerRect();
    if (!containerRect) {
        return;
    }

    activeInteraction = {
        mode,
        handle,
        pointerId: event.pointerId,
        originRectPx: getOriginRectPx(containerRect, placement),
        startClientX: event.clientX,
        startClientY: event.clientY,
        containerRect,
        aspectRatio: placement.intrinsicWidth / Math.max(1, placement.intrinsicHeight),
    };

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);
}

function stopInteraction() {
    activeInteraction = null;
    window.removeEventListener('pointermove', handleWindowPointerMove);
    window.removeEventListener('pointerup', handleWindowPointerUp);
    window.removeEventListener('pointercancel', handleWindowPointerUp);
}

function handleMovePointerDown(event: PointerEvent) {
    startInteraction('move', event);
}

function handleResizePointerDown(handle: TResizeHandle, event: PointerEvent) {
    startInteraction('resize', event, handle);
}

function applyMoveInteraction(interaction: IActiveInteraction, event: PointerEvent) {
    const minLeft = 0;
    const minTop = 0;
    const maxLeft = Math.max(0, interaction.containerRect.width - interaction.originRectPx.width);
    const maxTop = Math.max(0, interaction.containerRect.height - interaction.originRectPx.height);
    const left = clamp(
        interaction.originRectPx.left + (event.clientX - interaction.startClientX),
        minLeft,
        maxLeft,
    );
    const top = clamp(
        interaction.originRectPx.top + (event.clientY - interaction.startClientY),
        minTop,
        maxTop,
    );

    emit('updateRect', toNormalizedRect(interaction.containerRect, {
        left,
        top,
        width: interaction.originRectPx.width,
        height: interaction.originRectPx.height,
    }));
}

function applyResizeInteraction(interaction: IActiveInteraction, event: PointerEvent) {
    const handle = interaction.handle;
    if (!handle) {
        return;
    }

    const minWidth = 32;
    const maxWidthFromHeight = interaction.containerRect.height * interaction.aspectRatio;
    const origin = interaction.originRectPx;
    let left = origin.left;
    let top = origin.top;
    let width = origin.width;
    let height = origin.height;

    switch (handle) {
        case 'se': {
            const anchorLeft = origin.left;
            const anchorTop = origin.top;
            width = clamp(event.clientX - interaction.startClientX + origin.width, minWidth, interaction.containerRect.width - anchorLeft);
            height = width / interaction.aspectRatio;
            if (height > (interaction.containerRect.height - anchorTop)) {
                height = interaction.containerRect.height - anchorTop;
                width = height * interaction.aspectRatio;
            }
            width = Math.min(width, maxWidthFromHeight);
            height = width / interaction.aspectRatio;
            left = anchorLeft;
            top = anchorTop;
            break;
        }
        case 'sw': {
            const anchorRight = origin.left + origin.width;
            const anchorTop = origin.top;
            width = clamp(anchorRight - (origin.left + (event.clientX - interaction.startClientX)), minWidth, anchorRight);
            height = width / interaction.aspectRatio;
            if (height > (interaction.containerRect.height - anchorTop)) {
                height = interaction.containerRect.height - anchorTop;
                width = height * interaction.aspectRatio;
            }
            width = Math.min(width, maxWidthFromHeight);
            height = width / interaction.aspectRatio;
            left = anchorRight - width;
            top = anchorTop;
            break;
        }
        case 'ne': {
            const anchorLeft = origin.left;
            const anchorBottom = origin.top + origin.height;
            width = clamp(event.clientX - interaction.startClientX + origin.width, minWidth, interaction.containerRect.width - anchorLeft);
            height = width / interaction.aspectRatio;
            if (height > anchorBottom) {
                height = anchorBottom;
                width = height * interaction.aspectRatio;
            }
            width = Math.min(width, maxWidthFromHeight);
            height = width / interaction.aspectRatio;
            left = anchorLeft;
            top = anchorBottom - height;
            break;
        }
        case 'nw': {
            const anchorRight = origin.left + origin.width;
            const anchorBottom = origin.top + origin.height;
            width = clamp(anchorRight - (origin.left + (event.clientX - interaction.startClientX)), minWidth, anchorRight);
            height = width / interaction.aspectRatio;
            if (height > anchorBottom) {
                height = anchorBottom;
                width = height * interaction.aspectRatio;
            }
            width = Math.min(width, maxWidthFromHeight);
            height = width / interaction.aspectRatio;
            left = anchorRight - width;
            top = anchorBottom - height;
            break;
        }
    }

    emit('updateRect', toNormalizedRect(interaction.containerRect, {
        left,
        top,
        width,
        height,
    }));
}

function handleWindowPointerMove(event: PointerEvent) {
    const interaction = activeInteraction;
    if (!interaction || event.pointerId !== interaction.pointerId) {
        return;
    }

    if (interaction.mode === 'move') {
        applyMoveInteraction(interaction, event);
        return;
    }

    applyResizeInteraction(interaction, event);
}

function handleWindowPointerUp(event: PointerEvent) {
    if (!activeInteraction || event.pointerId !== activeInteraction.pointerId) {
        return;
    }
    stopInteraction();
}

function isEditableTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    if (target.isContentEditable) {
        return true;
    }

    return [
        'INPUT',
        'TEXTAREA',
        'SELECT',
    ].includes(target.tagName);
}

function handleWindowKeyDown(event: KeyboardEvent) {
    if (!placement || busy || event.defaultPrevented || isEditableTarget(event.target)) {
        return;
    }

    if (event.key === 'Escape') {
        event.preventDefault();
        emit('cancel');
        return;
    }

    if (
        (event.key === 'Enter' || event.key === 'NumpadEnter')
        && !event.metaKey
        && !event.ctrlKey
        && !event.altKey
    ) {
        event.preventDefault();
        emit('finalize');
    }
}

onMounted(() => {
    window.addEventListener('keydown', handleWindowKeyDown);
});

onBeforeUnmount(() => {
    stopInteraction();
    window.removeEventListener('keydown', handleWindowKeyDown);
});
</script>

<style scoped>
.pdf-image-placement {
    position: absolute;
    z-index: 8;
    touch-action: none;
    border-radius: 0.45rem;
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--ui-primary) 70%, var(--ui-bg) 30%);
}

.pdf-image-placement__preview {
    width: 100%;
    height: 100%;
    display: block;
    border-radius: inherit;
    object-fit: fill;
    pointer-events: none;
    user-select: none;
}

.pdf-image-placement__surface {
    position: absolute;
    inset: 0;
    border: none;
    border-radius: inherit;
    background: color-mix(in oklab, transparent 82%, var(--ui-primary) 18%);
    cursor: move;
}

.pdf-image-placement__surface:disabled {
    cursor: progress;
}

.pdf-image-placement__resizers {
    position: absolute;
    inset: 0;
    pointer-events: none;
}

.pdf-image-placement__resizer {
    position: absolute;
    width: 0.9rem;
    height: 0.9rem;
    border: 1px solid var(--ui-bg);
    border-radius: 999px;
    background: var(--ui-primary);
    box-shadow: 0 1px 3px color-mix(in srgb, var(--ui-bg-inverted) 22%, transparent);
    pointer-events: auto;
}

.pdf-image-placement__resizer:disabled {
    cursor: progress;
}

.pdf-image-placement__resizer--nw {
    top: -0.45rem;
    left: -0.45rem;
    cursor: nwse-resize;
}

.pdf-image-placement__resizer--ne {
    top: -0.45rem;
    right: -0.45rem;
    cursor: nesw-resize;
}

.pdf-image-placement__resizer--se {
    right: -0.45rem;
    bottom: -0.45rem;
    cursor: nwse-resize;
}

.pdf-image-placement__resizer--sw {
    left: -0.45rem;
    bottom: -0.45rem;
    cursor: nesw-resize;
}

.pdf-image-placement__controls {
    position: absolute;
    left: 0;
    top: calc(100% + 0.6rem);
    display: flex;
    gap: 0.45rem;
    align-items: center;
    padding: 0.35rem;
    border: 1px solid var(--app-pdf-context-menu-panel-action-border);
    border-radius: 999px;
    background: color-mix(in oklab, var(--ui-bg) 94%, var(--ui-bg-elevated) 6%);
    box-shadow: var(--app-pdf-context-menu-panel-shadow);
    white-space: nowrap;
}

.pdf-image-placement__action {
    border: 1px solid transparent;
    border-radius: 999px;
    min-height: 0;
    padding: 0.28rem 0.7rem;
    font-size: 0.74rem;
    font-weight: 600;
    line-height: 1.2;
    transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}

.pdf-image-placement__action--secondary {
    background: color-mix(in oklab, var(--ui-bg-muted) 62%, var(--ui-bg) 38%);
    border-color: var(--app-pdf-context-menu-panel-action-border);
    color: var(--ui-text);
}

.pdf-image-placement__action--primary {
    background: color-mix(in oklab, var(--ui-primary) 18%, var(--ui-bg) 82%);
    border-color: color-mix(in oklab, var(--ui-primary) 48%, var(--ui-border) 52%);
    color: var(--ui-text-highlighted);
}

.pdf-image-placement__action:disabled {
    opacity: 0.6;
    cursor: progress;
}
</style>
