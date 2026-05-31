<template>
    <div
        ref="noteWindowRef"
        class="note-window"
        :style="windowStyle"
        :data-stable-key="comment.stableKey"
        @mousedown="focusNote"
        @focusin="focusNote"
    >
        <header
            class="note-window__title"
            @mousedown.prevent="startDrag"
        >
            <div class="note-window__title-main">
                <strong class="note-window__summary">{{ title }}</strong>
                <span class="note-window__meta">{{ authorText }}</span>
            </div>
            <div class="note-window__title-side">
                <div class="note-window__actions">
                    <button
                        type="button"
                        class="note-window__delete"
                        :aria-label="t('noteWindow.deleteNote')"
                        @click.stop="deleteNote"
                        @dblclick.stop.prevent
                    >
                        <UIcon name="i-ph-trash" class="size-3.5" />
                    </button>
                    <button
                        type="button"
                        class="note-window__close"
                        :aria-label="t('noteWindow.minimizeNote')"
                        @click="minimizeNote"
                    >
                        <UIcon name="i-ph-minus" class="size-3.5" />
                    </button>
                </div>
                <span class="note-window__date">{{ timestampText }}</span>
            </div>
        </header>

        <textarea
            ref="noteInputRef"
            class="note-window__textarea"
            :value="text"
            rows="8"
            :placeholder="t('noteWindow.writeNote')"
            @keydown.esc.stop.prevent="minimizeNote"
            @input="updateText"
            @change="updateText"
            @blur="updateText"
        ></textarea>

        <p v-if="saving" class="note-window__status" role="status" aria-live="polite">{{ t('noteWindow.saving') }}</p>
        <p v-if="error" class="note-window__error" role="alert" aria-live="assertive">{{ error }}</p>
    </div>
</template>

<script setup lang="ts">

import {
    useEventListener,
    useResizeObserver,
} from '@vueuse/core';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { NOTE_WINDOW } from '@app/constants/pdfLayout';
import {
    clampAnnotationNoteWindowPosition,
    clampAnnotationNoteWindowSize,
    type IAnnotationNoteWindowBounds,
} from '@app/composables/pdf/annotationNoteWindowBounds';

interface IAnnotationNotePosition {
    x: number;
    y: number;
    width?: number;
    height?: number;
}

interface IProps {
    comment: IAnnotationCommentSummary;
    text: string;
    saving?: boolean;
    error?: string | null;
    position?: IAnnotationNotePosition | null;
    zIndex?: number;
    boundsRoot?: HTMLElement | null;
}

const {
    comment,
    text,
    saving = false,
    error = null,
    position = null,
    zIndex = 55,
    boundsRoot = null,
} = defineProps<IProps>();

const emit = defineEmits<{
    (e: 'update:text', value: string): void;
    (e: 'update:position', value: IAnnotationNotePosition): void;
    (e: 'minimize'): void;
    (e: 'delete'): void;
    (e: 'focus'): void;
}>();

const { t } = useTypedI18n();

const noteInputRef = ref<HTMLTextAreaElement | null>(null);
const noteWindowRef = ref<HTMLElement | null>(null);
const offsetX = ref(14);
const offsetY = ref(72);
const width = ref(NOTE_WINDOW.DEFAULT_WIDTH);
const height = ref(NOTE_WINDOW.DEFAULT_HEIGHT);
const dragStartX = ref(0);
const dragStartY = ref(0);
const frameStartX = ref(0);
const frameStartY = ref(0);
const isDragging = ref(false);
let focusGuardTimer: ReturnType<typeof setTimeout> | null = null;
let focusGuardToken = 0;
const dragWindowTarget = shallowRef<Window | undefined>();

function focusNote() {
    emit('focus');
}

function deleteNote() {
    emit('delete');
}

function minimizeNote() {
    emit('minimize');
}

