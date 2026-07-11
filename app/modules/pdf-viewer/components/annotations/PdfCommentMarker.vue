<template>
    <AppTooltip
        :text="preview"
        :delay-duration="200"
        :disabled="shouldSuppressTooltip"
        :open="controlledTooltipOpen"
        usefulness="always"
        @update:open="handleTooltipOpenUpdate"
    >
        <button
            ref="buttonRef"
            type="button"
            class="pdf-comment-marker-button"
            :class="{
                'is-active': isActive,
                'is-cluster': clustered.length > 1,
                'is-dragging': isDragging,
            }"
            :style="dragStyle"
            :aria-label="labelText"
            :data-stable-key="annotation.stableKey"
            :data-annotation-id="annotationIdForSummary(annotation)"
            :data-comment-count="clustered.length > 1 ? String(clustered.length) : undefined"
            @click.prevent.stop="handleClick"
            @contextmenu.prevent="handleContextMenu"
            @mousedown.prevent.stop
            @pointerdown.prevent.stop="handlePointerDown"
            @pointerenter="handlePointerEnter"
            @pointerleave="handlePointerLeave"
        >
            <UIcon name="i-ph-chat" class="pdf-comment-marker-icon" />
            <span
                v-if="clustered.length > 1"
                class="pdf-comment-marker-badge"
            >
                {{ clustered.length }}
            </span>
        </button>
    </AppTooltip>
</template>

<script setup lang="ts">
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { clamp } from 'es-toolkit/math';
import { useEventListener } from '@vueuse/core';
import { annotationIdForSummary } from '@app/modules/pdf-viewer/annotations/domain/annotationSummaryIdentity';

const DRAG_THRESHOLD = 5;
const DEFAULT_POINT_MARKER_SIZE = 0.0016;

const {
    annotation,
    isActive,
    leftPercent,
    topPercent,
} = defineProps<{
    annotation: IAnnotationCommentSummary;
    clustered: IAnnotationCommentSummary[];
    isActive: boolean;
    preview: string;
    labelText: string;
    leftPercent: number;
    topPercent: number;
}>();

const emit = defineEmits<{
    openNote: [comment: IAnnotationCommentSummary];
    contextMenu: [comment: IAnnotationCommentSummary, event: MouseEvent];
    moveMarker: [comment: IAnnotationCommentSummary, markerRect: IAnnotationMarkerRect];
}>();

const buttonRef = ref<HTMLButtonElement | null>(null);
const activePointerTarget = ref<HTMLButtonElement | null>(null);
const isDragging = ref(false);
const isTooltipSuppressed = ref(false);
const isTooltipOpen = ref(false);
const isPointerOver = ref(false);
const dragOffsetX = ref(0);
const dragOffsetY = ref(0);

let startX = 0;
let startY = 0;
let lastPointerClientX = 0;
let lastPointerClientY = 0;
let dragActivated = false;
let suppressClick = false;
let pendingDragCommit = false;
let isUnmounted = false;
let activePointerId: number | null = null;
let suppressTooltipUntilPointerLeave = false;
let dragSettleFrameId: number | null = null;
let dragSettleSecondFrameId: number | null = null;
let dragCommitFallbackFrameId: number | null = null;
let dragCommitFallbackSecondFrameId: number | null = null;

const hasDragOffset = computed(() =>
    dragOffsetX.value !== 0 || dragOffsetY.value !== 0);
const shouldSuppressTooltip = computed(() =>
    isTooltipSuppressed.value || isDragging.value || hasDragOffset.value);
const controlledTooltipOpen = computed(() =>
    shouldSuppressTooltip.value ? false : isTooltipOpen.value);

const dragStyle = computed(() => {
    if (!isDragging.value && !hasDragOffset.value) {
        return undefined;
    }
    return {
        transform: `translate(calc(-50% + ${dragOffsetX.value}px), calc(-50% + ${dragOffsetY.value}px))`,
        zIndex: '10',
    };
});

