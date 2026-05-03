import { AnnotationEditorType } from '@app/services/pdfjs/runtime-lib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import { delay } from 'es-toolkit/promise';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IPagePointTarget } from '@app/composables/pdf/annotations/types';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { markerRectCenterDistance } from '@app/composables/pdf/annotations/annotationRules';
import {
    getCommentText,
    toMarkerRectFromEditor,
} from '@app/composables/pdf/pdfAnnotationEditorUtils';
import type { IAnnotationContextMenuPayload } from '@app/composables/pdf/annotationContextMenu';
import {
    clamp01,
    normalizeMarkerRect,
} from '@app/composables/pdf/annotationGeometry';
import { errorToLogText } from '@app/composables/pdf/annotationCssUtils';
import { SELECTION_CACHE_TTL_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browser-logger';
import { runGuardedTask } from '@app/utils/async-guard';
import {
    asPdfjsEditor,
    clearSelectedEditorState,
    getActiveEditor,
    getAnnotationEditorLayer,
    getAnnotationEditorLayerDiv,
    getEditorsOnPage,
    isPdfjsEditorWithEditComment,
} from '@app/services/pdfjs/annotationEditorAdapter';

interface IHighlightIdentity {
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
    getEditorPendingKey: (editor: IPdfjsEditor, pageIndex: number) => string;
}

interface IHighlightMarkupSubtype {
    TOOL_TO_MARKUP_SUBTYPE: Partial<Record<TAnnotationTool, TMarkupSubtype>>;
    isSelectionMarkupTool: (tool: TAnnotationTool) => boolean;
    setEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number, s: TMarkupSubtype) => void;
    syncMarkupSubtypePresentationForEditors: () => void;
}

interface IHighlightSync {
    pendingCommentEditorKeys: Set<string>;
    toEditorSummary: (editor: IPdfjsEditor, pageIndex: number, text: string) => IAnnotationCommentSummary;
}

interface IHighlightToolManager {
    updateModeWithRetry: (
        uiManager: AnnotationEditorUIManager,
        mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
        pageNumber?: number,
    ) => Promise<unknown>;
    maybeAutoResetAnnotationTool: () => void;
}

interface IUseAnnotationHighlightOptions {
    viewerContainer: Ref<HTMLElement | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    getIdentity: () => IHighlightIdentity;
    getMarkupSubtype: () => IHighlightMarkupSubtype;
    getSync: () => IHighlightSync;
    getToolManager: () => IHighlightToolManager;
    stopDrag: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

interface IHighlightCommentContext {
    targetEditor: IPdfjsEditor | null;
    pageIndex: number;
    editorSnapshot: IEditorSnapshot;
    getEditorsForPage: (pageIndex: number) => IPdfjsEditor[];
    identity: IHighlightIdentity;
    markupSubtypeOverride: TMarkupSubtype | null;
    markupSubtype: IHighlightMarkupSubtype;
    commentSync: IHighlightSync;
    modeRestoredPromise: Promise<void>;
    applySubtypeOverrideToEditor: (editor: IPdfjsEditor | null) => boolean;
    clearEditorSelectionVisuals: (editor: IPdfjsEditor | null) => void;
}

interface IEditorSnapshot {
    editorsBeforeRefs: Set<IPdfjsEditor>;
    editorsBeforeIds: Set<string>;
}

interface INotePlacementDiagnosticsContext {
    attemptId?: string;
    source?: string;
    clickCapturedAtMs?: number;
    clickMeta?: Record<string, unknown>;
}

interface IPageCandidateLogEntry {
    pageNumber: number | null;
    inside: boolean;
    distanceSquared: number;
    rect: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    };
}

interface IPageGeometryCandidate {
    element: HTMLElement;
    rect: DOMRect;
    inside: boolean;
    distanceSquared: number;
}

interface IGeometryResolution {
    pageContainer: HTMLElement | null;
    source: 'inside' | 'nearest' | 'none';
    candidates: IPageCandidateLogEntry[] | null;
}

interface IPagePointResolutionInputs {
    targetPageContainer: HTMLElement | null;
    documentPointContainer: HTMLElement | null;
    geometryResolution: IGeometryResolution;
    byTargetPage: number | null;
    byElementFromPointPage: number | null;
    byGeometryPage: number | null;
}

interface IPagePointResolutionSelection {
    pageContainer: HTMLElement | null;
    selectedSource: string;
    targetConflictsWithElementPoint: boolean;
    targetConflictsWithGeometry: boolean;
    hasTargetConflict: boolean;
}

interface IPagePointPageNumbers {
    byTargetPage: number | null;
    byElementFromPointPage: number | null;
    byGeometryPage: number | null;
}


