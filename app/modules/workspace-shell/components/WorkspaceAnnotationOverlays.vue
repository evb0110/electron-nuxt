<template>
    <div v-show="visible" class="workspace-annotation-overlays-root">
    <PdfAnnotationNoteWindow
        v-for="note in visibleAnnotationNoteWindows"
        :key="note.annotationId"
        :annotation-id="note.annotationId"
        :page-number="note.pageNumber"
        :author="note.author"
        :created-at="note.createdAt"
        :modified-at="note.modifiedAt"
        :text="note.draftText"
        :saving="note.saving"
        :error="note.error"
        :position="annotationNotePositions[note.annotationId] ?? null"
        :z-index="NOTE_WINDOW.ACTIVE_Z_INDEX_BASE + Math.min(
            Math.max(0, note.order),
            NOTE_WINDOW.ACTIVE_Z_INDEX_SLOTS - 1,
        )"
        :bounds-root="annotationViewportRoot ?? null"
        @update:text="handleNoteTextUpdate(note.annotationId, $event)"
        @update:position="handleNotePositionUpdate(note.annotationId, $event)"
        @minimize="handleMinimizeNote(note.annotationId)"
        @delete="handleDeleteAnnotation(note.annotationId)"
        @focus="handleFocusNote(note.annotationId)"
    />
    <template
        v-for="note in anchoredAnnotationNoteWindows"
        :key="`anchor-${note.annotationId}`"
    >
        <Teleport
            v-if="minimizedIndicatorTargets[note.annotationId]"
            :to="minimizedIndicatorTargets[note.annotationId]"
        >
            <AppTooltip
                :text="getMinimizedNotePreview(note)"
                :delay-duration="250"
                :disabled="isMarkerDragTooltipSuppressed"
                v-bind="isMarkerDragTooltipSuppressed ? {open: false} : {}"
            >
                <button
                    type="button"
                    class="pdf-note-minimized-indicator"
                    :style="getMinimizedIndicatorStyle(note)"
                    :aria-label="t('annotations.openNote')"
                    @mousedown.prevent
                    @mouseenter="handleAnchorPointerEvent('mouseenter', note)"
                    @mouseleave="handleAnchorPointerEvent('mouseleave', note)"
                    @focus="handleAnchorPointerEvent('focus', note)"
                    @blur="handleAnchorPointerEvent('blur', note)"
                    @click="handleAnchorClick(note)"
                >
                    <UIcon name="i-ph-chat" class="size-2.5" />
                </button>
            </AppTooltip>
        </Teleport>
    </template>
    <template
        v-for="note in openNoteAnchors"
        :key="`open-anchor-${note.annotationId}`"
    >
        <Teleport
            v-if="openNoteAnchorTargets[note.annotationId]"
            :to="openNoteAnchorTargets[note.annotationId]"
        >
            <button
                v-show="!openAnchorHiddenKeys.has(note.annotationId)"
                type="button"
                class="pdf-note-open-anchor"
                :style="getMinimizedIndicatorStyle(note)"
                :data-annotation-id="note.annotationId"
                :aria-label="t('annotations.openNote')"
                @mousedown.prevent
            >
                <UIcon name="i-ph-chat" class="size-2.5" />
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
            :key="`connector-halo-${line.annotationId}`"
            :d="line.path"
            class="pdf-note-connector-halo"
        />
        <path
            v-for="line in connectorLines"
            :key="`connector-${line.annotationId}`"
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
        :can-insert-image="annotationContextMenuCanInsertImage"
        :annotation-label="contextMenuAnnotationLabel"
        :delete-label="contextMenuDeleteActionLabel"
        :is-image-comment="annotationContextMenuIsImage"
        @open-note="handleContextOpenNote"
        @copy-text="handleContextCopyText"
        @copy-selection-text="handleContextCopySelectionText"
        @delete="handleContextDelete"
        @update-color="handleContextUpdateColor"
        @markup="handleContextMarkup"
        @create-free-note="handleContextCreateFreeNote"
        @create-selection-note="handleContextCreateSelectionNote"
        @insert-image-from-file="handleContextInsertImageFromFile"
        @paste-image-from-clipboard="handleContextPasteImageFromClipboard"
    />
    <PdfPageContextMenu
        :menu="pageContextMenu"
        :style="pageContextMenuStyle"
        :is-operation-in-progress="isPageOperationInProgress"
        :is-djvu-mode="isDjvuMode"
        @delete-pages="handlePageDelete"
        @extract-pages="handlePageExtract"
        @export-pages="handlePageExport"
        @rotate-cw="handlePageRotateCw"
        @rotate-ccw="handlePageRotateCcw"
        @insert-before="handlePageInsertBefore"
        @insert-after="handlePageInsertAfter"
        @select-all="handlePageSelectAll"
        @invert-selection="handlePageInvertSelection"
    />
    <PdfAnnotationProperties
        :shape="selectedShapeForProperties"
        :x="shapePropertiesX"
        :y="shapePropertiesY"
        @update="handleShapeUpdate"
        @close="handleShapeClose"
        @delete="handleShapeDelete"
    />
    <PdfTextMarkupAnnotationProperties
        :markup="selectedTextMarkupForProperties"
        :x="textMarkupPropertiesX"
        :y="textMarkupPropertiesY"
        @update-color="handleTextMarkupColorUpdate"
        @close="handleTextMarkupClose"
    />
    </div>
