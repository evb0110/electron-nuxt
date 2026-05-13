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
import { isTextMarkupSubtype } from '@app/services/pdf/annotation-subtype';
import { normalizeMarkerRect } from '@app/composables/pdf/annotationGeometry';
import type { IAnnotationNotePosition } from '@app/composables/pdf/annotations/annotationNoteWindowTypes';
import { NOTE_WINDOW } from '@app/constants/pdf-layout';
import { BrowserLogger } from '@app/utils/browser-logger';
import { clamp } from 'es-toolkit/math';
import { createRafBurstScheduler } from '@app/modules/workspace-shell/components/overlayRafBurstScheduler';

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
    void indicatorDomTick.value;
    return visibleAnnotationNoteWindows.value.filter((note) =>
        isFloatingIndicatorEligible(note.comment)
        && Boolean(getNoteMarkerRect(note)),
    );
});
const viewportDomSnapshot = computed<IViewportDomSnapshot | null>(() => {
    void indicatorDomTick.value;
    return collectViewportDomSnapshot(annotationViewportRoot);
});
const openAnchorHiddenKeys = computed<Set<string>>(() => {
    void indicatorDomTick.value;
    const snapshot = viewportDomSnapshot.value;
    const hidden = new Set<string>();
    if (!snapshot) {
        return hidden;
    }
    for (const note of openNoteAnchors.value) {
        if (inlineIdentityMatchesNote(snapshot.inlineIdentity, note)) {
            hidden.add(note.comment.stableKey);
        }
    }
    return hidden;
});
const anchoredAnnotationNoteWindows = computed(() => {
    void indicatorDomTick.value;
    const snapshot = viewportDomSnapshot.value;
    if (!snapshot) {
        return [];
    }
    return sortedAnnotationNoteWindows.filter((note) => (
        note.isMinimized
        && isFloatingIndicatorEligible(note.comment)
        && Boolean(getNoteMarkerRect(note))
        && !inlineIdentityMatchesNote(snapshot.inlineIdentity, note)
    ));
});
const indicatorDomTick = ref(0);
let viewportMutationObserver: MutationObserver | null = null;
let viewportScrollCleanup: (() => void) | null = null;
let viewportResizeCleanup: (() => void) | null = null;

function logAnchor(message: string, payload: Record<string, unknown>) {
    BrowserLogger.debug('note-anchor', message, payload);
}