export const useAnnotationHighlight = (options: IUseAnnotationHighlightOptions) => {
    const {
        viewerContainer,
        annotationUiManager,
        currentPage,
        annotationTool,
        getIdentity,
        getMarkupSubtype,
        getSync,
        getToolManager,
        stopDrag,
        emitAnnotationOpenNote,
        emitAnnotationNotePlacementChange,
    } = options;

    const isPlacingComment = ref(false);
    const DEFAULT_POINT_MARKER_SIZE = 0.0016;
    const NOTE_PLACEMENT_LOG_SECTION = 'note-placement';
    const MAX_PAGE_CANDIDATE_LOG_ENTRIES = 14;

    let cachedSelectionRange: Range | null = null;
    let cachedSelectionTimestamp = 0;
    const subtypeRetryTimers = new Set<ReturnType<typeof setTimeout>>();

    tryOnScopeDispose(() => {
        subtypeRetryTimers.forEach(timer => clearTimeout(timer));
        subtypeRetryTimers.clear();
        cachedSelectionRange = null;
    });

    function scheduleSubtypeRetry(run: () => void, delayMs: number) {
        const timer = setTimeout(() => {
            subtypeRetryTimers.delete(timer);
            run();
        }, delayMs);
        subtypeRetryTimers.add(timer);
    }

    function cacheCurrentTextSelection() {
        const container = viewerContainer.value;
        if (!container) {
            cachedSelectionRange = null;
            return;
        }

        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return;
        }

        const range = selection.getRangeAt(0);
        const commonAncestor = range.commonAncestorContainer;
        const element = commonAncestor.nodeType === Node.TEXT_NODE
            ? commonAncestor.parentElement
            : commonAncestor as HTMLElement | null;

        if (!element?.closest('.text-layer, .textLayer') || !container.contains(element)) {
            cachedSelectionRange = null;
            cachedSelectionTimestamp = 0;
            return;
        }

        cachedSelectionRange = range.cloneRange();
        cachedSelectionTimestamp = Date.now();
    }

    function isRangeWithinViewerTextLayer(range: Range) {
        const container = viewerContainer.value;
        if (!container) {
            return false;
        }
        const commonAncestor = range.commonAncestorContainer;
        const element = commonAncestor.nodeType === Node.TEXT_NODE
            ? commonAncestor.parentElement
            : commonAncestor as HTMLElement | null;
        if (!element) {
            return false;
        }
        const textLayer = element.closest('.text-layer, .textLayer');
        return Boolean(textLayer && container.contains(textLayer));
    }

    function getSelectionRangeFromDocument() {
        const selection = document.getSelection();
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return null;
        }
        const range = selection.getRangeAt(0);
        if (!isRangeWithinViewerTextLayer(range)) {
            return null;
        }
        return range.cloneRange();
    }

    function getSelectionRangeForCommentAction() {
        const direct = getSelectionRangeFromDocument();
        if (direct) {
            return direct;
        }
        if (!cachedSelectionRange) {
            return null;
        }
        if ((Date.now() - cachedSelectionTimestamp) > SELECTION_CACHE_TTL_MS) {
            return null;
        }
        if (!isRangeWithinViewerTextLayer(cachedSelectionRange)) {
            return null;
        }
        return cachedSelectionRange.cloneRange();
    }

    function clearSelectionCache() {
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;
    }

    function restoreSelectionRange(activeRange: Range) {
        const selection = document.getSelection();
        try {
            selection?.removeAllRanges();
            selection?.addRange(activeRange.cloneRange());
        } catch (error) {
            BrowserLogger.debug('annotations', `Failed to restore current text selection: ${errorToLogText(error)}`);
        }
        return selection;
    }

    function getElementFromRangeNode(node: Node) {
        return node.nodeType === Node.TEXT_NODE
            ? node.parentElement
            : (node as HTMLElement | null);
    }

    function resolveTextLayerForRange(activeRange: Range) {
        const anchorElement = getElementFromRangeNode(activeRange.startContainer);
        const commonAncestorElement = getElementFromRangeNode(activeRange.commonAncestorContainer);
        return (anchorElement?.closest('.text-layer, .textLayer')
            ?? commonAncestorElement?.closest('.text-layer, .textLayer')) as HTMLElement | null;
    }

    function getPageNumberForTextLayer(textLayer: HTMLElement) {
        const pageContainer = textLayer.closest<HTMLElement>('.page_container');
        return pageContainer?.dataset.page
            ? Number(pageContainer.dataset.page)
            : currentPage.value;
    }

    function createModeRestoredDeferred() {
        let resolve: () => void = () => {};
        const promise = new Promise<void>((promiseResolve) => { resolve = promiseResolve; });
        return {
            promise,
            resolve,
        };
    }

    async function restoreHighlightModeAfterSelection(
        toolManager: IHighlightToolManager,
        uiManager: AnnotationEditorUIManager,
        previousMode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
        pageNumber: number,
    ) {
        const restoreModeError = await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
        if (restoreModeError) {
            BrowserLogger.warn('annotations', 'Failed to restore annotation mode', restoreModeError);
        }
    }

    function emitHighlightCommentLater(context: IHighlightCommentContext) {
        let attempts = 0;
        const tryEmitLater = () => {
            const lateEditor = pickCreatedEditorCandidate(
                context.pageIndex,
                context.editorSnapshot,
                context.getEditorsForPage,
                context.identity.getEditorIdentity,
            );
            if (!lateEditor) {
                attempts += 1;
                if (attempts < 12) {
                    scheduleSubtypeRetry(tryEmitLater, 80);
                }
                return;
            }
            context.applySubtypeOverrideToEditor(lateEditor);
            context.commentSync.pendingCommentEditorKeys.add(context.identity.getEditorPendingKey(lateEditor, context.pageIndex));
            const summary = context.commentSync.toEditorSummary(lateEditor, context.pageIndex, getCommentText(lateEditor));
            context.clearEditorSelectionVisuals(lateEditor);
            void context.modeRestoredPromise.then(() => {
                emitAnnotationOpenNote(summary);
            });
        };
        scheduleSubtypeRetry(tryEmitLater, 80);
    }

    function handleCreatedHighlightComment(context: IHighlightCommentContext) {
        if (!context.targetEditor) {
            emitHighlightCommentLater(context);
            return null;
        }
        context.commentSync.pendingCommentEditorKeys.add(
            context.identity.getEditorPendingKey(context.targetEditor, context.pageIndex),
        );
        const summary = context.commentSync.toEditorSummary(
            context.targetEditor,
            context.pageIndex,
            getCommentText(context.targetEditor),
        );
        context.clearEditorSelectionVisuals(context.targetEditor);
        return summary;
    }

    async function highlightSelectionInternal(withComment: boolean, explicitRange: Range | null = null): Promise<boolean> {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return false;
        }

        const identity = getIdentity();
        const markupSubtype = getMarkupSubtype();
        const commentSync = getSync();
        const toolManager = getToolManager();

        const activeRange = explicitRange?.cloneRange() ?? getSelectionRangeForCommentAction();
        if (!activeRange) {
            return false;
        }

        const selection = restoreSelectionRange(activeRange);

        const {
            startContainer,
            startOffset,
            endContainer,
            endOffset,
        } = activeRange;
        const text = activeRange.toString();

        const textLayer = resolveTextLayerForRange(activeRange);
        if (!textLayer) {
            return false;
        }

        const boxes = uiManager.getSelectionBoxes(textLayer);
        if (!boxes) {
            return false;
        }

        const pageNumber = getPageNumberForTextLayer(textLayer);
        const pageIndex = Math.max(0, pageNumber - 1);
        const getEditorsForPage = (editorPageIndex: number) => getEditorsOnPage(uiManager, editorPageIndex);
        const editorSnapshot = captureEditorSnapshot(pageIndex, getEditorsForPage, identity.getEditorIdentity);

        selection?.removeAllRanges();
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;

        const previousMode = uiManager.getMode();
        const markupSubtypeOverride = markupSubtype.TOOL_TO_MARKUP_SUBTYPE[annotationTool.value] ?? null;
        let createdAnnotation = false;
        let deferredNoteSummary: IAnnotationCommentSummary | null = null;
        const modeRestored = createModeRestoredDeferred();

        const resolveCreatedEditor = async (createdEditor: IPdfjsEditor | null) => {
            if (createdEditor) {
                return createdEditor;
            }
            const activeEditor = getActiveEditor(uiManager);
            if (activeEditor) {
                return activeEditor;
            }
            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch (error) {
                BrowserLogger.debug('annotations', `Editor render wait failed while resolving created highlight: ${errorToLogText(error)}`);
            }
            await nextTick();
            return pickCreatedEditorCandidate(pageIndex, editorSnapshot, getEditorsForPage, identity.getEditorIdentity);
        };

        const applySubtypeOverrideToEditor = (editor: IPdfjsEditor | null) => {
            if (!editor || !markupSubtypeOverride) {
                return false;
            }
            markupSubtype.setEditorMarkupSubtypeOverride(editor, pageIndex, markupSubtypeOverride);
            queueMicrotask(() => {
                markupSubtype.syncMarkupSubtypePresentationForEditors();
            });
            return true;
        };

        const clearEditorSelectionVisuals = (editor: IPdfjsEditor | null) => {
            clearSelectedEditorState(uiManager);

            const activeElement = document.activeElement as HTMLElement | null;
            if (activeElement && activeElement !== document.body) {
                const insidePdfViewer = activeElement.closest(
                    '.annotationEditorLayer, .annotation-editor-layer, .pdfViewer, .pdf-viewer',
                );
                if (insidePdfViewer) {
                    activeElement.blur();
                }
            }

            const clearSelectionClasses = () => {
                if (typeof document === 'undefined') {
                    return;
                }
                document.querySelectorAll<HTMLElement>(
                    '.annotationEditorLayer .selectedEditor, .annotationEditorLayer .selected, .annotation-editor-layer .selectedEditor, .annotation-editor-layer .selected',
                ).forEach((element) => {
                    element.classList.remove('selectedEditor', 'selected');
                });
                document.querySelectorAll<HTMLElement>(
                    '.textLayer .highlight.selected, .text-layer .highlight.selected, .highlightOutline.selected',
                ).forEach((element) => {
                    element.classList.remove('selected');
                });
                document.getSelection()?.removeAllRanges();
                editor?.div?.classList.remove('selectedEditor', 'selected');
            };

            clearSelectionClasses();
            if (typeof window !== 'undefined') {
                window.requestAnimationFrame(clearSelectionClasses);
                window.setTimeout(clearSelectionClasses, 0);
                window.setTimeout(clearSelectionClasses, 80);
            }
        };

        try {
            await switchToAnnotationModeOrThrow(toolManager, uiManager, AnnotationEditorType.HIGHLIGHT, pageNumber);
            await uiManager.waitForEditorsRendered(pageNumber);

            const layer = getAnnotationEditorLayer(uiManager, pageNumber - 1);
            const createdEditor = layer?.createAndAddNewEditor(
                new PointerEvent('pointerdown'),
                false,
                {
                    methodOfCreation: 'toolbar',
                    boxes,
                    anchorNode: startContainer,
                    anchorOffset: startOffset,
                    focusNode: endContainer,
                    focusOffset: endOffset,
                    text,
                },
            );
            createdAnnotation = true;
            const targetEditor = await resolveCreatedEditor(asPdfjsEditor(createdEditor));
            applySubtypeOverrideToEditor(targetEditor);

            if (!targetEditor && !withComment && markupSubtypeOverride) {
                let attempts = 0;
                const applySubtypeLater = () => {
                    const lateEditor = pickCreatedEditorCandidate(pageIndex, editorSnapshot, getEditorsForPage, identity.getEditorIdentity);
                    if (applySubtypeOverrideToEditor(lateEditor)) {
                        return;
                    }
                    attempts += 1;
                    if (attempts < 12) {
                        scheduleSubtypeRetry(applySubtypeLater, 80);
                    }
                };
                scheduleSubtypeRetry(applySubtypeLater, 80);
            }

            if (withComment) {
                deferredNoteSummary = handleCreatedHighlightComment({
                    targetEditor,
                    pageIndex,
                    editorSnapshot,
                    getEditorsForPage,
                    identity,
                    markupSubtypeOverride,
                    markupSubtype,
                    commentSync,
                    modeRestoredPromise: modeRestored.promise,
                    applySubtypeOverrideToEditor,
                    clearEditorSelectionVisuals,
                });
            } else {
                clearEditorSelectionVisuals(targetEditor);
            }
        } catch (error) {
            BrowserLogger.warn('annotations', `Failed to highlight selection: ${errorToLogText(error)}`);
            modeRestored.resolve();
        }

        if (createdAnnotation) {
            toolManager.maybeAutoResetAnnotationTool();
        }

        await restoreHighlightModeAfterSelection(toolManager, uiManager, previousMode, pageNumber);

        modeRestored.resolve();

        if (deferredNoteSummary) {
            emitAnnotationOpenNote(deferredNoteSummary);
        }

        return createdAnnotation;
    }

    function highlightSelection() {
        return highlightSelectionInternal(false);
    }

    async function commentSelection() {
        return highlightSelectionInternal(true);
    }

    async function maybeApplySelectionMarkup(explicitRange: Range | null = null) {
        const markupSubtype = getMarkupSubtype();
        if (!markupSubtype.isSelectionMarkupTool(annotationTool.value) || isPlacingComment.value) {
            return false;
        }
        const range = explicitRange ?? getSelectionRangeForCommentAction();
        if (!range) {
            return false;
        }
        return highlightSelectionInternal(false, range);
    }

    function markerRectFromPoint(pageX: number, pageY: number) {
        return normalizeMarkerRect({
            left: clamp01(pageX) - DEFAULT_POINT_MARKER_SIZE / 2,
            top: clamp01(pageY) - DEFAULT_POINT_MARKER_SIZE / 2,
            width: DEFAULT_POINT_MARKER_SIZE,
            height: DEFAULT_POINT_MARKER_SIZE,
        });
    }

    function roundForLog(value: number, digits = 3) {
        if (!Number.isFinite(value)) {
            return value;
        }
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }

    function getPageClientPoint(pageRect: DOMRect, pageX: number, pageY: number) {
        return {
            x: pageRect.left + clamp01(pageX) * pageRect.width,
            y: pageRect.top + clamp01(pageY) * pageRect.height,
        };
    }

    function dispatchFreeTextPointer(layerDiv: HTMLElement, clientX: number, clientY: number) {
        const eventInit: PointerEventInit = {
            clientX,
            clientY,
            button: 0,
            buttons: 1,
            bubbles: true,
            pointerType: 'mouse',
            isPrimary: true,
        };
        layerDiv.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        layerDiv.dispatchEvent(new PointerEvent('pointerup', eventInit));
    }

    function keepFreeTextEditorAlive(editor: IPdfjsEditor) {
        const editorDiv = editor.div?.querySelector<HTMLElement>('[contenteditable]')
            ?? (editor as { editorDiv?: HTMLElement }).editorDiv;
        if (editorDiv) {
            editorDiv.textContent = '\u200B';
        }
        editor.isEmpty = () => false;
    }

    function enforceMinimumNoteEditorSize(editor: IPdfjsEditor) {
        const minNoteEditorSize = DEFAULT_POINT_MARKER_SIZE;
        if ((editor.width ?? 0) < minNoteEditorSize) {
            editor.width = minNoteEditorSize;
        }
        if ((editor.height ?? 0) < minNoteEditorSize) {
            editor.height = minNoteEditorSize;
        }
    }

    async function waitForEditorMarkerRect(editor: IPdfjsEditor) {
        for (let attempt = 0; attempt < 12; attempt += 1) {
            const markerRect = toMarkerRectFromEditor(editor);
            if (markerRect) {
                break;
            }
            await delay(16);
            await nextTick();
        }
    }

    async function preparePointNoteEditor(
        editor: IPdfjsEditor,
        pageIndex: number,
        diagnosticsContext?: INotePlacementDiagnosticsContext,
    ) {
        keepFreeTextEditorAlive(editor);
        enforceMinimumNoteEditorSize(editor);
        editor.__evbResolvedPageIndex = pageIndex;
        editor.__evbPlacementAttemptId = diagnosticsContext?.attemptId ?? null;
        await waitForEditorMarkerRect(editor);
    }

    async function switchToAnnotationModeOrThrow(
        toolManager: IHighlightToolManager,
        uiManager: AnnotationEditorUIManager,
        mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
        pageNumber: number,
    ) {
        const modeError = await toolManager.updateModeWithRetry(uiManager, mode, pageNumber);
        if (!modeError) {
            return;
        }
        throw modeError instanceof Error
            ? modeError
            : new Error(String(modeError));
    }

    async function restorePreviousAnnotationMode(
        toolManager: IHighlightToolManager,
        uiManager: AnnotationEditorUIManager,
        previousMode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
        pageNumber: number,
    ) {
        if (previousMode !== AnnotationEditorType.FREETEXT) {
            await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
        }
    }

    async function tryCreateTextAnchorComment(
        pageContainer: HTMLElement,
        pageNumber: number,
        pageX: number,
        pageY: number,
        preferTextAnchor: boolean,
    ) {
        if (!preferTextAnchor) {
            return false;
        }
        const range = buildRangeFromPagePoint({
            pageContainer,
            pageNumber,
            pageX: clamp01(pageX),
            pageY: clamp01(pageY),
        });
        return range
            ? highlightSelectionInternal(true, range)
            : false;
    }

    function pickPointNoteMarkerRect(summary: IAnnotationCommentSummary, clickMarkerRect: IAnnotationMarkerRect | null) {
        const centerDistance = markerRectCenterDistance(summary.markerRect, clickMarkerRect);
        const shouldUseClickAnchor = Boolean(
            clickMarkerRect
            && (!summary.markerRect || centerDistance > 0.14),
        );
        return shouldUseClickAnchor
            ? clickMarkerRect
            : (summary.markerRect ?? clickMarkerRect);
    }

    function warnOnPointNotePageMismatch(
        summary: IAnnotationCommentSummary,
        pageNumber: number,
        diagnosticsContext?: INotePlacementDiagnosticsContext,
    ) {
        const summaryPageNumber = Number.isFinite(summary.pageNumber)
            ? summary.pageNumber
            : (summary.pageIndex + 1);
        if (!diagnosticsContext || summaryPageNumber === pageNumber) {
            return;
        }
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Quick-note page mismatch: summary page differs from requested page', {
            attemptId: diagnosticsContext.attemptId ?? null,
            requestedPageNumber: pageNumber,
            summaryPageNumber,
            summaryPageIndex: summary.pageIndex,
            summaryStableKey: summary.stableKey,
        });
    }

    function pinViewerScrollAroundEditorComment(editor: IPdfjsEditor) {
        if (!isPdfjsEditorWithEditComment(editor)) {
            return;
        }
        const viewer = viewerContainer.value;
        const snapshot = viewer
            ? {
                top: viewer.scrollTop,
                left: viewer.scrollLeft,
            }
            : null;
        const restoreViewerScroll = () => {
            if (!viewer || !snapshot) {
                return;
            }
            viewer.scrollTop = snapshot.top;
            viewer.scrollLeft = snapshot.left;
        };
        const pinViewerScroll = () => {
            restoreViewerScroll();
            queueMicrotask(restoreViewerScroll);
            if (typeof window !== 'undefined') {
                window.requestAnimationFrame(() => {
                    restoreViewerScroll();
                    window.requestAnimationFrame(restoreViewerScroll);
                });
                window.setTimeout(restoreViewerScroll, 0);
                window.setTimeout(restoreViewerScroll, 48);
            }
        };

        pinViewerScroll();
        editor.editComment();
        pinViewerScroll();
    }

    function openPointNoteSummary(editor: IPdfjsEditor, summaryForNote: IAnnotationCommentSummary) {
        try {
            emitAnnotationOpenNote(summaryForNote);
        } catch (error) {
            if (!isPdfjsEditorWithEditComment(editor)) {
                throw error instanceof Error
                    ? error
                    : new Error(String(error));
            }
            pinViewerScrollAroundEditorComment(editor);
        }
    }

    function toRectLog(rect: DOMRect | {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
    }) {
        return {
            left: roundForLog(rect.left),
            top: roundForLog(rect.top),
            right: roundForLog(rect.right),
            bottom: roundForLog(rect.bottom),
            width: roundForLog(rect.width),
            height: roundForLog(rect.height),
        };
    }

    function isPointInsideRect(clientX: number, clientY: number, rect: DOMRect) {
        return (
            clientX >= rect.left
            && clientX <= rect.right
            && clientY >= rect.top
            && clientY <= rect.bottom
        );
    }

    function squaredDistanceToRect(clientX: number, clientY: number, rect: DOMRect) {
        const dx = clientX < rect.left
            ? rect.left - clientX
            : (clientX > rect.right ? clientX - rect.right : 0);
        const dy = clientY < rect.top
            ? rect.top - clientY
            : (clientY > rect.bottom ? clientY - rect.bottom : 0);
        return dx * dx + dy * dy;
    }

    function measurePageGeometryCandidate(
        element: HTMLElement,
        clientX: number,
        clientY: number,
    ): IPageGeometryCandidate | null {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }
        return {
            element,
            rect,
            inside: isPointInsideRect(clientX, clientY, rect),
            distanceSquared: squaredDistanceToRect(clientX, clientY, rect),
        };
    }

    function toPageCandidateLogEntry(candidate: IPageGeometryCandidate): IPageCandidateLogEntry {
        return {
            pageNumber: parsePageNumberFromContainer(candidate.element),
            inside: candidate.inside,
            distanceSquared: roundForLog(candidate.distanceSquared),
            rect: toRectLog(candidate.rect),
        };
    }

    function createEmptyGeometryResolution(collectCandidates: boolean): IGeometryResolution {
        return {
            pageContainer: null,
            source: 'none',
            candidates: collectCandidates ? [] : null,
        };
    }

    function createGeometryResolution(
        candidate: IPageGeometryCandidate,
        source: IGeometryResolution['source'],
        candidates: IPageCandidateLogEntry[],
        collectCandidates: boolean,
    ): IGeometryResolution {
        return {
            pageContainer: candidate.element,
            source,
            candidates: collectCandidates ? candidates : null,
        };
    }

    function addGeometryCandidateLogEntry(
        candidate: IPageGeometryCandidate,
        candidates: IPageCandidateLogEntry[],
        collectCandidates: boolean,
    ) {
        if (collectCandidates && candidates.length < MAX_PAGE_CANDIDATE_LOG_ENTRIES) {
            candidates.push(toPageCandidateLogEntry(candidate));
        }
    }

    function chooseFinalGeometryResolution(
        insideMatch: IPageGeometryCandidate | null,
        nearest: IPageGeometryCandidate | null,
        candidates: IPageCandidateLogEntry[],
        collectCandidates: boolean,
    ) {
        if (insideMatch) {
            return createGeometryResolution(insideMatch, 'inside', candidates, collectCandidates);
        }
        if (nearest) {
            return createGeometryResolution(nearest, 'nearest', candidates, collectCandidates);
        }
        return createEmptyGeometryResolution(collectCandidates);
    }

    function scanPageGeometryCandidates(
        pages: HTMLElement[],
        clientX: number,
        clientY: number,
        collectCandidates: boolean,
    ): IGeometryResolution | null {
        let nearest: IPageGeometryCandidate | null = null;
        let insideMatch: IPageGeometryCandidate | null = null;
        const candidates: IPageCandidateLogEntry[] = [];

        for (const element of pages) {
            const candidate = measurePageGeometryCandidate(element, clientX, clientY);
            if (!candidate) {
                continue;
            }
            addGeometryCandidateLogEntry(candidate, candidates, collectCandidates);
            if (candidate.inside && !collectCandidates) {
                return createGeometryResolution(candidate, 'inside', candidates, collectCandidates);
            }
            if (candidate.inside && !insideMatch) {
                insideMatch = candidate;
            }
            if (!nearest || candidate.distanceSquared < nearest.distanceSquared) {
                nearest = candidate;
            }
        }

        return chooseFinalGeometryResolution(insideMatch, nearest, candidates, collectCandidates);
    }

    function parsePageNumberFromContainer(pageContainer: HTMLElement | null) {
        if (!pageContainer?.dataset.page) {
            return null;
        }
        const parsed = Number(pageContainer.dataset.page);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return null;
        }
        return parsed;
    }

    function summarizeElementForLog(element: HTMLElement | null) {
        if (!element) {
            return null;
        }
        return {
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            classList: Array.from(element.classList).slice(0, 8),
            dataPage: parsePageNumberFromContainer(element.closest<HTMLElement>('.page_container')),
            role: element.getAttribute('role'),
        };
    }

    function summarizeVisiblePageWindowForLog() {
        const container = viewerContainer.value;
        if (!container) {
            return null;
        }
        const viewportTop = container.scrollTop;
        const viewportBottom = viewportTop + container.clientHeight;
        const visiblePages: number[] = [];
        const pageContainers = container.querySelectorAll<HTMLElement>('.page_container');
        for (const pageContainer of pageContainers) {
            const pageNumber = parsePageNumberFromContainer(pageContainer);
            if (!pageNumber) {
                continue;
            }
            const pageTop = pageContainer.offsetTop;
            const pageBottom = pageTop + pageContainer.offsetHeight;
            if (pageBottom < viewportTop || pageTop > viewportBottom) {
                continue;
            }
            visiblePages.push(pageNumber);
        }
        return {
            start: visiblePages[0] ?? null,
            end: visiblePages.at(-1) ?? null,
            count: visiblePages.length,
            sample: visiblePages.slice(0, MAX_PAGE_CANDIDATE_LOG_ENTRIES),
            viewportTop: roundForLog(viewportTop),
            viewportBottom: roundForLog(viewportBottom),
        };
    }

    function resolvePageContainerByGeometry(
        clientX: number,
        clientY: number,
        options: { collectCandidates?: boolean } = {},
    ): IGeometryResolution {
        const collectCandidates = options.collectCandidates ?? false;
        const container = viewerContainer.value;
        if (!container) {
            return createEmptyGeometryResolution(collectCandidates);
        }
        const pages = Array.from(container.querySelectorAll<HTMLElement>('.page_container'));
        if (pages.length === 0) {
            return createEmptyGeometryResolution(collectCandidates);
        }

        return scanPageGeometryCandidates(pages, clientX, clientY, collectCandidates)
            ?? createEmptyGeometryResolution(collectCandidates);
    }

    function findPageContainerFromClientPoint(clientX: number, clientY: number) {
        return resolvePageContainerByGeometry(clientX, clientY).pageContainer;
    }

    function resolvePageContainerFromTarget(targetElement?: HTMLElement | null) {
        const container = viewerContainer.value;
        if (!container || !targetElement) {
            return null;
        }
        const pageContainer = targetElement.closest<HTMLElement>('.page_container');
        if (!pageContainer) {
            return null;
        }
        if (!container.contains(pageContainer)) {
            const targetPageNumber = parsePageNumberFromContainer(pageContainer);
            if (!targetPageNumber) {
                return null;
            }
            const matchingPage = Array.from(container.querySelectorAll<HTMLElement>('.page_container'))
                .find(page => parsePageNumberFromContainer(page) === targetPageNumber)
                ?? null;
            return matchingPage;
        }
        return pageContainer;
    }

    function resolvePageContainerFromDocumentPoint(clientX: number, clientY: number) {
        const container = viewerContainer.value;
        if (!container || typeof document === 'undefined') {
            return {
                pointElement: null,
                pageContainer: null,
            };
        }
        const pointElement = document.elementFromPoint(clientX, clientY);
        if (!(pointElement instanceof HTMLElement)) {
            return {
                pointElement: null,
                pageContainer: null,
            };
        }
        const pageContainer = pointElement.closest<HTMLElement>('.page_container');
        if (!pageContainer || !container.contains(pageContainer)) {
            return {
                pointElement,
                pageContainer: null,
            };
        }
        return {
            pointElement,
            pageContainer,
        };
    }

    function getPagePointTargetConflicts(pageNumbers: IPagePointPageNumbers) {
        const targetConflictsWithElementPoint = (
            pageNumbers.byTargetPage !== null
            && pageNumbers.byElementFromPointPage !== null
            && pageNumbers.byTargetPage !== pageNumbers.byElementFromPointPage
        );
        const targetConflictsWithGeometry = (
            pageNumbers.byTargetPage !== null
            && pageNumbers.byGeometryPage !== null
            && pageNumbers.byTargetPage !== pageNumbers.byGeometryPage
        );

        return {
            targetConflictsWithElementPoint,
            targetConflictsWithGeometry,
            hasTargetConflict: targetConflictsWithElementPoint || targetConflictsWithGeometry,
        };
    }

    function selectPagePointContainer(
        targetPageContainer: HTMLElement | null,
        documentPointContainer: HTMLElement | null,
        geometryResolution: IGeometryResolution,
        hasTargetConflict: boolean,
    ) {
        if (targetPageContainer && !hasTargetConflict) {
            return {
                pageContainer: targetPageContainer,
                selectedSource: 'target-element',
            };
        }

        if (documentPointContainer) {
            return {
                pageContainer: documentPointContainer,
                selectedSource: 'document.elementFromPoint',
            };
        }

        if (geometryResolution.pageContainer) {
            return {
                pageContainer: geometryResolution.pageContainer,
                selectedSource: geometryResolution.source === 'inside'
                    ? 'geometry-inside'
                    : 'geometry-nearest',
            };
        }

        return {
            pageContainer: targetPageContainer,
            selectedSource: targetPageContainer ? 'target-element-conflicted-fallback' : 'none',
        };
    }

    function selectPagePointResolution(inputs: IPagePointResolutionInputs): IPagePointResolutionSelection {
        const {
            targetPageContainer,
            documentPointContainer,
            geometryResolution,
            byTargetPage,
            byElementFromPointPage,
            byGeometryPage,
        } = inputs;
        const conflicts = getPagePointTargetConflicts({
            byTargetPage,
            byElementFromPointPage,
            byGeometryPage,
        });
        const selected = selectPagePointContainer(
            targetPageContainer,
            documentPointContainer,
            geometryResolution,
            conflicts.hasTargetConflict,
        );

        return {
            ...selected,
            ...conflicts,
        };
    }

    function logPagePointConflict(
        diagnostics: INotePlacementDiagnosticsContext,
        targetElement: HTMLElement | null,
        pointElement: HTMLElement | null,
        geometryResolution: IGeometryResolution,
        selection: IPagePointResolutionSelection,
        pageNumbers: IPagePointPageNumbers,
    ) {
        const viewer = viewerContainer.value;
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Quick-note page target conflict detected', {
            attemptId: diagnostics.attemptId ?? null,
            source: diagnostics.source ?? null,
            selectedSource: selection.selectedSource,
            byTargetPage: pageNumbers.byTargetPage,
            byElementFromPointPage: pageNumbers.byElementFromPointPage,
            byGeometryPage: pageNumbers.byGeometryPage,
            targetConflictsWithElementPoint: selection.targetConflictsWithElementPoint,
            targetConflictsWithGeometry: selection.targetConflictsWithGeometry,
            clickTarget: summarizeElementForLog(targetElement),
            pointElement: summarizeElementForLog(pointElement),
            renderedPageCandidates: geometryResolution.candidates,
            visiblePageWindow: summarizeVisiblePageWindowForLog(),
            viewerScrollTop: viewer?.scrollTop ?? null,
            viewerScrollLeft: viewer?.scrollLeft ?? null,
            clickMeta: diagnostics.clickMeta ?? null,
        });
    }

    function logPagePointResolutionFailure(
        diagnostics: INotePlacementDiagnosticsContext,
        clientX: number,
        clientY: number,
        targetElement: HTMLElement | null,
        pointElement: HTMLElement | null,
        geometryResolution: IGeometryResolution,
        selection: IPagePointResolutionSelection,
        pageNumbers: IPagePointPageNumbers,
    ) {
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Failed to resolve quick-note page container', {
            attemptId: diagnostics.attemptId ?? null,
            source: diagnostics.source ?? null,
            clientX: roundForLog(clientX),
            clientY: roundForLog(clientY),
            currentPage: currentPage.value,
            byTargetPage: pageNumbers.byTargetPage,
            byElementFromPointPage: pageNumbers.byElementFromPointPage,
            byGeometryPage: pageNumbers.byGeometryPage,
            selectedSource: selection.selectedSource,
            clickTarget: summarizeElementForLog(targetElement),
            pointElement: summarizeElementForLog(pointElement),
            renderedPageCandidates: geometryResolution.candidates,
            visiblePageWindow: summarizeVisiblePageWindowForLog(),
            clickMeta: diagnostics.clickMeta ?? null,
        });
    }

    function logInvalidPagePointRect(
        pageContainer: HTMLElement,
        rect: DOMRect,
        selectedSource: string,
        diagnostics?: INotePlacementDiagnosticsContext,
    ) {
        if (!diagnostics) {
            return;
        }
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note page container has invalid rect', {
            attemptId: diagnostics.attemptId ?? null,
            selectedSource,
            pageNumberFromDataset: pageContainer.dataset.page ?? null,
            rect: toRectLog(rect),
        });
    }

    function logInvalidPagePointNumber(
        pageContainer: HTMLElement,
        selectedSource: string,
        diagnostics?: INotePlacementDiagnosticsContext,
    ) {
        if (!diagnostics) {
            return;
        }
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note page container has invalid page number', {
            attemptId: diagnostics.attemptId ?? null,
            selectedSource,
            datasetPage: pageContainer.dataset.page ?? null,
            fallbackCurrentPage: currentPage.value,
        });
    }

    function resolvePagePointNumber(pageContainer: HTMLElement) {
        const pageNumber = pageContainer.dataset.page
            ? Number(pageContainer.dataset.page)
            : currentPage.value;
        return Number.isFinite(pageNumber) && pageNumber > 0
            ? pageNumber
            : null;
    }

    function buildPagePointTarget(
        pageContainer: HTMLElement,
        clientX: number,
        clientY: number,
        rect: DOMRect,
        pageNumber: number,
    ): IPagePointTarget {
        return {
            pageContainer,
            pageNumber,
            pageX: clamp01((clientX - rect.left) / rect.width),
            pageY: clamp01((clientY - rect.top) / rect.height),
        };
    }

    function buildPagePointTargetFromContainer(
        pageContainer: HTMLElement,
        clientX: number,
        clientY: number,
        selectedSource: string,
        diagnostics?: INotePlacementDiagnosticsContext,
    ): IPagePointTarget | null {
        const rect = pageContainer.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            logInvalidPagePointRect(pageContainer, rect, selectedSource, diagnostics);
            return null;
        }
        const pageNumber = resolvePagePointNumber(pageContainer);
        if (pageNumber === null) {
            logInvalidPagePointNumber(pageContainer, selectedSource, diagnostics);
            return null;
        }
        return buildPagePointTarget(pageContainer, clientX, clientY, rect, pageNumber);
    }

    function resolvePagePointTarget(
        clientX: number,
        clientY: number,
        targetElement?: HTMLElement | null,
        diagnostics?: INotePlacementDiagnosticsContext,
    ): IPagePointTarget | null {
        const targetPageContainer = resolvePageContainerFromTarget(targetElement);
        const documentPointResolution = resolvePageContainerFromDocumentPoint(clientX, clientY);
        const geometryResolution = resolvePageContainerByGeometry(clientX, clientY, {collectCandidates: Boolean(diagnostics)});
        const pageNumbers: IPagePointPageNumbers = {
            byTargetPage: parsePageNumberFromContainer(targetPageContainer),
            byElementFromPointPage: parsePageNumberFromContainer(documentPointResolution.pageContainer),
            byGeometryPage: parsePageNumberFromContainer(geometryResolution.pageContainer),
        };

        const selection = selectPagePointResolution({
            targetPageContainer,
            documentPointContainer: documentPointResolution.pageContainer,
            geometryResolution,
            ...pageNumbers,
        });

        if (diagnostics && selection.hasTargetConflict) {
            logPagePointConflict(
                diagnostics,
                targetElement ?? null,
                documentPointResolution.pointElement,
                geometryResolution,
                selection,
                pageNumbers,
            );
        }

        if (!selection.pageContainer) {
            if (diagnostics) {
                logPagePointResolutionFailure(
                    diagnostics,
                    clientX,
                    clientY,
                    targetElement ?? null,
                    documentPointResolution.pointElement,
                    geometryResolution,
                    selection,
                    pageNumbers,
                );
            }
            return null;
        }

        return buildPagePointTargetFromContainer(
            selection.pageContainer,
            clientX,
            clientY,
            selection.selectedSource,
            diagnostics,
        );
    }

    function getTextSpanDistanceScore(rect: DOMRect, targetX: number, targetY: number) {
        const inside = targetX >= rect.left && targetX <= rect.right && targetY >= rect.top && targetY <= rect.bottom;
        const dx = inside ? 0 : Math.min(Math.abs(targetX - rect.left), Math.abs(targetX - rect.right));
        const dy = inside ? 0 : Math.min(Math.abs(targetY - rect.top), Math.abs(targetY - rect.bottom));
        return (dx * dx) + (dy * dy);
    }

    function findClosestTextSpanInPage(pageContainer: HTMLElement, targetX: number, targetY: number): {
        span: HTMLElement;
        score: number;
        rect: DOMRect
    } | null {
        const spans = Array.from(
            pageContainer.querySelectorAll<HTMLElement>('.text-layer span, .textLayer span'),
        );
        let best: {
            span: HTMLElement;
            score: number;
            rect: DOMRect
        } | null = null;

        spans.forEach((span) => {
            const text = span.textContent?.trim() ?? '';
            if (!text) {
                return;
            }
            const rect = span.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return;
            }
            const score = getTextSpanDistanceScore(rect, targetX, targetY);
            if (!best || score < best.score) {
                best = {
                    span,
                    score,
                    rect,
                };
            }
        });

        return best;
    }

    function isWhitespaceAt(text: string, offset: number) {
        return /\s/.test(text[offset] ?? '');
    }

    function nearestNonWhitespaceOffset(text: string, seedOffset: number) {
        const length = text.length;
        const offset = Math.max(0, Math.min(length - 1, seedOffset));
        if (!isWhitespaceAt(text, offset)) {
            return offset;
        }

        let left = offset - 1;
        let right = offset + 1;
        while (left >= 0 || right < length) {
            if (left >= 0 && !isWhitespaceAt(text, left)) {
                return left;
            }
            if (right < length && !isWhitespaceAt(text, right)) {
                return right;
            }
            left -= 1;
            right += 1;
        }
        return offset;
    }

    function expandWordOffsets(text: string, offset: number) {
        const length = text.length;
        let start = offset;
        let end = Math.min(length, offset + 1);
        while (start > 0 && !isWhitespaceAt(text, start - 1)) {
            start -= 1;
        }
        while (end < length && !isWhitespaceAt(text, end)) {
            end += 1;
        }
        return {
            start,
            end, 
        };
    }

    function resolveWordOffsets(text: string, seedOffset: number) {
        const length = text.length;
        if (length <= 0) {
            return null;
        }

        const offset = nearestNonWhitespaceOffset(text, seedOffset);
        const offsets = expandWordOffsets(text, offset);

        if (offsets.start === offsets.end) {
            offsets.end = Math.min(length, offsets.start + 1);
        }
        return offsets;
    }

    function captureEditorSnapshot(
        pageIndex: number,
        getEditorsForPage: (pageIndex: number) => IPdfjsEditor[],
        getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string,
    ): IEditorSnapshot {
        const editorsBefore = getEditorsForPage(pageIndex);
        return {
            editorsBeforeRefs: new Set<IPdfjsEditor>(editorsBefore),
            editorsBeforeIds: new Set<string>(editorsBefore.map(editor => getEditorIdentity(editor, pageIndex))),
        };
    }

    function pickCreatedEditorCandidate(
        pageIndex: number,
        snapshot: IEditorSnapshot,
        getEditorsForPage: (pageIndex: number) => IPdfjsEditor[],
        getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string,
    ) {
        const editorsAfter = getEditorsForPage(pageIndex);
        return editorsAfter.find((editor) => {
            if (!snapshot.editorsBeforeRefs.has(editor)) {
                return true;
            }
            return !snapshot.editorsBeforeIds.has(getEditorIdentity(editor, pageIndex));
        }) ?? editorsAfter.at(-1) ?? null;
    }

    function buildRangeFromPagePoint(target: IPagePointTarget) {
        const pageRect = target.pageContainer.getBoundingClientRect();
        const clientX = pageRect.left + (target.pageX * pageRect.width);
        const clientY = pageRect.top + (target.pageY * pageRect.height);
        const nearest = findClosestTextSpanInPage(target.pageContainer, clientX, clientY);
        if (!nearest) {
            return null;
        }

        const textNode = Array
            .from(nearest.span.childNodes)
            .find((node): node is Text => node.nodeType === Node.TEXT_NODE && (node.textContent?.length ?? 0) > 0)
            ?? null;
        if (!textNode) {
            return null;
        }

        const text = textNode.textContent ?? '';
        if (!text.length) {
            return null;
        }

        const ratio = nearest.rect.width > 0
            ? clamp01((clientX - nearest.rect.left) / nearest.rect.width)
            : 0;
        const offsetSeed = Math.floor(ratio * Math.max(1, text.length - 1));
        const offsets = resolveWordOffsets(text, offsetSeed);
        if (!offsets) {
            return null;
        }

        const range = document.createRange();
        range.setStart(textNode, offsets.start);
        range.setEnd(textNode, offsets.end);
        return range;
    }

    async function commentAtPoint(
        pageNumber: number,
        pageX: number,
        pageY: number,
        pointOptions: {
            preferTextAnchor?: boolean;
            diagnosticsContext?: INotePlacementDiagnosticsContext;
        } = {},
    ) {
        const container = viewerContainer.value;
        const uiManager = annotationUiManager.value;
        const diagnosticsContext = pointOptions.diagnosticsContext;
        if (!container || !uiManager) {
            return false;
        }

        const identity = getIdentity();
        const commentSync = getSync();
        const toolManager = getToolManager();

        const pageContainer = container.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`);
        if (!pageContainer) {
            return false;
        }
        const pageRect = pageContainer.getBoundingClientRect();
        const pageClientPoint = getPageClientPoint(pageRect, pageX, pageY);

        const createdTextAnchor = await tryCreateTextAnchorComment(
            pageContainer,
            pageNumber,
            pageX,
            pageY,
            pointOptions.preferTextAnchor ?? true,
        );
        if (createdTextAnchor) {
            return true;
        }

        const pageIndex = Math.max(0, pageNumber - 1);
        const getEditorsForPage = (editorPageIndex: number) => getEditorsOnPage(uiManager, editorPageIndex);
        const editorSnapshot = captureEditorSnapshot(pageIndex, getEditorsForPage, identity.getEditorIdentity);

        const resolveCreatedEditor = async (createdEditor: IPdfjsEditor | null) => {
            if (createdEditor) {
                return createdEditor;
            }
            const immediate = pickCreatedEditorCandidate(pageIndex, editorSnapshot, getEditorsForPage, identity.getEditorIdentity);
            if (immediate) {
                return immediate;
            }
            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch { /* ignore */ }
            await delay(60);
            await nextTick();
            return pickCreatedEditorCandidate(pageIndex, editorSnapshot, getEditorsForPage, identity.getEditorIdentity);
        };

        const previousMode = uiManager.getMode();
        try {
            await switchToAnnotationModeOrThrow(toolManager, uiManager, AnnotationEditorType.FREETEXT, pageNumber);
            await uiManager.waitForEditorsRendered(pageNumber);
            const layerDiv = getAnnotationEditorLayerDiv(uiManager, pageNumber - 1);
            if (!layerDiv) {
                return false;
            }

            dispatchFreeTextPointer(layerDiv, pageClientPoint.x, pageClientPoint.y);

            const resolvedEditor = await resolveCreatedEditor(null);
            if (!resolvedEditor) {
                return false;
            }

            await preparePointNoteEditor(resolvedEditor, pageIndex, diagnosticsContext);

            const clickMarkerRect = markerRectFromPoint(pageX, pageY);
            resolvedEditor.__evbPendingAnchorRect = clickMarkerRect;
            commentSync.pendingCommentEditorKeys.add(identity.getEditorPendingKey(resolvedEditor, pageIndex));

            const summary = commentSync.toEditorSummary(resolvedEditor, pageIndex, getCommentText(resolvedEditor));
            const finalMarkerRect = pickPointNoteMarkerRect(summary, clickMarkerRect);
            warnOnPointNotePageMismatch(summary, pageNumber, diagnosticsContext);
            const summaryForNote = {
                ...summary,
                markerRect: finalMarkerRect,
            };

            openPointNoteSummary(resolvedEditor, summaryForNote);
            return true;
        } catch (error) {
            if (diagnosticsContext) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint threw while creating quick-note annotation', {
                    attemptId: diagnosticsContext.attemptId ?? null,
                    pageNumber,
                    error: errorToLogText(error),
                });
            }
            throw error instanceof Error
                ? error
                : new Error(String(error));
        } finally {
            await restorePreviousAnnotationMode(toolManager, uiManager, previousMode, pageNumber);
        }
    }

    function setCommentPlacementMode(active: boolean) {
        if (isPlacingComment.value === active) {
            return;
        }
        isPlacingComment.value = active;
        emitAnnotationNotePlacementChange(active);
    }

    function startCommentPlacement() {
        setCommentPlacementMode(true);
    }

    function cancelCommentPlacement() {
        setCommentPlacementMode(false);
    }

    async function placeCommentAtClientPoint(
        clientX: number,
        clientY: number,
        targetElement?: HTMLElement | null,
        diagnosticsContext?: INotePlacementDiagnosticsContext,
    ) {
        const attemptId = diagnosticsContext?.attemptId
            ?? `note-${crypto.randomUUID()}`;
        const viewer = viewerContainer.value;
        const viewerScrollSnapshot = (
            viewer
            && typeof viewer.scrollTop === 'number'
            && typeof viewer.scrollLeft === 'number'
        )
            ? {
                top: viewer.scrollTop,
                left: viewer.scrollLeft,
            }
            : null;
        const enrichedDiagnosticsContext: INotePlacementDiagnosticsContext = {
            ...diagnosticsContext,
            attemptId,
        };
        const pinViewerScrollAfterPlacement = (created: boolean) => {
            if (
                !created
                || !viewer
                || !viewerScrollSnapshot
                || typeof viewer.scrollTop !== 'number'
                || typeof viewer.scrollLeft !== 'number'
            ) {
                return;
            }

            const timeouts: Array<ReturnType<typeof setTimeout>> = [];
            const removeListeners: Array<() => void> = [];
            let userInteracted = false;

            const release = () => {
                timeouts.splice(0).forEach(timeoutId => clearTimeout(timeoutId));
                removeListeners.splice(0).forEach(dispose => dispose());
            };

            const scheduleTimeout = (callback: () => void, delayMs: number) => {
                const timeoutId = setTimeout(callback, delayMs);
                timeouts.push(timeoutId);
            };

            const restoreViewerScroll = () => {
                if (userInteracted) {
                    return;
                }
                viewer.scrollTop = viewerScrollSnapshot.top;
                viewer.scrollLeft = viewerScrollSnapshot.left;
                if (typeof window !== 'undefined') {
                    window.requestAnimationFrame(() => {
                        if (userInteracted) {
                            return;
                        }
                        viewer.scrollTop = viewerScrollSnapshot.top;
                        viewer.scrollLeft = viewerScrollSnapshot.left;
                    });
                }
                scheduleTimeout(() => {
                    if (userInteracted) {
                        return;
                    }
                    viewer.scrollTop = viewerScrollSnapshot.top;
                    viewer.scrollLeft = viewerScrollSnapshot.left;
                }, 32);
            };

            const registerUserIntentCancel = (
                eventName: 'wheel' | 'touchstart' | 'pointerdown',
            ) => {
                const handler = (event: Event) => {
                    if ('isTrusted' in event && event.isTrusted === false) {
                        return;
                    }
                    userInteracted = true;
                };
                viewer.addEventListener(eventName, handler, {
                    passive: true,
                    once: true,
                });
                removeListeners.push(() => {
                    viewer.removeEventListener(eventName, handler);
                });
            };

            registerUserIntentCancel('wheel');
            registerUserIntentCancel('touchstart');
            registerUserIntentCancel('pointerdown');

            restoreViewerScroll();
            queueMicrotask(restoreViewerScroll);
            if (typeof window !== 'undefined') {
                window.requestAnimationFrame(() => {
                    restoreViewerScroll();
                    window.requestAnimationFrame(restoreViewerScroll);
                });
            }
            const checkpoints = [
                0,
                32,
                96,
                180,
                320,
            ];
            checkpoints.forEach((delayMs) => {
                scheduleTimeout(() => restoreViewerScroll(), delayMs);
            });
            scheduleTimeout(() => {
                release();
            }, 460);
        };

        const target = resolvePagePointTarget(clientX, clientY, targetElement, enrichedDiagnosticsContext);
        if (!target) {
            return false;
        }
        const created = await commentAtPoint(
            target.pageNumber,
            target.pageX,
            target.pageY,
            {
                preferTextAnchor: false,
                diagnosticsContext: enrichedDiagnosticsContext,
            },
        );
        if (created) {
            setCommentPlacementMode(false);
        }
        pinViewerScrollAfterPlacement(created);
        return created;
    }

    function handleViewerMouseUp() {
        stopDrag();
    }

    function handleDocumentPointerUp(event: PointerEvent) {
        if (event.button !== 0) {
            return;
        }
        runGuardedTask(() => maybeApplySelectionMarkup(), {
            scope: 'annotations',
            message: 'Failed to apply selection markup on pointer up',
        });
    }

    function buildAnnotationContextMenuPayload(
        comment: IAnnotationCommentSummary | null,
        clientX: number,
        clientY: number,
    ): IAnnotationContextMenuPayload {
        const selectionRange = getSelectionRangeForCommentAction();
        const target = resolvePagePointTarget(clientX, clientY);
        return {
            comment,
            clientX,
            clientY,
            hasSelection: Boolean(selectionRange),
            selectionText: selectionRange?.toString() ?? '',
            pageNumber: target?.pageNumber ?? null,
            pageX: target?.pageX ?? null,
            pageY: target?.pageY ?? null,
        };
    }

    return {
        isPlacingComment,
        highlightSelection,
        commentSelection,
        commentAtPoint,
        placeCommentAtClientPoint,
        startCommentPlacement,
        cancelCommentPlacement,
        handleViewerMouseUp,
        handleDocumentPointerUp,
        cacheCurrentTextSelection,
        maybeApplySelectionMarkup,
        buildAnnotationContextMenuPayload,
        resolvePagePointTarget,
        findPageContainerFromClientPoint,
        clearSelectionCache,
        highlightSelectionInternal,
    };
};
