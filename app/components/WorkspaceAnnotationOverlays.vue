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
        v-for="note in anchoredAnnotationNoteWindows"
        :key="`anchor-${note.comment.stableKey}`"
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
                    :title="getMinimizedNotePreview(note)"
                    @mousedown.prevent
                    @mouseenter="handleAnchorPointerEvent('mouseenter', note)"
                    @mouseleave="handleAnchorPointerEvent('mouseleave', note)"
                    @focus="handleAnchorPointerEvent('focus', note)"
                    @blur="handleAnchorPointerEvent('blur', note)"
                    @click="handleAnchorClick(note)"
                >
                    <UIcon name="i-lucide-message-square" class="size-2.5" />
                </button>
            </UTooltip>
        </Teleport>
    </template>
    <template
        v-for="note in openNoteAnchors"
        :key="`open-anchor-${note.comment.stableKey}`"
    >
        <Teleport
            v-if="openNoteAnchorTargets[note.comment.stableKey]"
            :to="openNoteAnchorTargets[note.comment.stableKey]"
        >
            <button
                type="button"
                class="pdf-note-open-anchor"
                :style="getMinimizedIndicatorStyle(note)"
                :aria-label="t('annotations.openNote')"
                @mousedown.prevent
            >
                <UIcon name="i-lucide-message-square" class="size-2.5" />
            </button>
        </Teleport>
    </template>
    <svg
        v-if="connectorLines.length > 0"
        class="pdf-note-connector-svg"
        :style="{ pointerEvents: 'none' }"
    >
        <path
            v-for="line in connectorLines"
            :key="`connector-${line.stableKey}`"
            :d="line.path"
            class="pdf-note-connector-path"
        />
    </svg>
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

import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import {
    normalizeMarkerRect,
    isTextMarkupSubtype,
} from '@app/composables/pdf/pdfAnnotationUtils';
import type { IAnnotationNotePosition } from '@app/composables/pdf/annotations/types';
import { NOTE_WINDOW } from '@app/constants/pdf-layout';
import { BrowserLogger } from '@app/utils/browser-logger';
import { clamp } from 'es-toolkit/math';

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
const openNoteAnchors = computed(() => {
    void indicatorDomTick.value;
    return visibleAnnotationNoteWindows.value.filter((note) =>
        isFloatingIndicatorEligible(note.comment)
        && Boolean(getNoteMarkerRect(note)),
    );
});
const anchoredAnnotationNoteWindows = computed(() => {
    void indicatorDomTick.value;
    const viewportRoot = props.annotationViewportRoot;
    const inlineIdentity = collectInlineTriggerIdentity(viewportRoot);
    return props.sortedAnnotationNoteWindows.filter((note) => (
        note.isMinimized
        && isFloatingIndicatorEligible(note.comment)
        && Boolean(getNoteMarkerRect(note))
        && !inlineIdentityMatchesNote(inlineIdentity, note)
    ));
});
const indicatorDomTick = ref(0);
let refreshBurstFrameId: number | null = null;
let refreshBurstFramesRemaining = 0;
let viewportMutationObserver: MutationObserver | null = null;

function logAnchor(message: string, payload: Record<string, unknown>) {
    BrowserLogger.debug('note-anchor', message, payload);
}

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

function parseStableKeysAttr(value: string | null | undefined) {
    if (!value) {
        return [];
    }
    return value
        .split('|')
        .map(entry => entry.trim())
        .filter(Boolean);
}

interface IInlineTriggerIdentity {
    stableKeys: Set<string>;
    annotationIds: Set<string>;
    uids: Set<string>;
    markerPoints: Array<{
        pageNumber: number;
        x: number;
        y: number;
    }>;
}

function parseStableKeyIdentity(stableKey: string) {
    const [
        kind,
        pagePart,
        ...rest
    ] = stableKey.split(':');
    const id = rest.join(':').trim();
    const pageIndex = Number.isFinite(Number(pagePart)) ? Number(pagePart) : null;
    return {
        kind: kind?.trim().toLowerCase() ?? '',
        id,
        pageIndex,
    };
}

