<template>
    <PdfAnnotationNoteWindow
        v-for="note in visibleAnnotationNoteWindows"
        :key="note.comment.stableKey"
        :comment="note.comment"
        :text="note.text"
        :saving="note.saving"
        :error="note.error"
        :position="annotationNotePositions[note.comment.stableKey] ?? null"
        :z-index="90 + note.order"
        @update:text="$emit('update-note-text', note.comment.stableKey, $event)"
        @update:position="$emit('update-note-position', note.comment.stableKey, $event)"
        @minimize="$emit('minimize-note', note.comment.stableKey)"
        @delete="$emit('delete-comment', note.comment)"
        @focus="$emit('focus-note', note.comment.stableKey)"
    />
    <template
        v-for="note in minimizedAnnotationNoteWindows"
        :key="`minimized-${note.comment.stableKey}`"
    >
        <Teleport
            v-if="minimizedIndicatorTargets[note.comment.stableKey]"
            :to="minimizedIndicatorTargets[note.comment.stableKey]"
        >
            <UTooltip
                :text="getMinimizedNotePreview(note)"
                :delay-duration="250"
            >
                <button
                    type="button"
                    class="pdf-note-minimized-indicator"
                    :style="getMinimizedIndicatorStyle(note)"
                    :aria-label="t('annotations.openNote')"
                    @mousedown.prevent
                    @click="$emit('restore-note', note.comment.stableKey)"
                >
                    <UIcon name="i-lucide-sticky-note" class="size-3" />
                </button>
            </UTooltip>
        </Teleport>
    </template>
    <PdfAnnotationContextMenu
        :menu="annotationContextMenu"
        :style="annotationContextMenuStyle"
        :can-copy="annotationContextMenuCanCopy"
        :can-copy-selection="annotationContextMenuCanCopySelection"
        :can-create-free="annotationContextMenuCanCreateFree"
        :annotation-label="contextMenuAnnotationLabel"
        :delete-label="contextMenuDeleteActionLabel"
        @open-note="$emit('context-open-note')"
        @copy-text="$emit('context-copy-text')"
        @copy-selection-text="$emit('context-copy-selection-text')"
        @delete="$emit('context-delete')"
        @markup="(tool: TAnnotationTool) => $emit('context-markup', tool)"
        @create-free-note="$emit('context-create-free-note')"
        @create-selection-note="$emit('context-create-selection-note')"
    />
    <PdfPageContextMenu
        :menu="pageContextMenu"
        :style="pageContextMenuStyle"
        :is-operation-in-progress="isPageOperationInProgress"
        :is-djvu-mode="isDjvuMode"
        @delete-pages="$emit('page-delete')"
        @extract-pages="$emit('page-extract')"
        @export-pages="$emit('page-export')"
        @rotate-cw="$emit('page-rotate-cw')"
        @rotate-ccw="$emit('page-rotate-ccw')"
        @insert-before="$emit('page-insert-before')"
        @insert-after="$emit('page-insert-after')"
        @select-all="$emit('page-select-all')"
        @invert-selection="$emit('page-invert-selection')"
    />
    <PdfAnnotationProperties
        :shape="selectedShapeForProperties"
        :x="shapePropertiesX"
        :y="shapePropertiesY"
        @update="(updates: Partial<IShapeAnnotation>) => $emit('shape-update', updates)"
        @close="$emit('shape-close')"
    />
</template>

<script setup lang="ts">
import {
    computed,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/composables/pdf/pdfAnnotationUtils';
import type { IAnnotationNotePosition } from '@app/composables/pdf/useAnnotationNoteWindows';

interface IAnnotationNoteWindowEntry {
    comment: IAnnotationCommentSummary;
    text: string;
    saving: boolean;
    error: string | null;
    order: number;
    isMinimized: boolean;
}

interface IContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    comment: IAnnotationCommentSummary | null;
    hasSelection: boolean;
    selectionText: string;
    pageNumber: number | null;
    pageX: number | null;
    pageY: number | null;
}

interface IPageContextMenuState {
    visible: boolean;
    x: number;
    y: number;
    pages: number[];
}

const props = defineProps<{
    sortedAnnotationNoteWindows: IAnnotationNoteWindowEntry[];
    annotationNotePositions: Record<string, IAnnotationNotePosition>;
    annotationViewportRoot?: HTMLElement | null;
    annotationZoom?: number;
    annotationContextMenu: IContextMenuState;
    annotationContextMenuStyle: Record<string, string>;
    annotationContextMenuCanCopy: boolean;
    annotationContextMenuCanCopySelection: boolean;
    annotationContextMenuCanCreateFree: boolean;
    contextMenuAnnotationLabel: string;
    contextMenuDeleteActionLabel: string;
    pageContextMenu: IPageContextMenuState;
    pageContextMenuStyle: Record<string, string>;
    isPageOperationInProgress: boolean;
    isDjvuMode: boolean;
    selectedShapeForProperties: IShapeAnnotation | null;
    shapePropertiesX: number;
    shapePropertiesY: number;
}>();

const { t } = useTypedI18n();

const visibleAnnotationNoteWindows = computed(() =>
    props.sortedAnnotationNoteWindows.filter((note) => !note.isMinimized),
);
const minimizedAnnotationNoteWindows = computed(() =>
    props.sortedAnnotationNoteWindows.filter((note) => note.isMinimized),
);
const indicatorDomTick = ref(0);
let refreshBurstFrameId: number | null = null;
let refreshBurstFramesRemaining = 0;
let viewportMutationObserver: MutationObserver | null = null;

function refreshIndicatorDom() {
    indicatorDomTick.value += 1;
}