</template>

<script setup lang="ts">
import { PdfAnnotationContextMenu } from '@app/modules/pdf-viewer/public/component-exports/pdfAnnotationContextMenu';
import { PdfAnnotationNoteWindow } from '@app/modules/pdf-viewer/public/component-exports/pdfAnnotationNoteWindow';
import { PdfAnnotationProperties } from '@app/modules/pdf-viewer/public/component-exports/pdfAnnotationProperties';
import { PdfPageContextMenu } from '@app/modules/pdf-viewer/public/component-exports/pdfPageContextMenu';
import { PdfTextMarkupAnnotationProperties } from '@app/modules/pdf-viewer/public/component-exports/pdfTextMarkupAnnotationProperties';
import type {
    IAnnotationContextMenuState,
    IPageContextMenuState,
} from '@app/types/pdfContextMenu';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    ITextMarkupAnnotationProperties,
    TAnnotationTool,
    TShapeAnnotationPatch,
} from '@app/types/annotations';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import {
    normalizeMarkerRect,
    escapeCssAttr,
} from '@app/modules/pdf-viewer/public';
import type { IAnnotationNotePosition } from '@app/types/annotationNoteWindow';
import {
    NOTE_WINDOW,
    resolveNoteWindowAnchorZIndex,
} from '@app/constants/pdfLayout';
import { BrowserLogger } from '@app/utils/browserLogger';
import { clamp } from 'es-toolkit/math';
import {
    useEventListener,
    useMutationObserver,
} from '@vueuse/core';
import { createRafBurstScheduler } from '@app/modules/workspace-shell/scheduling/createRafBurstScheduler';

const INLINE_NOTE_SUBTYPES = new Set([
    'text',
    'note-linked',
    'note-inline',
]);
const FREE_TEXT_NOTE_SUBTYPES = new Set([
    'freetext',
    'typewriter',
]);

interface IAnnotationNoteWindowEntry {
    annotationId: string;
    pageIndex: number;
    pageNumber: number;
    author: string | null;
    createdAt: number | null;
    modifiedAt: number | null;
    markerRect: IAnnotationCommentSummary['markerRect'];
    subtype: string | null;
    source: IAnnotationCommentSummary['source'];
    hasNote: boolean;
    draftText: string;
    saving: boolean;
    error: string | null;
    order: number;
    isMinimized: boolean;
}
const {
    annotationNotePositions,
    annotationViewportRoot = undefined,
    annotationZoom = undefined,
    sortedAnnotationNoteWindows,
    visible,
} = defineProps<{
    visible: boolean;
    sortedAnnotationNoteWindows: IAnnotationNoteWindowEntry[];
    annotationNotePositions: Record<string, IAnnotationNotePosition>;
    annotationViewportRoot?: HTMLElement | null;
    annotationZoom?: number;
    annotationContextMenu: IAnnotationContextMenuState;
    annotationContextMenuStyle: Record<string, string>;
    annotationContextMenuCanCopy: boolean;
    annotationContextMenuCanCopySelection: boolean;
    annotationContextMenuCanCreateFree: boolean;
    annotationContextMenuCanInsertImage: boolean;
    contextMenuAnnotationLabel: string;
    contextMenuDeleteActionLabel: string;
    annotationContextMenuIsImage: boolean;
    pageContextMenu: IPageContextMenuState;
    pageContextMenuStyle: Record<string, string>;
    isPageOperationInProgress: boolean;
    isDjvuMode: boolean;
    selectedShapeForProperties: IShapeAnnotation | null;
    shapePropertiesX: number;
    shapePropertiesY: number;
    selectedTextMarkupForProperties: ITextMarkupAnnotationProperties | null;
    textMarkupPropertiesX: number;
    textMarkupPropertiesY: number;
}>();

