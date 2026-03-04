<template>
    <UTooltip :text="preview" :delay-duration="200" :open="isDragging ? false : undefined">
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
            :data-comment-count="clustered.length > 1 ? String(clustered.length) : undefined"
            @click.stop="handleClick"
            @contextmenu.prevent="handleContextMenu"
            @pointerdown.stop="handlePointerDown"
        >
            <UIcon name="i-lucide-message-square" class="pdf-comment-marker-icon" />
            <span
                v-if="clustered.length > 1"
                class="pdf-comment-marker-badge"
            >
                {{ clustered.length }}
            </span>
        </button>
    </UTooltip>
</template>

<script setup lang="ts">
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/composables/pdf/annotations/types';
import { clamp } from 'es-toolkit/math';

const DRAG_THRESHOLD = 5;
const DEFAULT_POINT_MARKER_SIZE = 0.0016;

const props = defineProps<{
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
const isDragging = ref(false);
const dragOffsetX = ref(0);
const dragOffsetY = ref(0);

let startX = 0;
let startY = 0;
let dragActivated = false;
let suppressClick = false;
let pendingDragCommit = false;

const hasDragOffset = computed(() =>
    dragOffsetX.value !== 0 || dragOffsetY.value !== 0);

const dragStyle = computed(() => {
    if (!isDragging.value && !hasDragOffset.value) {
        return undefined;
    }
    return {
        transform: `translate(calc(-50% + ${dragOffsetX.value}px), calc(-50% + ${dragOffsetY.value}px))`,
        zIndex: '10',
    };
});

watch([
    () => props.leftPercent,
    () => props.topPercent,
], () => {
    if (pendingDragCommit) {
        pendingDragCommit = false;
        dragOffsetX.value = 0;
        dragOffsetY.value = 0;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                isDragging.value = false;
            });
        });
    }
});

function handleClick() {
    if (suppressClick) {
        suppressClick = false;
        return;
    }
    emit('openNote', props.annotation);
}

function handleContextMenu(event: MouseEvent) {
    emit('contextMenu', props.annotation, event);
}

function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0) {
        return;
    }

    const button = buttonRef.value;
    if (!button) {
        return;
    }

    startX = event.clientX;
    startY = event.clientY;
    dragActivated = false;
    suppressClick = false;

    button.setPointerCapture(event.pointerId);
    button.addEventListener('pointermove', handlePointerMove);
    button.addEventListener('pointerup', handlePointerUp);
    button.addEventListener('lostpointercapture', handleLostCapture);
}

function handlePointerMove(event: PointerEvent) {
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;

    if (!dragActivated) {
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) {
            return;
        }
        dragActivated = true;
        isDragging.value = true;
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
    }

    dragOffsetX.value = dx;
    dragOffsetY.value = dy;
}

function handlePointerUp(event: PointerEvent) {
    const wasDragging = dragActivated;

    if (wasDragging) {
        suppressClick = true;
        commitDrag(event.clientX, event.clientY);
    }

    cleanup(event.pointerId);
}

function handleLostCapture(event: PointerEvent) {
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
    emit('moveMarker', props.annotation, markerRect);
}

function cleanup(pointerId?: number) {
    const button = buttonRef.value;
    if (button) {
        button.removeEventListener('pointermove', handlePointerMove);
        button.removeEventListener('pointerup', handlePointerUp);
        button.removeEventListener('lostpointercapture', handleLostCapture);
        if (typeof pointerId === 'number' && button.hasPointerCapture(pointerId)) {
            button.releasePointerCapture(pointerId);
        }
    }

    dragActivated = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    if (!pendingDragCommit) {
        isDragging.value = false;
        dragOffsetX.value = 0;
        dragOffsetY.value = 0;
    }
}

onBeforeUnmount(() => {
    // Unmount can interrupt an active drag path before pointerup/lostcapture.
    cleanup();
});
</script>

<style scoped>
.pdf-comment-marker-button {
    position: absolute;
    left: calc(v-bind('leftPercent + "%"'));
    top: calc(v-bind('topPercent + "%"'));
    width: 1.3rem;
    height: 1.3rem;
    border: 1px solid color-mix(in srgb, var(--ui-warning) 62%, var(--ui-border) 38%);
    border-radius: 9999px;
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
    transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
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
    right: -6px;
    top: -6px;
    min-width: 12px;
    height: 12px;
    border-radius: 999px;
    border: 1.5px solid var(--app-pdf-comment-marker-badge-border);
    background: var(--app-pdf-comment-marker-badge-bg);
    color: var(--app-pdf-comment-marker-badge-fg);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 6.5px;
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
    animation: inline-comment-focus-pulse 0.9s ease-out;
}
</style>