function cancelDragSettleFrames() {
    if (dragSettleFrameId !== null) {
        cancelAnimationFrame(dragSettleFrameId);
        dragSettleFrameId = null;
    }
    if (dragSettleSecondFrameId !== null) {
        cancelAnimationFrame(dragSettleSecondFrameId);
        dragSettleSecondFrameId = null;
    }
}

function cancelDragCommitFallbackFrames() {
    if (dragCommitFallbackFrameId !== null) {
        cancelAnimationFrame(dragCommitFallbackFrameId);
        dragCommitFallbackFrameId = null;
    }
    if (dragCommitFallbackSecondFrameId !== null) {
        cancelAnimationFrame(dragCommitFallbackSecondFrameId);
        dragCommitFallbackSecondFrameId = null;
    }
}

function dispatchMarkerDragState(active: boolean) {
    if (typeof window === 'undefined') {
        return;
    }
    const detail = {
        active,
        stableKey: annotation.stableKey,
    };
    window.dispatchEvent(new CustomEvent('pdf-comment-marker-drag-state', {detail}));
}

function clearPdfjsAnnotationFocusLeak() {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) {
        return;
    }
    if (!activeElement.closest('.annotationLayer, .annotation-layer, .annotationEditorLayer, .annotation-editor-layer')) {
        return;
    }

    // PDF.js can focus its native annotation trigger underneath our Vue marker
    // before the note window opens, leaving a stale rectangle over the marker.
    activeElement.blur();
}

function isLastPointerWithinMarker() {
    const button = buttonRef.value;
    if (!button) {
        return false;
    }

    const rect = button.getBoundingClientRect();
    return lastPointerClientX >= rect.left
        && lastPointerClientX <= rect.right
        && lastPointerClientY >= rect.top
        && lastPointerClientY <= rect.bottom;
}

function scheduleDragSettledCleanup() {
    cancelDragSettleFrames();
    dragSettleFrameId = requestAnimationFrame(() => {
        dragSettleFrameId = null;
        dragSettleSecondFrameId = requestAnimationFrame(() => {
            dragSettleSecondFrameId = null;
            if (!isUnmounted) {
                isDragging.value = false;
                if (
                    suppressTooltipUntilPointerLeave
                    && (isPointerOver.value || isLastPointerWithinMarker())
                ) {
                    isTooltipSuppressed.value = true;
                } else {
                    suppressTooltipUntilPointerLeave = false;
                    isTooltipSuppressed.value = false;
                }
                dispatchMarkerDragState(false);
            }
        });
    });
}

function completePendingDragCommit() {
    if (!pendingDragCommit) {
        return;
    }
    pendingDragCommit = false;
    dragOffsetX.value = 0;
    dragOffsetY.value = 0;
    cancelDragCommitFallbackFrames();
    scheduleDragSettledCleanup();
}

function schedulePendingDragCommitFallback() {
    cancelDragCommitFallbackFrames();
    dragCommitFallbackFrameId = requestAnimationFrame(() => {
        dragCommitFallbackFrameId = null;
        dragCommitFallbackSecondFrameId = requestAnimationFrame(() => {
            dragCommitFallbackSecondFrameId = null;
            if (!isUnmounted) {
                completePendingDragCommit();
            }
        });
    });
}

function suppressTooltipUntilPointerExit() {
    // Reka keeps an already-open hover tooltip alive until hover state changes.
    // Own its open state here so the portal closes as soon as the note opens.
    suppressTooltipUntilPointerLeave = true;
    isTooltipSuppressed.value = true;
    isTooltipOpen.value = false;
}

function handleTooltipOpenUpdate(open: boolean) {
    isTooltipOpen.value = shouldSuppressTooltip.value ? false : open;
}

watch([
    () => leftPercent,
    () => topPercent,
], () => {
    completePendingDragCommit();
});

watch(() => isActive, (active) => {
    if (active && (isPointerOver.value || isLastPointerWithinMarker())) {
        suppressTooltipUntilPointerExit();
        return;
    }

    if (!isPointerOver.value && !isLastPointerWithinMarker()) {
        releaseTooltipAfterPointerLeave();
    }
});