const { t } = useTypedI18n();

const visibleAnnotationNoteWindows = computed(() =>
    sortedAnnotationNoteWindows.filter((note) => !note.isMinimized),
);
const openNoteAnchors = computed(() => {
    return visibleAnnotationNoteWindows.value.filter((note) =>
        isFloatingIndicatorEligible(note)
        && Boolean(getNoteMarkerRect(note)),
    );
});
const viewportDomSnapshot = computed<IViewportDomSnapshot | null>(() => {
    void indicatorDomTick.value;
    return collectViewportDomSnapshot(annotationViewportRoot);
});
const renderedInlineAnchorIdentity = computed<IInlineTriggerIdentity>(() =>
    collectRenderedInlineAnchorIdentity(viewportDomSnapshot.value));
const openAnchorHiddenKeys = computed<Set<string>>(() => {
    const hidden = new Set<string>();
    for (const note of openNoteAnchors.value) {
        if (inlineIdentityMatchesNote(renderedInlineAnchorIdentity.value, note)) {
            hidden.add(note.annotationId);
        }
    }
    return hidden;
});
const anchoredAnnotationNoteWindows = computed(() => {
    return sortedAnnotationNoteWindows.filter((note) => (
        note.isMinimized
        && isFloatingIndicatorEligible(note)
        && Boolean(getNoteMarkerRect(note))
        && !inlineIdentityMatchesNote(renderedInlineAnchorIdentity.value, note)
    ));
});
const indicatorDomTick = ref(0);
const annotationViewportRootElement = computed(() => annotationViewportRoot ?? null);

function logAnchor(message: string, payload: Record<string, unknown> | (() => Record<string, unknown>)) {
    BrowserLogger.debug('note-anchor', message, payload);
}

function refreshIndicatorDom() {
    indicatorDomTick.value += 1;
}

interface IInlineTriggerIdentity {
    annotationIds: Set<string>;
    markerPoints: Array<{
        pageNumber: number;
        x: number;
        y: number;
    }>;
}

interface IViewportDomSnapshot { pageContainers: Map<number, HTMLElement> }

function isInlineNoteSubtype(subtype: string) {
    return INLINE_NOTE_SUBTYPES.has(subtype);
}

function isFreeTextNoteSubtype(subtype: string) {
    return FREE_TEXT_NOTE_SUBTYPES.has(subtype);
}

function resolveKnownFloatingEligibility(note: IAnnotationNoteWindowEntry, subtype: string) {
    if (isTextMarkupSubtype(note.subtype) && note.hasNote) {
        return true;
    }
    if (isInlineNoteSubtype(subtype)) {
        return note.hasNote;
    }
    if (isFreeTextNoteSubtype(subtype)) {
        return true;
    }
    return null;
}

function isFloatingIndicatorEligible(note: IAnnotationNoteWindowEntry) {
    const subtype = (note.subtype ?? '').trim().toLowerCase();
    if (subtype === 'link') {
        return false;
    }
    const knownEligibility = resolveKnownFloatingEligibility(note, subtype);
    if (knownEligibility !== null) {
        return knownEligibility;
    }
    return note.source === 'editor';
}

function collectViewportDomSnapshot(viewportRoot: HTMLElement | null | undefined): IViewportDomSnapshot | null {
    if (!viewportRoot) {
        return null;
    }

    const pageContainers = new Map<number, HTMLElement>();
    viewportRoot.querySelectorAll<HTMLElement>('.page_container').forEach((pageContainer) => {
        const pageNumberRaw = Number(pageContainer.dataset.page ?? '');
        if (!Number.isFinite(pageNumberRaw) || pageNumberRaw <= 0) {
            return;
        }
        pageContainers.set(pageNumberRaw, pageContainer);
    });

    return { pageContainers };
}

function createEmptyInlineTriggerIdentity(): IInlineTriggerIdentity {
    return {
        annotationIds: new Set<string>(),
        markerPoints: [],
    };
}