function runRefreshBurstFrame() {
    refreshBurstFrameId = null;
    refreshIndicatorDom();
    refreshBurstFramesRemaining = Math.max(0, refreshBurstFramesRemaining - 1);
    if (refreshBurstFramesRemaining > 0 && typeof window !== 'undefined') {
        refreshBurstFrameId = window.requestAnimationFrame(runRefreshBurstFrame);
    }
}

function scheduleIndicatorRefreshBurst(frames = 6) {
    if (typeof window === 'undefined') {
        refreshIndicatorDom();
        return;
    }
    refreshBurstFramesRemaining = Math.max(refreshBurstFramesRemaining, Math.max(1, Math.round(frames)));
    if (refreshBurstFrameId !== null) {
        return;
    }
    refreshBurstFrameId = window.requestAnimationFrame(runRefreshBurstFrame);
}

const minimizedIndicatorTargets = computed<Record<string, HTMLElement>>(() => {
    void indicatorDomTick.value;
    const viewportRoot = props.annotationViewportRoot;
    if (!viewportRoot) {
        return {};
    }

    const targets: Record<string, HTMLElement> = {};
    minimizedAnnotationNoteWindows.value.forEach((note) => {
        const pageContainer = viewportRoot.querySelector<HTMLElement>(`.page_container[data-page="${note.comment.pageNumber}"]`);
        if (pageContainer) {
            targets[note.comment.stableKey] = pageContainer;
        }
    });
    return targets;
});

function getMinimizedIndicatorStyle(note: IAnnotationNoteWindowEntry) {
    void indicatorDomTick.value;
    void props.annotationZoom;

    const markerRect = normalizeMarkerRect(note.comment.markerRect);
    const leftPercent = markerRect
        ? Math.max(1, Math.min(99, (markerRect.left + markerRect.width) * 100))
        : 3;
    const topPercent = markerRect
        ? Math.max(1, Math.min(99, markerRect.top * 100))
        : 3;

    return {
        left: `${leftPercent}%`,
        top: `${topPercent}%`,
        zIndex: String(20 + note.order),
    };
}

function getMinimizedNotePreview(note: IAnnotationNoteWindowEntry) {
    const text = (note.text || note.comment.text || '').trim();
    if (!text) {
        return t('annotations.emptyNote');
    }
    if (text.length <= 180) {
        return text;
    }
    return `${text.slice(0, 177)}...`;
}

function reconnectViewportObservers() {
    viewportMutationObserver?.disconnect();
    viewportMutationObserver = null;

    const viewportRoot = props.annotationViewportRoot;
    if (!viewportRoot) {
        return;
    }

    if (typeof MutationObserver !== 'undefined') {
        viewportMutationObserver = new MutationObserver(() => {
            scheduleIndicatorRefreshBurst(4);
        });
        viewportMutationObserver.observe(viewportRoot, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: [
                'style',
                'class',
            ],
        });
    }
}

onMounted(() => {
    reconnectViewportObservers();
    scheduleIndicatorRefreshBurst(10);
});

onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
        if (refreshBurstFrameId !== null) {
            window.cancelAnimationFrame(refreshBurstFrameId);
            refreshBurstFrameId = null;
        }
    }
    viewportMutationObserver?.disconnect();
    viewportMutationObserver = null;
});

watch(
    () => props.annotationViewportRoot,
    () => {
        reconnectViewportObservers();
        scheduleIndicatorRefreshBurst(12);
    },
);

watch(
    () => props.annotationZoom,
    () => {
        scheduleIndicatorRefreshBurst(12);
    },
);

watch(
    () => minimizedAnnotationNoteWindows.value.map((note) => `${note.comment.stableKey}:${note.comment.pageNumber}`),
    () => {
        scheduleIndicatorRefreshBurst(6);
    },
);

defineEmits<{
    'update-note-text': [stableKey: string, text: string];
    'update-note-position': [stableKey: string, position: IAnnotationNotePosition];
    'minimize-note': [stableKey: string];
    'restore-note': [stableKey: string];
    'delete-comment': [comment: IAnnotationCommentSummary];
    'focus-note': [stableKey: string];
    'context-open-note': [];
    'context-copy-text': [];
    'context-copy-selection-text': [];
    'context-delete': [];
    'context-markup': [tool: TAnnotationTool];
    'context-create-free-note': [];
    'context-create-selection-note': [];
    'page-delete': [];
    'page-extract': [];
    'page-export': [];
    'page-rotate-cw': [];
    'page-rotate-ccw': [];
    'page-insert-before': [];
    'page-insert-after': [];
    'page-select-all': [];
    'page-invert-selection': [];
    'shape-update': [updates: Partial<IShapeAnnotation>];
    'shape-close': [];
}>();
</script>

<style scoped>
.pdf-note-minimized-indicator {
    position: absolute;
    width: 1.6rem;
    height: 1.6rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    border: 1px solid color-mix(in srgb, var(--ui-warning) 62%, var(--ui-border) 38%);
    background: color-mix(in srgb, var(--ui-warning) 26%, var(--ui-bg) 74%);
    color: color-mix(in srgb, var(--ui-warning) 58%, var(--ui-text) 42%);
    cursor: pointer;
    transform: translate(-50%, -50%);
    transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
}

.pdf-note-minimized-indicator:hover {
    background: color-mix(in srgb, var(--ui-warning) 38%, var(--ui-bg) 62%);
    border-color: color-mix(in srgb, var(--ui-warning) 75%, var(--ui-border) 25%);
    transform: translate(-50%, calc(-50% - 1px));
}

.pdf-note-minimized-indicator:focus-visible {
    outline: 1px solid var(--ui-primary);
    outline-offset: 1px;
}
</style>