function handleClick() {
    clearPdfjsAnnotationFocusLeak();
    if (suppressClick) {
        suppressClick = false;
        return;
    }
    suppressTooltipUntilPointerExit();
    emit('openNote', annotation);
}

function handleContextMenu(event: MouseEvent) {
    emit('contextMenu', annotation, event);
}

function releaseTooltipAfterPointerLeave() {
    if (isDragging.value || hasDragOffset.value || pendingDragCommit) {
        return;
    }

    suppressTooltipUntilPointerLeave = false;
    isTooltipSuppressed.value = false;
}

function handlePointerEnter() {
    isPointerOver.value = true;
}

function handlePointerLeave() {
    isPointerOver.value = false;
    releaseTooltipAfterPointerLeave();
}

function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0) {
        return;
    }
    clearPdfjsAnnotationFocusLeak();

    const button = buttonRef.value;
    if (!button) {
        return;
    }

    startX = event.clientX;
    startY = event.clientY;
    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;
    dragActivated = false;
    suppressClick = false;
    isPointerOver.value = true;
    activePointerId = event.pointerId;

    activePointerTarget.value = button;
}

function handlePointerMove(event: PointerEvent) {
    if (activePointerId !== event.pointerId || !activePointerTarget.value) {
        return;
    }

    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;

    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragActivated) {
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) {
            return;
        }
        dragActivated = true;
        isDragging.value = true;
        suppressTooltipUntilPointerExit();
        dispatchMarkerDragState(true);
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
    }

    dragOffsetX.value = dx;
    dragOffsetY.value = dy;
    window.dispatchEvent(new CustomEvent('pdf-comment-marker-drag'));
}

function handlePointerUp(event: PointerEvent) {
    if (activePointerId !== event.pointerId || !activePointerTarget.value) {
        return;
    }

    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;
    const wasDragging = dragActivated;

    if (wasDragging) {
        suppressClick = true;
        commitDrag(event.clientX, event.clientY);
    }

    cleanup(event.pointerId);
}

function handlePointerCancel(event: PointerEvent) {
    if (activePointerId !== event.pointerId || !activePointerTarget.value) {
        return;
    }

    lastPointerClientX = event.clientX;
    lastPointerClientY = event.clientY;
    const wasDragging = dragActivated;

    if (wasDragging) {
        commitDrag(event.clientX, event.clientY);
    }

    cleanup(event.pointerId);
}

function commitDrag(clientX: number, clientY: number) {
    const button = buttonRef.value;
    if (!button) {
        return;
    }

    const pageContainer = button.closest<HTMLElement>('.page_container');
    if (!pageContainer) {
        return;
    }

    const pageRect = pageContainer.getBoundingClientRect();
    const normalizedX = clamp((clientX - pageRect.left) / pageRect.width, 0, 1);
    const normalizedY = clamp((clientY - pageRect.top) / pageRect.height, 0, 1);

    const markerRect: IAnnotationMarkerRect = {
        left: normalizedX - DEFAULT_POINT_MARKER_SIZE / 2,
        top: normalizedY - DEFAULT_POINT_MARKER_SIZE / 2,
        width: DEFAULT_POINT_MARKER_SIZE,
        height: DEFAULT_POINT_MARKER_SIZE,
    };

    pendingDragCommit = true;
    emit('moveMarker', annotation, markerRect);
    schedulePendingDragCommitFallback();
}

function cleanup(pointerId?: number) {
    void pointerId;
    activePointerTarget.value = null;
    activePointerId = null;

    dragActivated = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    if (!pendingDragCommit) {
        isDragging.value = false;
        suppressTooltipUntilPointerLeave = false;
        isTooltipSuppressed.value = false;
        dispatchMarkerDragState(false);
        dragOffsetX.value = 0;
        dragOffsetY.value = 0;
    }
}