function collectRenderedInlineAnchorIdentity(snapshot: IViewportDomSnapshot | null): IInlineTriggerIdentity {
    const identity = createEmptyInlineTriggerIdentity();
    if (!snapshot) {
        return identity;
    }

    snapshot.pageContainers.forEach((pageContainer, pageNumber) => {
        const pageRect = pageContainer.getBoundingClientRect();
        pageContainer
            .querySelectorAll<HTMLElement>('.pdf-comment-marker-button[data-annotation-id]')
            .forEach((markerElement) => {
                const annotationId = markerElement.dataset.annotationId;
                if (annotationId) {
                    identity.annotationIds.add(annotationId);
                }

                const markerRect = markerElement.getBoundingClientRect();
                if (
                    pageRect.width <= 0
                    || pageRect.height <= 0
                    || markerRect.width <= 0
                    || markerRect.height <= 0
                ) {
                    return;
                }

                identity.markerPoints.push({
                    pageNumber,
                    x: clamp((markerRect.left + markerRect.width / 2 - pageRect.left) / pageRect.width, 0, 1),
                    y: clamp((markerRect.top + markerRect.height / 2 - pageRect.top) / pageRect.height, 0, 1),
                });
            });
    });

    return identity;
}

function identityHasDirectMatch(
    inlineIdentity: IInlineTriggerIdentity,
    note: IAnnotationNoteWindowEntry,
) {
    return inlineIdentity.annotationIds.has(note.annotationId);
}

function hasNearbyInlineMarker(
    inlineIdentity: IInlineTriggerIdentity,
    note: IAnnotationNoteWindowEntry,
) {
    const markerRect = getNoteMarkerRect(note);
    if (!markerRect) {
        return false;
    }
    const noteAnchorX = clamp(markerRect.left + markerRect.width, 0, 1);
    const noteAnchorY = clamp(markerRect.top, 0, 1);
    return inlineIdentity.markerPoints.some((point) => (
        point.pageNumber === note.pageNumber
        && Math.hypot(point.x - noteAnchorX, point.y - noteAnchorY) <= 0.08
    ));
}

function inlineIdentityMatchesNote(
    inlineIdentity: IInlineTriggerIdentity,
    note: IAnnotationNoteWindowEntry,
) {
    return (
        identityHasDirectMatch(inlineIdentity, note)
        || hasNearbyInlineMarker(inlineIdentity, note)
    );
}

const minimizedIndicatorTargets = computed<Record<string, HTMLElement>>(() => {
    void indicatorDomTick.value;
    return mapAnnotationNotesToPageTargets(anchoredAnnotationNoteWindows.value);
});

const openNoteAnchorTargets = computed<Record<string, HTMLElement>>(() => {
    void indicatorDomTick.value;
    return mapAnnotationNotesToPageTargets(openNoteAnchors.value);
});

type TAnnotationNotePageTargetSource = typeof anchoredAnnotationNoteWindows.value[number];

function mapAnnotationNotesToPageTargets(notes: TAnnotationNotePageTargetSource[]) {
    const snapshot = viewportDomSnapshot.value;
    if (!snapshot) {
        return {};
    }
    const targets: Record<string, HTMLElement> = {};
    notes.forEach((note) => {
        const pageContainer = snapshot.pageContainers.get(note.pageNumber);
        if (pageContainer) {
            targets[note.annotationId] = pageContainer;
        }
    });
    return targets;
}

interface IConnectorLine {
    annotationId: string;
    path: string;
}

interface IConnectorMarkerPoint {
    cx: number;
    cy: number;
    radius: number;
}

interface INoteViewportRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

const connectorLines = shallowRef<IConnectorLine[]>([]);
const isMarkerDragTooltipSuppressed = ref(false);
let markerDragTooltipReleaseTimer: ReturnType<typeof setTimeout> | null = null;

function getMarkerPointFromElement(markerElement: HTMLElement): IConnectorMarkerPoint | null {
    const markerRect = markerElement.getBoundingClientRect();
    if (markerRect.width <= 0 || markerRect.height <= 0) {
        return null;
    }
    const viewportBounds = getConnectorViewportBounds();
    if (!rectsIntersect(markerRect, viewportBounds)) {
        return null;
    }
    return {
        cx: markerRect.left + markerRect.width / 2,
        cy: markerRect.top + markerRect.height / 2,
        radius: Math.min(markerRect.width, markerRect.height) / 2,
    };
}

function getRenderedMarkerCenter(pageContainer: HTMLElement, annotationId: string) {
    const escapedId = escapeCssAttr(annotationId);
    const markerSelectors = [
        `.pdf-comment-marker-button[data-annotation-id="${escapedId}"]`,
        `.pdf-note-open-anchor[data-annotation-id="${escapedId}"]`,
    ];

    for (const selector of markerSelectors) {
        for (const markerElement of pageContainer.querySelectorAll<HTMLElement>(selector)) {
            const point = getMarkerPointFromElement(markerElement);
            if (point) {
                return point;
            }
        }
    }

    return null;
}