function updateText(event: Event) {
    emit('update:text', (event.target as HTMLTextAreaElement).value);
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const { settings } = useSettings();

const title = computed(() => t('noteWindow.popUpNote', { page: comment.pageNumber }));
const authorText = computed(() => comment.author?.trim() || settings.value.authorName?.trim() || t('noteWindow.unknownAuthor'));
const timestampText = computed(() => {
    const timestamp = comment.modifiedAt ?? comment.createdAt ?? null;
    if (!timestamp) {
        return t('noteWindow.noDate');
    }
    return timeFormatter.format(new Date(timestamp));
});

const windowStyle = computed(() => ({
    left: `${offsetX.value}px`,
    top: `${offsetY.value}px`,
    width: `${width.value}px`,
    height: `${height.value}px`,
    zIndex: String(zIndex),
}));
const boundsRootElement = computed(() => boundsRoot ?? null);
const documentElement = computed(() => (
    typeof document !== 'undefined'
        ? document.documentElement
        : null
));

async function focusTextInput() {
    await nextTick();
    await nextTick();
    const input = noteInputRef.value;
    if (!input) {
        return;
    }
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
    if (typeof window !== 'undefined') {
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                const postPaintInput = noteInputRef.value;
                if (!postPaintInput) {
                    return;
                }
                postPaintInput.blur();
                postPaintInput.focus({ preventScroll: true });
                const postEnd = postPaintInput.value.length;
                postPaintInput.setSelectionRange(postEnd, postEnd);
            });
        });
    }
}

function clearFocusGuard() {
    if (focusGuardTimer) {
        clearTimeout(focusGuardTimer);
        focusGuardTimer = null;
    }
}

function isTextEntryElement(element: HTMLElement) {
    if (element.isContentEditable) {
        return true;
    }
    const tagName = element.tagName;
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
}

function shouldReclaimFocus(activeElement: HTMLElement | null) {
    if (!activeElement || activeElement === document.body) {
        return true;
    }
    if (activeElement === noteInputRef.value) {
        return false;
    }
    if (noteWindowRef.value?.contains(activeElement)) {
        return false;
    }
    if (isTextEntryElement(activeElement)) {
        const insidePdfViewer = Boolean(
            activeElement.closest('.annotationEditorLayer, .annotation-editor-layer, .pdfViewer, .pdf-viewer'),
        );
        return insidePdfViewer;
    }
    return true;
}

function startFocusGuard(durationMs = 1200) {
    if (typeof window === 'undefined') {
        return;
    }
    clearFocusGuard();
    const token = ++focusGuardToken;
    const deadline = window.performance.now() + durationMs;
    const FAST_INTERVAL = 16;
    const FAST_DURATION = 400;
    const SLOW_INTERVAL = 60;

    const reclaimFocusUntilDeadline = async () => {
        if (token !== focusGuardToken) {
            return;
        }
        const input = noteInputRef.value;
        if (!input) {
            return;
        }
        const activeElement = document.activeElement as HTMLElement | null;
        if (shouldReclaimFocus(activeElement)) {
            await focusTextInput();
        }

        if (token !== focusGuardToken) {
            return;
        }
        const now = window.performance.now();
        if (now >= deadline) {
            focusGuardTimer = null;
            return;
        }
        const elapsed = durationMs - (deadline - now);
        const interval = elapsed < FAST_DURATION ? FAST_INTERVAL : SLOW_INTERVAL;
        focusGuardTimer = setTimeout(() => {
            void reclaimFocusUntilDeadline();
        }, interval);
    };

    void reclaimFocusUntilDeadline();
}

function syncPosition(position: IAnnotationNotePosition | null) {
    const previous = {
        x: offsetX.value,
        y: offsetY.value,
        width: width.value,
        height: height.value,
    };
    const nextSize = clampSize(
        position?.width ?? width.value ?? NOTE_WINDOW.DEFAULT_WIDTH,
        position?.height ?? height.value ?? NOTE_WINDOW.DEFAULT_HEIGHT,
    );
    width.value = nextSize.width;
    height.value = nextSize.height;

    const clamped = clampPosition(
        position?.x ?? offsetX.value,
        position?.y ?? offsetY.value,
        nextSize.width,
        nextSize.height,
    );
    offsetX.value = clamped.x;
    offsetY.value = clamped.y;
    return (
        previous.x !== offsetX.value
        || previous.y !== offsetY.value
        || previous.width !== width.value
        || previous.height !== height.value
    );
}