useEventListener(import.meta.client ? window : undefined, 'pointermove', handlePointerMove);
useEventListener(import.meta.client ? window : undefined, 'pointerup', handlePointerUp);
useEventListener(import.meta.client ? window : undefined, 'pointercancel', handlePointerCancel);

onBeforeUnmount(() => {
    isUnmounted = true;
    cancelDragSettleFrames();
    cancelDragCommitFallbackFrames();
    pendingDragCommit = false;
    dispatchMarkerDragState(false);
    // Unmount can interrupt an active drag path before pointerup/lostcapture.
    cleanup();
});
</script>

<style scoped>
.pdf-comment-marker-button {
    position: absolute;
    left: calc(v-bind('leftPercent + "%"'));
    top: calc(v-bind('topPercent + "%"'));
    width: var(--app-note-anchor-size);
    height: var(--app-note-anchor-size);
    border: 1px solid color-mix(in srgb, var(--ui-warning) 62%, var(--ui-border) 38%);
    border-radius: var(--app-radius-full);
    transform: translate(-50%, -50%);
    background: color-mix(in srgb, var(--ui-warning) 20%, var(--ui-bg) 80%);
    color: color-mix(in srgb, var(--ui-warning) 58%, var(--ui-text) 42%);
    cursor: pointer;
    pointer-events: auto;
    opacity: 0.82;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    touch-action: none;
    transition:
        background-color var(--app-transition-standard),
        border-color var(--app-transition-standard),
        transform var(--app-transition-standard),
        opacity var(--app-transition-standard);
}

.pdf-comment-marker-button:hover {
    background: color-mix(in srgb, var(--ui-warning) 30%, var(--ui-bg) 70%);
    border-color: color-mix(in srgb, var(--ui-warning) 75%, var(--ui-border) 25%);
    transform: translate(-50%, calc(-50% - 1px));
    opacity: 0.95;
}

.pdf-comment-marker-button.is-dragging {
    opacity: 0.95;
    cursor: grabbing;
    background: color-mix(in srgb, var(--ui-warning) 30%, var(--ui-bg) 70%);
    border-color: color-mix(in srgb, var(--ui-warning) 75%, var(--ui-border) 25%);
    transition: none;
}

.pdf-comment-marker-button.is-dragging:hover {
    transform: translate(-50%, -50%);
}

.pdf-comment-marker-button.is-active {
    border-color: color-mix(in srgb, var(--ui-warning) 75%, var(--ui-border) 25%);
    background: color-mix(in srgb, var(--ui-warning) 30%, var(--ui-bg) 70%);
    opacity: 0.92;
}

.pdf-comment-marker-icon {
    width: 0.625rem;
    height: 0.625rem;
    flex-shrink: 0;
}

.pdf-comment-marker-badge {
    position: absolute;
    right: calc(var(--app-space-lg) * -1);
    top: calc(var(--app-space-lg) * -1);
    min-width: var(--app-pdf-annotation-properties-range-thumb-size);
    height: var(--app-pdf-annotation-properties-range-thumb-size);
    border-radius: var(--app-radius-full);
    border: 1.5px solid var(--app-pdf-comment-marker-badge-border);
    background: var(--app-pdf-comment-marker-badge-bg);
    color: var(--app-pdf-comment-marker-badge-fg);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: var(--app-text-size-marker);
    font-weight: 700;
    line-height: 1;
    padding: 0 3px;
    font-variant-numeric: tabular-nums;
    box-shadow: var(--app-pdf-comment-marker-badge-shadow);
    pointer-events: none;
}

.pdf-comment-marker-button.is-cluster:hover .pdf-comment-marker-badge,
.pdf-comment-marker-button.is-cluster.is-active .pdf-comment-marker-badge {
    border-color: var(--app-pdf-comment-marker-badge-border-active);
    box-shadow: var(--app-pdf-comment-marker-badge-shadow-active);
}

.pdf-comment-marker-button:global(.pdf-comment-focus-pulse) {
    animation: inline-comment-focus-pulse 1s ease-out;
}
</style>