function isFloatingIndicatorEligible(comment: IAnnotationCommentSummary) {
    const subtype = (comment.subtype ?? '').trim().toLowerCase();
    if (subtype === 'link') {
        return false;
    }
    if (isTextMarkupSubtype(comment.subtype) && comment.hasNote) {
        return true;
    }
    if (
        subtype === 'text'
        || subtype === 'note-linked'
        || subtype === 'note-inline'
    ) {
        return comment.hasNote;
    }
    if (subtype === 'freetext' || subtype === 'typewriter') {
        return true;
    }
    return comment.source === 'editor' && !comment.annotationId;
}

function toPageNormalizedPoint(element: HTMLElement) {
    const pageContainer = element.closest<HTMLElement>('.page_container');
    if (!pageContainer) {
        return null;
    }
    const pageNumberRaw = Number(pageContainer.dataset.page ?? '');
    if (!Number.isFinite(pageNumberRaw) || pageNumberRaw <= 0) {
        return null;
    }
    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }
    const rect = element.getBoundingClientRect();
    return {
        pageNumber: pageNumberRaw,
        x: clamp(((rect.left + (rect.width / 2)) - pageRect.left) / pageRect.width, 0, 1),
        y: clamp(((rect.top + (rect.height / 2)) - pageRect.top) / pageRect.height, 0, 1),
    };
}

function collectInlineTriggerIdentity(viewportRoot: HTMLElement | null | undefined): IInlineTriggerIdentity {
    const identity: IInlineTriggerIdentity = {
        stableKeys: new Set<string>(),
        annotationIds: new Set<string>(),
        uids: new Set<string>(),
        markerPoints: [],
    };
    if (!viewportRoot) {
        return identity;
    }

    const markers = viewportRoot.querySelectorAll<HTMLElement>(
        '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker, [data-comment-stable-keys], [data-comment-stable-key]',
    );
    markers.forEach((marker) => {
        const directStableKey = marker.dataset.commentStableKey?.trim();
        if (directStableKey) {
            identity.stableKeys.add(directStableKey);
        }
        parseStableKeysAttr(marker.getAttribute('data-comment-stable-keys')).forEach((stableKey) => {
            identity.stableKeys.add(stableKey);
        });

        const annotationId = marker.dataset.annotationId?.trim()
            ?? marker.getAttribute('data-annotation-id')?.trim()
            ?? marker.closest<HTMLElement>('[data-annotation-id]')?.getAttribute('data-annotation-id')?.trim()
            ?? '';
        if (annotationId) {
            identity.annotationIds.add(annotationId);
        }
    });

    viewportRoot.querySelectorAll<HTMLElement>(
        '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker, .annotationCommentButton, .popupTriggerArea',
    ).forEach((marker) => {
        const point = toPageNormalizedPoint(marker);
        if (point) {
            identity.markerPoints.push(point);
        }

        const fromTarget = marker.closest<HTMLElement>('[data-comment-stable-keys], [data-comment-stable-key]');
        if (fromTarget) {
            const stableKey = fromTarget.dataset.commentStableKey?.trim();
            if (stableKey) {
                identity.stableKeys.add(stableKey);
            }
            parseStableKeysAttr(fromTarget.getAttribute('data-comment-stable-keys')).forEach((nextStableKey) => {
                identity.stableKeys.add(nextStableKey);
            });
        }
    });

    identity.stableKeys.forEach((stableKey) => {
        const parsed = parseStableKeyIdentity(stableKey);
        if (!parsed.id) {
            return;
        }
        if (parsed.kind === 'ann') {
            identity.annotationIds.add(parsed.id);
            return;
        }
        if (parsed.kind === 'uid') {
            identity.uids.add(parsed.id);
        }
    });

    return identity;
}