function getMarkerAnchorInPage(pageContainer: HTMLElement, note: IAnnotationNoteWindowEntry) {
    const markerRect = getNoteMarkerRect(note);
    if (!markerRect) {
        return null;
    }
    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }
    const viewportBounds = getConnectorViewportBounds();
    if (!rectsIntersect(pageRect, viewportBounds)) {
        return null;
    }
    const anchorX = clamp(markerRect.left + markerRect.width, 0, 1);
    const anchorY = clamp(markerRect.top, 0, 1);
    const cx = pageRect.left + (anchorX * pageRect.width);
    const cy = pageRect.top + (anchorY * pageRect.height);
    if (!pointInRect(cx, cy, viewportBounds)) {
        return null;
    }
    return {
        cx,
        cy,
        radius: 0,
    };
}

function getConnectorViewportBounds() {
    const rootRect = annotationViewportRoot?.getBoundingClientRect() ?? null;
    if (rootRect && rootRect.width > 0 && rootRect.height > 0) {
        return rootRect;
    }
    return {
        left: 0,
        top: 0,
        right: typeof window === 'undefined' ? 0 : window.innerWidth,
        bottom: typeof window === 'undefined' ? 0 : window.innerHeight,
    };
}

function rectsIntersect(
    rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>,
    bounds: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>,
) {
    return (
        rect.right >= bounds.left
        && rect.left <= bounds.right
        && rect.bottom >= bounds.top
        && rect.top <= bounds.bottom
    );
}

function pointInRect(
    x: number,
    y: number,
    rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>,
) {
    return (
        x >= rect.left
        && x <= rect.right
        && y >= rect.top
        && y <= rect.bottom
    );
}

function getMarkerCenter(
    note: IAnnotationNoteWindowEntry,
    snapshot: IViewportDomSnapshot,
): IConnectorMarkerPoint | null {
    const pageContainer = snapshot.pageContainers.get(note.pageNumber) ?? null;
    if (!pageContainer) {
        return null;
    }

    return getRenderedMarkerCenter(pageContainer, note.annotationId)
        ?? getMarkerAnchorInPage(pageContainer, note);
}

function getRenderedNoteRect(annotationId: string): INoteViewportRect | null {
    if (typeof document === 'undefined') {
        return null;
    }
    const escapedId = escapeCssAttr(annotationId);
    const noteElement = document.querySelector<HTMLElement>(
        `.note-window[data-annotation-id="${escapedId}"]`,
    );
    const rect = noteElement?.getBoundingClientRect() ?? null;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
    };
}

function getStoredNoteRect(position: IAnnotationNotePosition) {
    return {
        left: position.x,
        top: position.y,
        width: position.width ?? NOTE_WINDOW.DEFAULT_WIDTH,
        height: position.height ?? NOTE_WINDOW.DEFAULT_HEIGHT,
    };
}

function getNoteViewportRect(
    annotationId: string,
    position: IAnnotationNotePosition,
) {
    return getRenderedNoteRect(annotationId) ?? getStoredNoteRect(position);
}

function getNoteConnectorAnchor(
    noteRect: INoteViewportRect,
    marker: IConnectorMarkerPoint,
) {
    const left = noteRect.left;
    const top = noteRect.top;
    const right = left + noteRect.width;
    const bottom = top + noteRect.height;
    const centerX = left + noteRect.width / 2;
    const centerY = top + noteRect.height / 2;
    const dx = marker.cx - centerX;
    const dy = marker.cy - centerY;
    if (dx === 0 && dy === 0) {
        return {
            x: centerX,
            y: top,
        };
    }

    const halfWidth = noteRect.width / 2;
    const halfHeight = noteRect.height / 2;
    const scaleToVerticalEdge = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
    const scaleToHorizontalEdge = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
    const hitsVerticalEdge = scaleToVerticalEdge < scaleToHorizontalEdge;
    if (hitsVerticalEdge) {
        const edgeX = dx < 0 ? left : right;
        return {
            x: edgeX,
            y: clamp(centerY + dy * scaleToVerticalEdge, top + NOTE_WINDOW.MARGIN, bottom - NOTE_WINDOW.MARGIN),
        };
    }

    const edgeY = dy < 0 ? top : bottom;
    return {
        x: clamp(centerX + dx * scaleToHorizontalEdge, left + NOTE_WINDOW.MARGIN, right - NOTE_WINDOW.MARGIN),
        y: edgeY,
    };
}