function refreshIndicatorDom() {
    indicatorDomTick.value += 1;
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

interface IViewportDomSnapshot {
    inlineIdentity: IInlineTriggerIdentity;
    pageContainers: Map<number, HTMLElement>;
    markerButtonsByStableKey: Map<string, HTMLElement>;
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

function collectDirectStableKeys(
    marker: HTMLElement,
    identity: IInlineTriggerIdentity,
    markerButtonsByStableKey: Map<string, HTMLElement>,
) {
    const directStableKey = marker.dataset.commentStableKey?.trim()
        || marker.dataset.stableKey?.trim();
    if (directStableKey) {
        identity.stableKeys.add(directStableKey);
        markerButtonsByStableKey.set(directStableKey, marker);
    }
    parseStableKeysAttr(marker.getAttribute('data-comment-stable-keys')).forEach((stableKey) => {
        identity.stableKeys.add(stableKey);
    });
}

function collectMarkerAnnotationId(marker: HTMLElement, identity: IInlineTriggerIdentity) {
    const annotationId = marker.dataset.annotationId?.trim()
        ?? marker.getAttribute('data-annotation-id')?.trim()
        ?? marker.closest<HTMLElement>('[data-annotation-id]')?.getAttribute('data-annotation-id')?.trim()
        ?? '';
    if (annotationId) {
        identity.annotationIds.add(annotationId);
    }
}

function collectMarkerPoint(marker: HTMLElement, identity: IInlineTriggerIdentity) {
    const point = toPageNormalizedPoint(marker);
    if (point) {
        identity.markerPoints.push(point);
    }
}

function collectClosestStableKeys(
    marker: HTMLElement,
    identity: IInlineTriggerIdentity,
    markerButtonsByStableKey: Map<string, HTMLElement>,
) {
    const fromTarget = marker.closest<HTMLElement>('[data-comment-stable-keys], [data-comment-stable-key]');
    if (!fromTarget) {
        return;
    }
    const stableKey = fromTarget.dataset.commentStableKey?.trim();
    if (stableKey) {
        identity.stableKeys.add(stableKey);
        markerButtonsByStableKey.set(stableKey, marker);
    }
    parseStableKeysAttr(fromTarget.getAttribute('data-comment-stable-keys')).forEach((nextStableKey) => {
        identity.stableKeys.add(nextStableKey);
    });
}

function collectMarkerIdentity(
    marker: HTMLElement,
    identity: IInlineTriggerIdentity,
    markerButtonsByStableKey: Map<string, HTMLElement>,
) {
    collectDirectStableKeys(marker, identity, markerButtonsByStableKey);
    collectMarkerAnnotationId(marker, identity);
    collectMarkerPoint(marker, identity);
    collectClosestStableKeys(marker, identity, markerButtonsByStableKey);
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

    const markerButtonsByStableKey = new Map<string, HTMLElement>();
    const identity: IInlineTriggerIdentity = {
        stableKeys: new Set<string>(),
        annotationIds: new Set<string>(),
        uids: new Set<string>(),
        markerPoints: [],
    };

    const markers = viewportRoot.querySelectorAll<HTMLElement>(
        '.pdf-inline-comment-anchor-marker, .pdf-inline-comment-marker, .pdf-comment-marker-button, .annotationCommentButton, .popupTriggerArea, [data-comment-stable-keys], [data-comment-stable-key], [data-stable-key]',
    );
    markers.forEach((marker) => {
        collectMarkerIdentity(marker, identity, markerButtonsByStableKey);
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

    return {
        inlineIdentity: identity,
        pageContainers,
        markerButtonsByStableKey,
    };
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

const connectorLines = shallowRef<IConnectorLine[]>([]);

function getElementCenter(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
        return null;
    }
    return {
        cx: rect.left + rect.width / 2,
        cy: rect.top + rect.height / 2,
    };
}

function getRectCenterInPage(pageContainer: HTMLElement, note: IAnnotationNoteWindowEntry) {
    const markerRect = getNoteMarkerRect(note);
    if (!markerRect) {
        return null;
    }
    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }
    return {
        cx: pageRect.left + ((markerRect.left + markerRect.width / 2) * pageRect.width),
        cy: pageRect.top + ((markerRect.top + markerRect.height / 2) * pageRect.height),
    };
}

function getMarkerCenter(
    stableKey: string,
    note: IAnnotationNoteWindowEntry,
    snapshot: IViewportDomSnapshot,
): {
    cx: number;
    cy: number;
} | null {
    const pageContainer = snapshot.pageContainers.get(note.comment.pageNumber) ?? null;
    if (!pageContainer) {
        return null;
    }

    const markerEl = snapshot.markerButtonsByStableKey.get(stableKey) ?? null;
    if (markerEl) {
        const elementCenter = getElementCenter(markerEl);
        if (elementCenter) {
            return elementCenter;
        }
    }

    return getRectCenterInPage(pageContainer, note);
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

        const marker = getMarkerCenter(stableKey, note, snapshot);
        if (!marker) {
            continue;
        }

        const noteW = position.width ?? NOTE_WINDOW.DEFAULT_WIDTH;
        const noteH = position.height ?? NOTE_WINDOW.DEFAULT_HEIGHT;
        const noteCx = position.x + noteW / 2;
        const noteCy = position.y + noteH / 2;

        lines.push({
            stableKey,
            path: `M ${marker.cx} ${marker.cy} L ${noteCx} ${noteCy}`,
        });
    }
    return lines;
}

function getNoteMarkerRect(note: IAnnotationNoteWindowEntry) {
    return normalizeMarkerRect(note.comment.markerRect);
}

function getMinimizedIndicatorStyle(note: IAnnotationNoteWindowEntry) {
    void indicatorDomTick.value;
    void annotationZoom;

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

    viewportScrollCleanup?.();
    viewportScrollCleanup = null;
    viewportResizeCleanup?.();
    viewportResizeCleanup = null;

    const viewportRoot = annotationViewportRoot;
    if (!viewportRoot) {
        return;
    }

    const scheduleViewportRefresh = () => {
        scheduleOverlayRefreshBurst(4);
    };

    viewportRoot.addEventListener('scroll', scheduleViewportRefresh, {passive: true});
    viewportScrollCleanup = () => {
        viewportRoot.removeEventListener('scroll', scheduleViewportRefresh);
    };

    if (typeof window !== 'undefined') {
        window.addEventListener('resize', scheduleViewportRefresh, {passive: true});
        viewportResizeCleanup = () => {
            window.removeEventListener('resize', scheduleViewportRefresh);
        };
    }

    if (typeof MutationObserver !== 'undefined') {
        viewportMutationObserver = new MutationObserver(() => {
            scheduleOverlayRefreshBurst(4);
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

function handleNoteTextUpdate(stableKey: string, text: string) {
    emit('update-note-text', stableKey, text);
}

function handleNotePositionUpdate(stableKey: string, position: IAnnotationNotePosition) {
    emit('update-note-position', stableKey, position);
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

const overlayRefreshScheduler = createRafBurstScheduler(() => {
    refreshIndicatorDom();
    connectorLines.value = computeConnectorLines();
});

function scheduleOverlayRefreshBurst(frames = 6) {
    overlayRefreshScheduler.request(frames);
}

onMounted(() => {
    reconnectViewportObservers();
    scheduleOverlayRefreshBurst(10);
});

onBeforeUnmount(() => {
    overlayRefreshScheduler.cancel();
    connectorLines.value = [];
    viewportMutationObserver?.disconnect();
    viewportMutationObserver = null;
    viewportScrollCleanup?.();
    viewportScrollCleanup = null;
    viewportResizeCleanup?.();
    viewportResizeCleanup = null;
});

watch(
    () => annotationViewportRoot,
    () => {
        reconnectViewportObservers();
        scheduleOverlayRefreshBurst(12);
    },
);

watch(
    () => annotationZoom,
    () => {
        scheduleOverlayRefreshBurst(12);
    },
);

watch(
    () => anchoredAnnotationNoteWindows.value.map((note) => `${note.comment.stableKey}:${note.comment.pageNumber}`),
    () => {
        scheduleOverlayRefreshBurst(6);
    },
);

watch(
    () => visibleAnnotationNoteWindows.value.map((note) => note.comment.stableKey),
    () => {
        scheduleOverlayRefreshBurst(6);
    },
);

watch(
    () => annotationNotePositions,
    () => {
        scheduleOverlayRefreshBurst(3);
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
