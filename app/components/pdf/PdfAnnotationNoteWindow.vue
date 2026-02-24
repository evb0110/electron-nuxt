<template>
    <div
        ref="noteWindowRef"
        class="note-window"
        :style="windowStyle"
        @mousedown="emit('focus')"
        @focusin="emit('focus')"
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
                <span class="note-window__date">{{ timestampText }}</span>
                <div class="note-window__actions">
                    <button
                        type="button"
                        class="note-window__delete"
                        :aria-label="t('noteWindow.deleteNote')"
                        @click="emit('delete')"
                    >
                        <UIcon name="i-lucide-trash-2" class="size-3.5" />
                    </button>
                    <button
                        type="button"
                        class="note-window__close"
                        :aria-label="t('noteWindow.minimizeNote')"
                        @click="emit('minimize')"
                    >
                        <UIcon name="i-lucide-minus" class="size-3.5" />
                    </button>
                </div>
            </div>
        </header>

        <textarea
            ref="noteInputRef"
            class="note-window__textarea"
            :value="text"
            rows="8"
            :placeholder="t('noteWindow.writeNote')"
            @keydown.esc.stop.prevent="emit('minimize')"
            @input="emit('update:text', ($event.target as HTMLTextAreaElement).value)"
        ></textarea>

        <p v-if="saving" class="note-window__status" role="status" aria-live="polite">{{ t('noteWindow.saving') }}</p>
        <p v-if="error" class="note-window__error" role="alert" aria-live="assertive">{{ error }}</p>
    </div>
</template>

<script setup lang="ts">
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
} from 'vue';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { NOTE_WINDOW } from '@app/constants/pdf-layout';

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
}

const {
    comment,
    text,
    saving = false,
    error = null,
    position = null,
    zIndex = 55,
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
let resizeObserver: ResizeObserver | null = null;
let focusGuardTimer: ReturnType<typeof setTimeout> | null = null;
let focusGuardToken = 0;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
});

const { settings } = useSettings();

const title = computed(() => t('noteWindow.popUpNote', { page: comment.pageNumber }));
const authorText = computed(() => comment.author?.trim() || settings.value.authorName?.trim() || t('noteWindow.unknownAuthor'));
const timestampText = computed(() => {
    if (!comment.modifiedAt) {
        return t('noteWindow.noDate');
    }
    return timeFormatter.format(new Date(comment.modifiedAt));
});

const windowStyle = computed(() => ({
    left: `${offsetX.value}px`,
    top: `${offsetY.value}px`,
    width: `${width.value}px`,
    height: `${height.value}px`,
    zIndex: String(zIndex),
}));

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

    const tick = async () => {
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
            void tick();
        }, interval);
    };

    void tick();
}

function applyPosition(position: IAnnotationNotePosition | null) {
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
    if (typeof window === 'undefined') {
        return {
            width: Math.max(NOTE_WINDOW.MIN_WIDTH, Math.round(nextWidth)),
            height: Math.max(NOTE_WINDOW.MIN_HEIGHT, Math.round(nextHeight)),
        };
    }

    const maxWidth = Math.max(NOTE_WINDOW.MIN_WIDTH, window.innerWidth - (NOTE_WINDOW.MARGIN * 2));
    const maxHeight = Math.max(NOTE_WINDOW.MIN_HEIGHT, window.innerHeight - (NOTE_WINDOW.MARGIN * 2));

    return {
        width: Math.max(NOTE_WINDOW.MIN_WIDTH, Math.min(maxWidth, Math.round(nextWidth))),
        height: Math.max(NOTE_WINDOW.MIN_HEIGHT, Math.min(maxHeight, Math.round(nextHeight))),
    };
}

function clampPosition(x: number, y: number, nextWidth: number, nextHeight: number) {
    if (typeof window === 'undefined') {
        return {
            x,
            y,
        };
    }

    const maxX = Math.max(NOTE_WINDOW.MARGIN, window.innerWidth - nextWidth - NOTE_WINDOW.MARGIN);
    const maxY = Math.max(NOTE_WINDOW.MARGIN, window.innerHeight - nextHeight - NOTE_WINDOW.MARGIN);

    return {
        x: Math.round(Math.min(maxX, Math.max(NOTE_WINDOW.MARGIN, x))),
        y: Math.round(Math.min(maxY, Math.max(NOTE_WINDOW.MARGIN, y))),
    };
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
    window.removeEventListener('mousemove', handlePointerMove);
    window.removeEventListener('mouseup', stopDrag);
    emitPositionUpdate();
}

function startDrag(event: MouseEvent) {
    emit('focus');
    isDragging.value = true;
    dragStartX.value = event.clientX;
    dragStartY.value = event.clientY;
    frameStartX.value = offsetX.value;
    frameStartY.value = offsetY.value;

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', stopDrag);
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

onMounted(() => {
    applyPosition(position);
    if (typeof window !== 'undefined') {
        window.addEventListener('resize', handleViewportResize);
    }
    if (noteWindowRef.value && typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
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
        });
        try {
            resizeObserver.observe(noteWindowRef.value, { box: 'border-box' });
        } catch {
            resizeObserver.observe(noteWindowRef.value);
        }
    }
    void focusTextInput();
    startFocusGuard();
});

onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
        window.removeEventListener('resize', handleViewportResize);
    }
    resizeObserver?.disconnect();
    resizeObserver = null;
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
        applyPosition(nextPosition);
    },
);

watch(
    () => comment.stableKey,
    () => {
        applyPosition(position);
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
        void focusTextInput();
        startFocusGuard();
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