function emitPositionUpdate() {
    emit('update:position', {
        x: offsetX.value,
        y: offsetY.value,
        width: width.value,
        height: height.value,
    });
}

function clampSize(nextWidth: number, nextHeight: number) {
    return clampAnnotationNoteWindowSize(nextWidth, nextHeight, getWindowBounds());
}

function getWindowBounds(): IAnnotationNoteWindowBounds | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const rootRect = boundsRoot?.getBoundingClientRect();
    if (rootRect && rootRect.width > 0 && rootRect.height > 0) {
        return {
            left: rootRect.left,
            top: rootRect.top,
            right: rootRect.right,
            bottom: rootRect.bottom,
            width: rootRect.width,
            height: rootRect.height,
        };
    }

    return {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight,
    };
}

function clampPosition(x: number, y: number, nextWidth: number, nextHeight: number) {
    return clampAnnotationNoteWindowPosition(x, y, nextWidth, nextHeight, getWindowBounds());
}

function handlePointerMove(event: MouseEvent) {
    if (!isDragging.value) {
        return;
    }

    const nextX = frameStartX.value + (event.clientX - dragStartX.value);
    const nextY = frameStartY.value + (event.clientY - dragStartY.value);
    const clamped = clampPosition(nextX, nextY, width.value, height.value);

    offsetX.value = clamped.x;
    offsetY.value = clamped.y;
    emitPositionUpdate();
}

function stopDrag() {
    if (!isDragging.value) {
        return;
    }

    isDragging.value = false;
    dragWindowTarget.value = undefined;
    emitPositionUpdate();
}

function startDrag(event: MouseEvent) {
    emit('focus');
    isDragging.value = true;
    dragStartX.value = event.clientX;
    dragStartY.value = event.clientY;
    frameStartX.value = offsetX.value;
    frameStartY.value = offsetY.value;

    isDragging.value = true;
    if (typeof window === 'undefined') {
        return;
    }
    dragWindowTarget.value = window;
}

function handleViewportResize() {
    const clampedSize = clampSize(width.value, height.value);
    width.value = clampedSize.width;
    height.value = clampedSize.height;
    const clampedPosition = clampPosition(offsetX.value, offsetY.value, clampedSize.width, clampedSize.height);
    offsetX.value = clampedPosition.x;
    offsetY.value = clampedPosition.y;
    emitPositionUpdate();
}

function measureObservedWindowSize(entry: ResizeObserverEntry) {
    const target = entry.target instanceof HTMLElement
        ? entry.target
        : null;
    if (!target) {
        return {
            width: entry.contentRect.width,
            height: entry.contentRect.height,
        };
    }
    // Use border-box dimensions so we don't progressively shrink by border/padding
    // when syncing browser resize handles back into reactive state.
    return {
        width: target.offsetWidth,
        height: target.offsetHeight,
    };
}

useEventListener(
    typeof window !== 'undefined' ? window : undefined,
    'resize',
    handleViewportResize,
);
useEventListener(dragWindowTarget, 'mousemove', handlePointerMove);
useEventListener(dragWindowTarget, 'mouseup', stopDrag);

useResizeObserver(noteWindowRef, (entries) => {
    const entry = entries[0];
    if (!entry || isDragging.value) {
        return;
    }
    const measuredSize = measureObservedWindowSize(entry);
    const nextSize = clampSize(measuredSize.width, measuredSize.height);
    if (nextSize.width === width.value && nextSize.height === height.value) {
        return;
    }
    width.value = nextSize.width;
    height.value = nextSize.height;
    const clampedPosition = clampPosition(offsetX.value, offsetY.value, nextSize.width, nextSize.height);
    offsetX.value = clampedPosition.x;
    offsetY.value = clampedPosition.y;
    emitPositionUpdate();
}, { box: 'border-box' });

useResizeObserver(boundsRootElement, () => {
    handleViewportResize();
});

useResizeObserver(documentElement, () => {
    handleViewportResize();
});

onMounted(() => {
    if (syncPosition(position)) {
        emitPositionUpdate();
    }
    void focusTextInput();
    startFocusGuard();
});