function getConnectorStart(
    marker: IConnectorMarkerPoint,
    noteAnchor: {
        x: number;
        y: number;
    },
) {
    if (marker.radius <= 0) {
        return {
            x: marker.cx,
            y: marker.cy,
        };
    }
    const dx = noteAnchor.x - marker.cx;
    const dy = noteAnchor.y - marker.cy;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0) {
        return {
            x: marker.cx,
            y: marker.cy,
        };
    }
    const offset = Math.min(marker.radius, distance / 2);
    return {
        x: marker.cx + (dx / distance) * offset,
        y: marker.cy + (dy / distance) * offset,
    };
}

function computeConnectorLines(): IConnectorLine[] {
    const snapshot = viewportDomSnapshot.value;
    if (!snapshot) {
        return [];
    }
    const lines: IConnectorLine[] = [];
    for (const note of openNoteAnchors.value) {
        const {annotationId} = note;
        const position = annotationNotePositions[note.annotationId];
        if (!position) {
            continue;
        }

        const marker = getMarkerCenter(note, snapshot);
        if (!marker) {
            continue;
        }

        const noteRect = getNoteViewportRect(note.annotationId, position);
        const noteAnchor = getNoteConnectorAnchor(noteRect, marker);
        const markerStart = getConnectorStart(marker, noteAnchor);

        lines.push({
            annotationId,
            path: `M ${markerStart.x} ${markerStart.y} L ${noteAnchor.x} ${noteAnchor.y}`,
        });
    }
    return lines;
}

function getNoteMarkerRect(note: IAnnotationNoteWindowEntry) {
    return normalizeMarkerRect(note.markerRect);
}

function getNoteRenderSignature(note: IAnnotationNoteWindowEntry) {
    const rect = getNoteMarkerRect(note);
    return [
        note.annotationId,
        note.pageNumber,
        rect?.left ?? '',
        rect?.top ?? '',
        rect?.width ?? '',
        rect?.height ?? '',
    ].join(':');
}

function getNotePositionSignature() {
    return Object.entries(annotationNotePositions)
        .map(([
            annotationId,
            position,
        ]) => [
            annotationId,
            position.x,
            position.y,
            position.width ?? '',
            position.height ?? '',
        ].join(':'))
        .sort();
}

function getMinimizedIndicatorStyle(note: IAnnotationNoteWindowEntry) {
    void annotationZoom;

    const markerRect = getNoteMarkerRect(note);
    if (!markerRect) {
        return {display: 'none'};
    }
    const leftPercent = clamp((markerRect.left + markerRect.width) * 100, 1, 99);
    const topPercent = clamp(markerRect.top * 100, 1, 99);

    return {
        left: `${leftPercent}%`,
        top: `${topPercent}%`,
        zIndex: String(resolveNoteWindowAnchorZIndex(note.order)),
    };
}

function getMinimizedNotePreview(note: IAnnotationNoteWindowEntry) {
    const text = note.draftText.trim();
    if (!text) {
        return t('annotations.emptyNote');
    }
    if (text.length <= 180) {
        return text;
    }
    return `${text.slice(0, 177)}...`;
}

function handleAnchorPointerEvent(
    eventName: 'mouseenter' | 'mouseleave' | 'focus' | 'blur',
    note: IAnnotationNoteWindowEntry,
) {
    if (eventName !== 'focus') {
        return;
    }
    logAnchor('anchor pointer event', () => ({
        eventName,
        annotationId: note.annotationId,
        pageNumber: note.pageNumber,
        markerRect: getNoteMarkerRect(note),
        preview: getMinimizedNotePreview(note),
        isMinimized: note.isMinimized,
    }));
}

function handleAnchorClick(note: IAnnotationNoteWindowEntry) {
    logAnchor('anchor clicked', () => ({
        annotationId: note.annotationId,
        pageNumber: note.pageNumber,
        markerRect: getNoteMarkerRect(note),
        isMinimized: note.isMinimized,
    }));
    emit('restore-note', note.annotationId);
}

function handleNoteTextUpdate(annotationId: string, text: string) {
    emit('update-note-text', annotationId, text);
}

function handleNotePositionUpdate(annotationId: string, position: IAnnotationNotePosition) {
    emit('update-note-position', annotationId, position);
    scheduleConnectorRefreshBurst(2);
}

