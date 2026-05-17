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
        :bounds-root="annotationViewportRoot ?? null"
        @update:text="handleNoteTextUpdate(note.comment.stableKey, $event)"
        @update:position="handleNotePositionUpdate(note.comment.stableKey, $event)"
        @minimize="handleMinimizeNote(note.comment.stableKey)"
        @delete="handleDeleteComment(note.comment)"
        @focus="handleFocusNote(note.comment.stableKey)"
    />
    <template
        v-for="note in anchoredAnnotationNoteWindows"
        :key="`anchor-${note.comment.stableKey}`"
    >
        <Teleport
            v-if="minimizedIndicatorTargets[note.comment.stableKey]"
            :to="minimizedIndicatorTargets[note.comment.stableKey]"
        >
            <AppTooltip
                :text="getMinimizedNotePreview(note)"
                :delay-duration="250"
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
        :key="`open-anchor-${note.comment.stableKey}`"
    >
        <Teleport
            v-if="openNoteAnchorTargets[note.comment.stableKey]"
            :to="openNoteAnchorTargets[note.comment.stableKey]"
        >
            <button
                v-show="!openAnchorHiddenKeys.has(note.comment.stableKey)"
                type="button"
                class="pdf-note-open-anchor"
                :style="getMinimizedIndicatorStyle(note)"
                :data-stable-key="note.comment.stableKey"
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
            :key="`connector-halo-${line.stableKey}`"
            :d="line.path"
            class="pdf-note-connector-halo"
        />
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
        :can-insert-image="annotationContextMenuCanInsertImage"
        :annotation-label="contextMenuAnnotationLabel"
        :delete-label="contextMenuDeleteActionLabel"
        :is-image-comment="annotationContextMenuIsImage"
        @open-note="handleContextOpenNote"
        @copy-text="handleContextCopyText"
        @copy-selection-text="handleContextCopySelectionText"
        @delete="handleContextDelete"
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
</template>

<script setup lang="ts">

import PdfAnnotationProperties from '@app/components/pdf/PdfAnnotationProperties.vue';
import PdfAnnotationContextMenu from '@app/components/pdf/annotations/PdfAnnotationContextMenu.vue';
import PdfAnnotationNoteWindow from '@app/components/pdf/annotations/PdfAnnotationNoteWindow.vue';
import PdfPageContextMenu from '@app/components/pdf/PdfPageContextMenu.vue';
import type {
    IAnnotationCommentSummary,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { normalizeMarkerRect } from '@app/composables/pdf/annotationGeometry';
import type { IAnnotationNotePosition } from '@app/composables/pdf/annotations/annotationNoteWindowTypes';
import { NOTE_WINDOW } from '@app/constants/pdfLayout';
import { BrowserLogger } from '@app/utils/browserLogger';
import { clamp } from 'es-toolkit/math';
import {
    useEventListener,
    useMutationObserver,
} from '@vueuse/core';
import { createRafBurstScheduler } from '@app/modules/workspace-shell/components/overlayRafBurstScheduler';
import { escapeCssAttr } from '@app/composables/pdf/annotationCssUtils';

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

const {
    annotationNotePositions,
    annotationViewportRoot = undefined,
    annotationZoom = undefined,
    sortedAnnotationNoteWindows,
} = defineProps<{
    sortedAnnotationNoteWindows: IAnnotationNoteWindowEntry[];
    annotationComments: IAnnotationCommentSummary[];
    annotationNotePositions: Record<string, IAnnotationNotePosition>;
    annotationViewportRoot?: HTMLElement | null;
    annotationZoom?: number;
    annotationContextMenu: IContextMenuState;
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
}>();

const { t } = useTypedI18n();

const visibleAnnotationNoteWindows = computed(() =>
    sortedAnnotationNoteWindows.filter((note) => !note.isMinimized),
);
const openNoteAnchors = computed(() => {
    return visibleAnnotationNoteWindows.value.filter((note) =>
        isFloatingIndicatorEligible(note.comment)
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
            hidden.add(note.comment.stableKey);
        }
    }
    return hidden;
});
const anchoredAnnotationNoteWindows = computed(() => {
    return sortedAnnotationNoteWindows.filter((note) => (
        note.isMinimized
        && isFloatingIndicatorEligible(note.comment)
        && Boolean(getNoteMarkerRect(note))
        && !inlineIdentityMatchesNote(renderedInlineAnchorIdentity.value, note)
    ));
});
const indicatorDomTick = ref(0);
const annotationViewportRootElement = computed(() => annotationViewportRoot ?? null);