function inlineIdentityMatchesNote(
    inlineIdentity: IInlineTriggerIdentity,
    note: IAnnotationNoteWindowEntry,
) {
    const stableKey = note.comment.stableKey;
    if (stableKey && inlineIdentity.stableKeys.has(stableKey)) {
        return true;
    }

    const annotationId = note.comment.annotationId?.trim() ?? '';
    if (annotationId && inlineIdentity.annotationIds.has(annotationId)) {
        return true;
    }

    const uid = note.comment.uid?.trim() ?? '';
    if (uid && inlineIdentity.uids.has(uid)) {
        return true;
    }

    const pageIndex = note.comment.pageIndex;
    if (annotationId && Number.isFinite(pageIndex)) {
        const annStableKey = `ann:${pageIndex}:${annotationId}`;
        if (inlineIdentity.stableKeys.has(annStableKey)) {
            return true;
        }
    }
    if (uid && Number.isFinite(pageIndex)) {
        const uidStableKey = `uid:${pageIndex}:${uid}`;
        if (inlineIdentity.stableKeys.has(uidStableKey)) {
            return true;
        }
    }

    const markerRect = getNoteMarkerRect(note);
    if (markerRect) {
        const noteAnchorX = clamp(markerRect.left + markerRect.width, 0, 1);
        const noteAnchorY = clamp(markerRect.top, 0, 1);
        const hasNearbyInlineMarker = inlineIdentity.markerPoints.some((point) => {
            if (point.pageNumber !== note.comment.pageNumber) {
                return false;
            }
            return Math.hypot(point.x - noteAnchorX, point.y - noteAnchorY) <= 0.08;
        });
        if (hasNearbyInlineMarker) {
            return true;
        }
    }

    return false;
}

const minimizedIndicatorTargets = computed<Record<string, HTMLElement>>(() => {
    void indicatorDomTick.value;
    const viewportRoot = props.annotationViewportRoot;
    if (!viewportRoot) {
        return {};
    }

    const targets: Record<string, HTMLElement> = {};
    anchoredAnnotationNoteWindows.value.forEach((note) => {
        const pageContainer = viewportRoot.querySelector<HTMLElement>(`.page_container[data-page="${note.comment.pageNumber}"]`);
        if (pageContainer) {
            targets[note.comment.stableKey] = pageContainer;
        }
    });
    return targets;
});

const openNoteAnchorTargets = computed<Record<string, HTMLElement>>(() => {
    void indicatorDomTick.value;
    const viewportRoot = props.annotationViewportRoot;
    if (!viewportRoot) {
        return {};
    }
    const targets: Record<string, HTMLElement> = {};
    openNoteAnchors.value.forEach((note) => {
        const pageContainer = viewportRoot.querySelector<HTMLElement>(`.page_container[data-page="${note.comment.pageNumber}"]`);
        if (pageContainer) {
            targets[note.comment.stableKey] = pageContainer;
        }
    });
    return targets;
});

interface IConnectorLine {
    stableKey: string;
    path: string;
}

const connectorLines = shallowRef<IConnectorLine[]>([]);
let connectorRafId: number | null = null;

function computeConnectorLines(): IConnectorLine[] {
    const targets = openNoteAnchorTargets.value;
    const lines: IConnectorLine[] = [];
    for (const note of openNoteAnchors.value) {
        const markerRect = getNoteMarkerRect(note);
        if (!markerRect) {
            continue;
        }
        const position = props.annotationNotePositions[note.comment.stableKey];
        if (!position) {
            continue;
        }

        const pageContainer = targets[note.comment.stableKey];
        if (!pageContainer) {
            continue;
        }

        const pageRect = pageContainer.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
            continue;
        }

        const markerCx = pageRect.left + ((markerRect.left + markerRect.width / 2) * pageRect.width);
        const markerCy = pageRect.top + ((markerRect.top + markerRect.height / 2) * pageRect.height);

        const noteW = position.width ?? NOTE_WINDOW.DEFAULT_WIDTH;
        const noteH = position.height ?? NOTE_WINDOW.DEFAULT_HEIGHT;
        const noteCx = position.x + noteW / 2;
        const noteCy = position.y + noteH / 2;

        lines.push({
            stableKey: note.comment.stableKey,
            path: `M ${markerCx} ${markerCy} L ${noteCx} ${noteCy}`,
        });
    }
    return lines;
}

function connectorRafLoop() {
    connectorLines.value = computeConnectorLines();
    if (openNoteAnchors.value.length > 0) {
        connectorRafId = requestAnimationFrame(connectorRafLoop);
    } else {
        connectorRafId = null;
    }
}

function startConnectorLoop() {
    if (connectorRafId !== null) {
        return;
    }
    if (openNoteAnchors.value.length > 0) {
        connectorRafId = requestAnimationFrame(connectorRafLoop);
    }
}

function stopConnectorLoop() {
    if (connectorRafId !== null) {
        cancelAnimationFrame(connectorRafId);
        connectorRafId = null;
    }
    connectorLines.value = [];
}

function getNoteMarkerRect(note: IAnnotationNoteWindowEntry) {
    return normalizeMarkerRect(note.comment.markerRect);
}