function handleMinimizeNote(annotationId: string) {
    emit('minimize-note', annotationId);
}

function handleDeleteAnnotation(annotationId: string) {
    emit('delete-annotation', annotationId);
}

function handleFocusNote(annotationId: string) {
    emit('focus-note', annotationId);
}

function handleContextOpenNote() {
    emit('context-open-note');
}

function handleContextCopyText() {
    emit('context-copy-text');
}

function handleContextCopySelectionText() {
    emit('context-copy-selection-text');
}

function handleContextDelete() {
    emit('context-delete');
}

function handleContextUpdateColor(color: string) {
    emit('context-update-color', color);
}

function handleContextMarkup(tool: TAnnotationTool) {
    emit('context-markup', tool);
}

function handleContextCreateFreeNote() {
    emit('context-create-free-note');
}

function handleContextCreateSelectionNote() {
    emit('context-create-selection-note');
}

function handleContextInsertImageFromFile() {
    emit('context-insert-image-from-file');
}

function handleContextPasteImageFromClipboard() {
    emit('context-paste-image-from-clipboard');
}

function handlePageDelete() {
    emit('page-delete');
}

function handlePageExtract() {
    emit('page-extract');
}

function handlePageExport() {
    emit('page-export');
}

function handlePageRotateCw() {
    emit('page-rotate-cw');
}

function handlePageRotateCcw() {
    emit('page-rotate-ccw');
}

function handlePageInsertBefore() {
    emit('page-insert-before');
}

function handlePageInsertAfter() {
    emit('page-insert-after');
}

function handlePageSelectAll() {
    emit('page-select-all');
}

function handlePageInvertSelection() {
    emit('page-invert-selection');
}

function handleShapeUpdate(updates: TShapeAnnotationPatch) {
    emit('shape-update', updates);
}

function handleShapeClose() {
    emit('shape-close');
}

function handleShapeDelete() {
    emit('shape-delete');
}

function handleTextMarkupColorUpdate(color: string) {
    emit('text-markup-color-update', color);
}

function handleTextMarkupClose() {
    emit('text-markup-close');
}

const indicatorDomRefreshScheduler = createRafBurstScheduler(() => {
    refreshIndicatorDom();
    connectorLines.value = computeConnectorLines();
});

const connectorRefreshScheduler = createRafBurstScheduler(() => {
    connectorLines.value = computeConnectorLines();
});

function scheduleOverlayRefreshBurst(frames = 6) {
    indicatorDomRefreshScheduler.request(frames);
}

function scheduleConnectorRefreshFrame() {
    connectorRefreshScheduler.request(1);
}

function scheduleConnectorRefreshBurst(frames = 2) {
    connectorRefreshScheduler.request(frames);
}

function scheduleViewportMutationRefresh() {
    scheduleOverlayRefreshBurst(4);
}

function clearMarkerDragTooltipReleaseTimer() {
    if (markerDragTooltipReleaseTimer !== null) {
        clearTimeout(markerDragTooltipReleaseTimer);
        markerDragTooltipReleaseTimer = null;
    }
}

function setMarkerDragTooltipSuppressed(active: boolean) {
    if (active) {
        clearMarkerDragTooltipReleaseTimer();
        isMarkerDragTooltipSuppressed.value = true;
        return;
    }

    clearMarkerDragTooltipReleaseTimer();
    markerDragTooltipReleaseTimer = setTimeout(() => {
        markerDragTooltipReleaseTimer = null;
        isMarkerDragTooltipSuppressed.value = false;
    }, 80);
}

function handleMarkerDragFrame() {
    setMarkerDragTooltipSuppressed(true);
    scheduleConnectorRefreshFrame();
}

function handleMarkerDragState(event: Event) {
    const detail = event instanceof CustomEvent && typeof event.detail === 'object' && event.detail !== null
        ? event.detail as { active?: unknown }
        : null;
    const active = detail?.active === true;
    setMarkerDragTooltipSuppressed(active);
}

onMounted(() => {
    scheduleOverlayRefreshBurst(10);
});

onBeforeUnmount(() => {
    clearMarkerDragTooltipReleaseTimer();
    indicatorDomRefreshScheduler.cancel();
    connectorRefreshScheduler.cancel();
    connectorLines.value = [];
});

useEventListener(
    annotationViewportRootElement,
    'scroll',
    scheduleConnectorRefreshFrame,
    { passive: true },
);

useEventListener(
    import.meta.client ? window : undefined,
    'resize',
    scheduleConnectorRefreshFrame,
    { passive: true },
);