function logAnchor(message: string, payload: Record<string, unknown>) {
    BrowserLogger.debug('note-anchor', message, payload);
}

function refreshIndicatorDom() {
    indicatorDomTick.value += 1;
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

interface IViewportDomSnapshot { pageContainers: Map<number, HTMLElement> }

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

function isInlineNoteSubtype(subtype: string) {
    return INLINE_NOTE_SUBTYPES.has(subtype);
}

function isFreeTextNoteSubtype(subtype: string) {
    return FREE_TEXT_NOTE_SUBTYPES.has(subtype);
}

function resolveKnownFloatingEligibility(comment: IAnnotationCommentSummary, subtype: string) {
    if (isTextMarkupSubtype(comment.subtype) && comment.hasNote) {
        return true;
    }
    if (isInlineNoteSubtype(subtype)) {
        return comment.hasNote;
    }
    if (isFreeTextNoteSubtype(subtype)) {
        return true;
    }
    return null;
}

function isFloatingIndicatorEligible(comment: IAnnotationCommentSummary) {
    const subtype = (comment.subtype ?? '').trim().toLowerCase();
    if (subtype === 'link') {
        return false;
    }
    const knownEligibility = resolveKnownFloatingEligibility(comment, subtype);
    if (knownEligibility !== null) {
        return knownEligibility;
    }
    return comment.source === 'editor' && !comment.annotationId;
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

function addStableKeyIdentity(identity: IInlineTriggerIdentity, stableKey: string) {
    identity.stableKeys.add(stableKey);
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
}

function createEmptyInlineTriggerIdentity(): IInlineTriggerIdentity {
    return {
        stableKeys: new Set<string>(),
        annotationIds: new Set<string>(),
        uids: new Set<string>(),
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
            .querySelectorAll<HTMLElement>('.pdf-comment-marker-button[data-stable-key]')
            .forEach((markerElement) => {
                const stableKey = markerElement.dataset.stableKey;
                if (stableKey) {
                    addStableKeyIdentity(identity, stableKey);
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

function hasStringInSet(value: string | null | undefined, set: Set<string>) {
    const normalized = value?.trim() ?? '';
    return normalized.length > 0 && set.has(normalized);
}

function identityHasDirectMatch(
    inlineIdentity: IInlineTriggerIdentity,
    note: IAnnotationNoteWindowEntry,
) {
    return Boolean(
        hasStringInSet(note.comment.stableKey, inlineIdentity.stableKeys)
        || hasStringInSet(note.comment.annotationId, inlineIdentity.annotationIds)
        || hasStringInSet(note.comment.uid, inlineIdentity.uids),
    );
}

function hasDerivedStableKey(set: Set<string>, kind: 'ann' | 'uid', pageIndex: number, id: string | null | undefined) {
    const normalizedId = id?.trim() ?? '';
    return normalizedId.length > 0 && set.has(`${kind}:${pageIndex}:${normalizedId}`);
}

function identityHasDerivedStableKey(
    inlineIdentity: IInlineTriggerIdentity,
    note: IAnnotationNoteWindowEntry,
) {
    const pageIndex = note.comment.pageIndex;
    if (!Number.isFinite(pageIndex)) {
        return false;
    }
    return (
        hasDerivedStableKey(inlineIdentity.stableKeys, 'ann', pageIndex, note.comment.annotationId)
        || hasDerivedStableKey(inlineIdentity.stableKeys, 'uid', pageIndex, note.comment.uid)
    );
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
        point.pageNumber === note.comment.pageNumber
        && Math.hypot(point.x - noteAnchorX, point.y - noteAnchorY) <= 0.08
    ));
}

function inlineIdentityMatchesNote(
    inlineIdentity: IInlineTriggerIdentity,
    note: IAnnotationNoteWindowEntry,
) {
    return (
        identityHasDirectMatch(inlineIdentity, note)
        || identityHasDerivedStableKey(inlineIdentity, note)
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
        const pageContainer = snapshot.pageContainers.get(note.comment.pageNumber);
        if (pageContainer) {
            targets[note.comment.stableKey] = pageContainer;
        }
    });
    return targets;
}

interface IConnectorLine {
    stableKey: string;
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

function getRenderedMarkerCenter(pageContainer: HTMLElement, stableKey: string) {
    const escapedKey = escapeCssAttr(stableKey);
    const markerElement = pageContainer.querySelector<HTMLElement>(
        [
            `.pdf-comment-marker-button[data-stable-key="${escapedKey}"]`,
            `.pdf-note-open-anchor[data-stable-key="${escapedKey}"]`,
        ].join(', '),
    );
    const markerRect = markerElement?.getBoundingClientRect() ?? null;
    if (!markerRect || markerRect.width <= 0 || markerRect.height <= 0) {
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
    const pageContainer = snapshot.pageContainers.get(note.comment.pageNumber) ?? null;
    if (!pageContainer) {
        return null;
    }

    return getRenderedMarkerCenter(pageContainer, note.comment.stableKey)
        ?? getMarkerAnchorInPage(pageContainer, note);
}

function getRenderedNoteRect(stableKey: string): INoteViewportRect | null {
    if (typeof document === 'undefined') {
        return null;
    }
    const escapedKey = escapeCssAttr(stableKey);
    const noteElement = document.querySelector<HTMLElement>(
        `.note-window[data-stable-key="${escapedKey}"]`,
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
    stableKey: string,
    position: IAnnotationNotePosition,
) {
    return getRenderedNoteRect(stableKey) ?? getStoredNoteRect(position);
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
        const stableKey = note.comment.stableKey;
        const position = annotationNotePositions[stableKey];
        if (!position) {
            continue;
        }

        const marker = getMarkerCenter(note, snapshot);
        if (!marker) {
            continue;
        }

        const noteRect = getNoteViewportRect(stableKey, position);
        const noteAnchor = getNoteConnectorAnchor(noteRect, marker);
        const markerStart = getConnectorStart(marker, noteAnchor);

        lines.push({
            stableKey,
            path: `M ${markerStart.x} ${markerStart.y} L ${noteAnchor.x} ${noteAnchor.y}`,
        });
    }
    return lines;
}

function getNoteMarkerRect(note: IAnnotationNoteWindowEntry) {
    return normalizeMarkerRect(note.comment.markerRect);
}

function getNoteRenderSignature(note: IAnnotationNoteWindowEntry) {
    const rect = getNoteMarkerRect(note);
    return [
        note.comment.stableKey,
        note.comment.pageNumber,
        rect?.left ?? '',
        rect?.top ?? '',
        rect?.width ?? '',
        rect?.height ?? '',
    ].join(':');
}

function getNotePositionSignature() {
    return Object.entries(annotationNotePositions)
        .map(([
            stableKey,
            position,
        ]) => [
            stableKey,
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

function handleNoteTextUpdate(stableKey: string, text: string) {
    emit('update-note-text', stableKey, text);
}

function handleNotePositionUpdate(stableKey: string, position: IAnnotationNotePosition) {
    emit('update-note-position', stableKey, position);
    scheduleConnectorRefreshBurst(2);
}

function handleMinimizeNote(stableKey: string) {
    emit('minimize-note', stableKey);
}

function handleDeleteComment(comment: IAnnotationCommentSummary) {
    emit('delete-comment', comment);
}

function handleFocusNote(stableKey: string) {
    emit('focus-note', stableKey);
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

function handleShapeUpdate(updates: Partial<IShapeAnnotation>) {
    emit('shape-update', updates);
}

function handleShapeClose() {
    emit('shape-close');
}

function handleShapeDelete() {
    emit('shape-delete');
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

onMounted(() => {
    scheduleOverlayRefreshBurst(10);
});

onBeforeUnmount(() => {
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
    scheduleConnectorRefreshFrame,
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
    'shape-update': [updates: Partial<IShapeAnnotation>];
    'shape-close': [];
    'shape-delete': [];
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
    z-index: 24;
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