function getMinimizedIndicatorStyle(note: IAnnotationNoteWindowEntry) {
    void indicatorDomTick.value;
    void props.annotationZoom;

    const markerRect = getNoteMarkerRect(note);
    if (!markerRect) {
        return {display: 'none'};
    }
    const leftPercent = Math.max(1, Math.min(99, (markerRect.left + markerRect.width) * 100));
    const topPercent = Math.max(1, Math.min(99, markerRect.top * 100));

    return {
        left: `${leftPercent}%`,
        top: `${topPercent}%`,
        zIndex: String(25 + note.order),
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

function handleAnchorPointerEvent(
    eventName: 'mouseenter' | 'mouseleave' | 'focus' | 'blur',
    note: IAnnotationNoteWindowEntry,
) {
    if (eventName !== 'focus') {
        return;
    }
    logAnchor('anchor pointer event', {
        eventName,
        stableKey: note.comment.stableKey,
        pageNumber: note.comment.pageNumber,
        markerRect: getNoteMarkerRect(note),
        preview: getMinimizedNotePreview(note),
        isMinimized: note.isMinimized,
    });
}

function handleAnchorClick(note: IAnnotationNoteWindowEntry) {
    logAnchor('anchor clicked', {
        stableKey: note.comment.stableKey,
        pageNumber: note.comment.pageNumber,
        markerRect: getNoteMarkerRect(note),
        isMinimized: note.isMinimized,
    });
    emit('restore-note', note.comment.stableKey);
}

onMounted(() => {
    reconnectViewportObservers();
    scheduleIndicatorRefreshBurst(10);
});

onBeforeUnmount(() => {
    stopConnectorLoop();
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
    () => anchoredAnnotationNoteWindows.value.map((note) => `${note.comment.stableKey}:${note.comment.pageNumber}`),
    () => {
        scheduleIndicatorRefreshBurst(6);
    },
);

watch(
    () => visibleAnnotationNoteWindows.value.map((note) => note.comment.stableKey),
    () => {
        scheduleIndicatorRefreshBurst(6);
    },
);

watch(
    () => props.annotationNotePositions,
    () => {
        scheduleIndicatorRefreshBurst(3);
    },
);

watch(
    () => openNoteAnchors.value.length,
    (count) => {
        if (count > 0) {
            startConnectorLoop();
        } else {
            stopConnectorLoop();
        }
    },
    { immediate: true },
);

const emit = defineEmits<{
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
    width: 1.3rem;
    height: 1.3rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    border: 1px solid color-mix(in srgb, var(--ui-warning) 62%, var(--ui-border) 38%);
    background: color-mix(in srgb, var(--ui-warning) 20%, var(--ui-bg) 80%);
    color: color-mix(in srgb, var(--ui-warning) 58%, var(--ui-text) 42%);
    cursor: pointer;
    transform: translate(-50%, -50%);
    opacity: 0.82;
    transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.15s ease, opacity 0.15s ease;
}

.pdf-note-minimized-indicator:hover {
    background: color-mix(in srgb, var(--ui-warning) 30%, var(--ui-bg) 70%);
    border-color: color-mix(in srgb, var(--ui-warning) 75%, var(--ui-border) 25%);
    transform: translate(-50%, calc(-50% - 1px));
    opacity: 0.95;
}

.pdf-note-minimized-indicator:focus-visible {
    outline: 1px solid var(--ui-primary);
    outline-offset: 1px;
}

.pdf-note-open-anchor {
    position: absolute;
    width: 1.3rem;
    height: 1.3rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    border: 1.5px solid color-mix(in srgb, var(--ui-warning) 75%, var(--ui-border) 25%);
    background: color-mix(in srgb, var(--ui-warning) 30%, var(--ui-bg) 70%);
    color: color-mix(in srgb, var(--ui-warning) 65%, var(--ui-text) 35%);
    cursor: default;
    transform: translate(-50%, -50%);
    opacity: 0.92;
    pointer-events: none;
    z-index: 25;
}

.pdf-note-connector-svg {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    z-index: 8;
    overflow: visible;
}

.pdf-note-connector-path {
    fill: none;
    stroke: color-mix(in srgb, var(--ui-warning) 55%, var(--ui-border) 45%);
    stroke-width: 1.5;
    stroke-dasharray: 5 3;
    opacity: 0.65;
}

</style>