useEventListener(
    import.meta.client ? window : undefined,
    'pdf-comment-marker-drag',
    handleMarkerDragFrame,
);

useEventListener(
    import.meta.client ? window : undefined,
    'pdf-comment-marker-drag-state',
    handleMarkerDragState,
);

useMutationObserver(
    annotationViewportRootElement,
    scheduleViewportMutationRefresh,
    {
        childList: true,
        subtree: true,
    },
);

watch(
    () => annotationViewportRoot,
    () => {
        scheduleOverlayRefreshBurst(12);
    },
);

watch(
    () => annotationZoom,
    () => {
        scheduleConnectorRefreshFrame();
    },
);

watch(
    () => anchoredAnnotationNoteWindows.value.map(getNoteRenderSignature),
    () => {
        scheduleOverlayRefreshBurst(6);
    },
);

watch(
    () => visibleAnnotationNoteWindows.value.map(getNoteRenderSignature),
    () => {
        scheduleOverlayRefreshBurst(6);
    },
);

watch(
    getNotePositionSignature,
    () => {
        scheduleConnectorRefreshFrame();
    },
);

const emit = defineEmits<{
    'update-note-text': [annotationId: string, text: string];
    'update-note-position': [annotationId: string, position: IAnnotationNotePosition];
    'minimize-note': [annotationId: string];
    'restore-note': [annotationId: string];
    'delete-annotation': [annotationId: string];
    'focus-note': [annotationId: string];
    'context-open-note': [];
    'context-copy-text': [];
    'context-copy-selection-text': [];
    'context-delete': [];
    'context-update-color': [color: string];
    'context-markup': [tool: TAnnotationTool];
    'context-create-free-note': [];
    'context-create-selection-note': [];
    'context-insert-image-from-file': [];
    'context-paste-image-from-clipboard': [];
    'page-delete': [];
    'page-extract': [];
    'page-export': [];
    'page-rotate-cw': [];
    'page-rotate-ccw': [];
    'page-insert-before': [];
    'page-insert-after': [];
    'page-select-all': [];
    'page-invert-selection': [];
    'shape-update': [updates: TShapeAnnotationPatch];
    'shape-close': [];
    'shape-delete': [];
    'text-markup-color-update': [color: string];
    'text-markup-close': [];
}>();
</script>

<style scoped>
.workspace-annotation-overlays-root {
    display: contents;
}

.pdf-note-minimized-indicator {
    position: absolute;
    width: var(--app-note-anchor-size);
    height: var(--app-note-anchor-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--app-radius-full);
    border: 1px solid color-mix(in srgb, var(--ui-warning) 62%, var(--ui-border) 38%);
    background: color-mix(in srgb, var(--ui-warning) 20%, var(--ui-bg) 80%);
    color: color-mix(in srgb, var(--ui-warning) 58%, var(--ui-text) 42%);
    cursor: pointer;
    transform: translate(-50%, -50%);
    opacity: 0.82;
    transition:
        background-color var(--app-transition-standard),
        border-color var(--app-transition-standard),
        transform var(--app-transition-standard),
        opacity var(--app-transition-standard);
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
    width: var(--app-note-anchor-size);
    height: var(--app-note-anchor-size);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--app-radius-full);
    border: 1.5px solid color-mix(in srgb, var(--ui-warning) 75%, var(--ui-border) 25%);
    background: color-mix(in srgb, var(--ui-warning) 30%, var(--ui-bg) 70%);
    color: color-mix(in srgb, var(--ui-warning) 65%, var(--ui-text) 35%);
    cursor: default;
    transform: translate(-50%, -50%);
    opacity: 0.92;
    pointer-events: none;
    z-index: var(--app-note-anchor-z-index);
}

.pdf-note-connector-svg {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100vh;
    z-index: var(--app-note-connector-z-index);
    overflow: visible;
}

.pdf-note-connector-halo {
    fill: none;
    stroke: color-mix(in srgb, var(--ui-bg) 88%, var(--ui-warning) 12%);
    stroke-width: 3.5;
    stroke-linecap: round;
    stroke-dasharray: 6 4;
    opacity: 0.6;
}

.pdf-note-connector-path {
    fill: none;
    stroke: color-mix(in srgb, var(--ui-warning) 72%, var(--ui-text) 28%);
    stroke-width: 1.75;
    stroke-linecap: round;
    stroke-dasharray: 6 4;
    opacity: 0.82;
}

</style>