onBeforeUnmount(() => {
    clearFocusGuard();
    focusGuardToken += 1;
    stopDrag();
});

watch(
    () => position,
    (nextPosition) => {
        if (isDragging.value) {
            return;
        }
        if (syncPosition(nextPosition)) {
            emitPositionUpdate();
        }
    },
);

watch(
    () => comment.stableKey,
    () => {
        if (syncPosition(position)) {
            emitPositionUpdate();
        }
        void focusTextInput();
        startFocusGuard();
    },
);

watch(
    () => zIndex,
    (nextZIndex, previousZIndex) => {
        if (nextZIndex === previousZIndex) {
            return;
        }
        if (focusGuardTimer !== null) {
            void focusTextInput();
        }
    },
);

watch(
    () => boundsRoot,
    () => {
        handleViewportResize();
    },
);
</script>

<style scoped>
.note-window {
    --note-bg: var(--app-pdf-note-bg);
    --note-border: var(--app-pdf-note-border);
    --note-title-bg: var(--app-pdf-note-title-bg);
    --note-title-border: var(--app-pdf-note-title-border);
    --note-text: var(--app-pdf-note-text);
    --note-text-heading: var(--app-pdf-note-text-heading);
    --note-text-secondary: var(--app-pdf-note-text-secondary);
    --note-text-dim: var(--app-pdf-note-text-dim);
    --note-text-status: var(--app-pdf-note-text-status);
    --note-btn-border: var(--app-pdf-note-button-border);
    --note-btn-bg: var(--app-pdf-note-button-bg);
    --note-btn-color: var(--app-pdf-note-button-fg);
    --note-delete-border: var(--app-pdf-note-delete-border);
    --note-delete-bg: var(--app-pdf-note-delete-bg);
    --note-delete-color: var(--app-pdf-note-delete-fg);
    --note-shadow: var(--app-pdf-note-shadow);

    position: fixed;
    z-index: 55;
    width: min(380px, calc(100vw - 18px));
    height: min(360px, calc(100vh - 18px));
    min-width: 260px;
    min-height: 240px;
    border: 1px solid var(--note-border);
    background: var(--note-bg);
    box-shadow: var(--note-shadow);
    display: grid;
    grid-template-rows: auto 1fr auto auto;
    resize: both;
    overflow: hidden;
}

.note-window__title {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
    border-bottom: 1px solid var(--note-title-border);
    padding: 0.4rem 0.5rem 0.35rem;
    cursor: move;
    user-select: none;
    background: var(--note-title-bg);
}

.note-window__title-main {
    min-width: 0;
    display: grid;
    gap: 0.12rem;
}

.note-window__summary {
    font-size: 0.98rem;
    color: var(--note-text-heading);
    line-height: 1.25;
}

.note-window__meta {
    font-size: 0.88rem;
    color: var(--note-text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.note-window__title-side {
    display: grid;
    justify-items: end;
    gap: 0.18rem;
}

.note-window__actions {
    display: inline-flex;
    align-items: center;
    gap: 0.28rem;
}

.note-window__date {
    font-size: 0.86rem;
    color: var(--note-text-dim);
    white-space: nowrap;
}

.note-window__close {
    border: 1px solid var(--note-btn-border);
    background: var(--note-btn-bg);
    color: var(--note-btn-color);
    width: 1.45rem;
    height: 1.45rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.note-window__delete {
    border: 1px solid var(--note-delete-border);
    background: var(--note-delete-bg);
    color: var(--note-delete-color);
    width: 1.45rem;
    height: 1.45rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
}

.note-window__textarea {
    width: 100%;
    min-height: 100%;
    border: none;
    background: transparent;
    color: var(--note-text);
    line-height: 1.45;
    font-size: 1.02rem;
    resize: none;
    outline: none;
    padding: 0.52rem;
}

.note-window__status {
    margin: 0;
    font-size: 0.68rem;
    color: var(--note-text-status);
    padding: 0 0.52rem 0.3rem;
}

.note-window__error {
    margin: 0;
    font-size: 0.7rem;
    color: var(--note-delete-color);
    padding: 0 0.52rem 0.35rem;
}
</style>
