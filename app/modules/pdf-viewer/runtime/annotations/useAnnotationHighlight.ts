import { AnnotationEditorType } from '@app/services/pdfjs/runtimeLib';
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
import type {
    IPdfjsEditor,
    IPdfjsHighlightBox,
} from '@app/types/pdfjs';
import type {
    ICreateTextMarkupFromTextOptions,
    ICreateTextMarkupFromTextResult,
    TAgentTextMarkupKind,
} from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import { markerRectCenterDistance } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/markerRectCenterDistance';
import { getCommentText } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/getCommentText';
import { toMarkerRectFromEditor } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/toMarkerRectFromEditor';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import { clamp01 } from '@app/modules/pdf-viewer/engine/annotation-geometry/clamp01';
import { errorToLogText } from '@app/modules/pdf-viewer/engine/annotation-css-utils/errorToLogText';
import { SELECTION_CACHE_TTL_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import {
    addUndoableEditorToLayer,
    asPdfjsEditor,
    clearSelectedEditorState,
    getActiveEditor,
    getAnnotationEditorLayer,
    getAnnotationEditorLayerDiv,
    getEditorsOnPage,
    isPdfjsEditorWithEditComment,
} from '@app/services/pdfjs/annotationEditorAdapter';
import { replaceOverlappingSelectionMarkup } from '@app/services/pdfjs/replaceOverlappingSelectionMarkup';
import { createPdfPagePointResolver } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/createPdfPagePointResolver';
import { markerRectFromPoint } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/markerRectFromPoint';
import type { INotePlacementDiagnosticsContext } from '@app/modules/pdf-viewer/engine/annotations/pdf-page-point-resolver/notePlacementDiagnosticsContext';
import { buildRangeFromPagePoint } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPagePoint';
import { buildRangeFromPageText } from '@app/modules/pdf-viewer/engine/annotations/pdf-text-anchor-resolver/buildRangeFromPageText';
import { resolveCommentWithRenderedTextMarkupColorAtPoint } from '@app/modules/pdf-viewer/engine/annotations/annotation-dom-removal/resolveCommentWithRenderedTextMarkupColorAtPoint';
import {
    markCommentMarkerAnchorEditor,
    syncCommentMarkerAnchorEditor,
} from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/commentMarkerAnchorEditor';

const ANNOTATION_EDITOR_RETRY_ATTEMPTS = 12;
const ANNOTATION_EDITOR_RETRY_DELAY_MS = 80;
const ANNOTATION_EDITOR_MARKER_RECT_RETRY_DELAY_MS = 16;
const SELECTION_CLEAR_FALLBACK_DELAY_MS = 80;
const SCROLL_RESTORE_FALLBACK_DELAY_MS = 48;
const CREATED_EDITOR_SETTLE_DELAY_MS = 60;

interface IHighlightIdentity {
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
    getEditorPendingKey: (editor: IPdfjsEditor, pageIndex: number) => string;
}

interface IHighlightMarkupSubtype {
    toolToMarkupSubtype: Partial<Record<TAnnotationTool, TMarkupSubtype>>;
    isSelectionMarkupTool: (tool: TAnnotationTool) => boolean;
    setEditorMarkupSubtypeOverride: (
        e: IPdfjsEditor,
        pi: number,
        s: TMarkupSubtype,
        opts?: { preferEditorColor?: boolean },
    ) => void;
    resolveEditorMarkupSubtypeOverride: (e: IPdfjsEditor, pi: number) => TMarkupSubtype | null;
    resolveEditorSubtypeFromPresentation: (e: IPdfjsEditor) => TMarkupSubtype | null;
    syncMarkupSubtypePresentationForEditors: () => void;
}

interface IHighlightSync {
    pendingCommentEditorKeys: Set<string>;
    scheduleAnnotationCommentsSync: (immediate?: boolean) => void;
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
    numPages: {value: number};
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    getIdentity: () => IHighlightIdentity;
    getMarkupSubtype: () => IHighlightMarkupSubtype;
    getSync: () => IHighlightSync;
    getToolManager: () => IHighlightToolManager;
    ensureAnnotationEditorLayerReady?: (pageNumber: number) => Promise<void>;
    deferCreatedEditorUndoToStorage?: boolean;
    stopDrag: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

interface IHighlightCommentContext {
    targetEditor: IPdfjsEditor | null;
    pageIndex: number;
    selectionPreviewText: string;
    editorSnapshot: IEditorSnapshot;
    getEditorsForPage: (pageIndex: number) => IPdfjsEditor[];
    identity: IHighlightIdentity;
    markupSubtypeOverride: TMarkupSubtype | null;
    markupSubtype: IHighlightMarkupSubtype;
    commentSync: IHighlightSync;
    modeRestoredPromise: Promise<void>;
    registerCreatedEditorUndo: (editor: IPdfjsEditor | null) => boolean;
    applySubtypeOverrideToEditor: (editor: IPdfjsEditor | null) => boolean;
    clearEditorSelectionVisuals: (editor: IPdfjsEditor | null) => void;
}

interface IEditorSnapshot {
    editorsBeforeRefs: Set<IPdfjsEditor>;
    editorsBeforeIds: Set<string>;
}

export const useAnnotationHighlight = (options: IUseAnnotationHighlightOptions) => {
    const {
        viewerContainer,
        annotationUiManager,
        numPages,
        currentPage,
        annotationTool,
        getIdentity,
        getMarkupSubtype,
        getSync,
        getToolManager,
        ensureAnnotationEditorLayerReady,
        deferCreatedEditorUndoToStorage = false,
        stopDrag,
        emitAnnotationOpenNote,
        emitAnnotationNotePlacementChange,
    } = options;

    const isPlacingComment = ref(false);
    const DEFAULT_POINT_MARKER_SIZE = 0.0016;
    const NOTE_PLACEMENT_LOG_SECTION = 'note-placement';
    const EDITOR_RENDER_WAIT_TIMEOUT_MS = 1_500;
    const pagePointResolver = createPdfPagePointResolver({
        viewerContainer,
        currentPage,
    });
    const {
        resolvePagePointTarget,
        findPageContainerFromClientPoint,
    } = pagePointResolver;

    function isAnnotationUiManagerCurrent(uiManager: AnnotationEditorUIManager) {
        return annotationUiManager.value === uiManager;
    }

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

    function cloneHighlightBoxes(boxes: readonly IPdfjsHighlightBox[]) {
        return boxes.map(box => ({ ...box }));
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

    function attachSelectionPreviewText(editor: IPdfjsEditor | null, text: string) {
        const previewText = text.trim();
        if (!editor || !previewText) {
            return;
        }
        editor.__evbSelectionText = previewText;
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
                if (attempts < ANNOTATION_EDITOR_RETRY_ATTEMPTS) {
                    scheduleSubtypeRetry(tryEmitLater, ANNOTATION_EDITOR_RETRY_DELAY_MS);
                }
                return;
            }
            attachSelectionPreviewText(lateEditor, context.selectionPreviewText);
            context.registerCreatedEditorUndo(lateEditor);
            context.applySubtypeOverrideToEditor(lateEditor);
            context.commentSync.pendingCommentEditorKeys.add(context.identity.getEditorPendingKey(lateEditor, context.pageIndex));
            const summary = context.commentSync.toEditorSummary(lateEditor, context.pageIndex, getCommentText(lateEditor));
            context.clearEditorSelectionVisuals(lateEditor);
            void context.modeRestoredPromise.then(() => {
                emitAnnotationOpenNote(summary);
            });
        };
        scheduleSubtypeRetry(tryEmitLater, ANNOTATION_EDITOR_RETRY_DELAY_MS);
    }

    function handleCreatedHighlightComment(context: IHighlightCommentContext) {
        if (!context.targetEditor) {
            emitHighlightCommentLater(context);
            return null;
        }
        attachSelectionPreviewText(context.targetEditor, context.selectionPreviewText);
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

    async function highlightSelectionInternal(
        withComment: boolean,
        explicitRange: Range | null = null,
        selectionOptions: {markupSubtype?: TMarkupSubtype | null} = {},
    ) {
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
        const selectionPreviewText = text.trim();

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

        selection?.removeAllRanges();
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;

        const previousMode = uiManager.getMode();
        const markupSubtypeOverride = selectionOptions.markupSubtype
            ?? markupSubtype.toolToMarkupSubtype[annotationTool.value]
            ?? null;
        let createdAnnotation = false;
        let deferredNoteSummary: IAnnotationCommentSummary | null = null;
        let editorSnapshot = captureEditorSnapshot(pageIndex, getEditorsForPage, identity.getEditorIdentity);
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
            if (!isAnnotationUiManagerCurrent(uiManager)) {
                return null;
            }
            return pickCreatedEditorCandidate(pageIndex, editorSnapshot, getEditorsForPage, identity.getEditorIdentity);
        };

        const applySubtypeOverrideToEditor = (editor: IPdfjsEditor | null) => {
            if (!editor || !isAnnotationUiManagerCurrent(uiManager)) {
                return false;
            }
            attachSelectionPreviewText(editor, selectionPreviewText);
            if (!markupSubtypeOverride) {
                return false;
            }
            editor.__evbMarkupBoxes = cloneHighlightBoxes(boxes);
            markupSubtype.setEditorMarkupSubtypeOverride(
                editor,
                pageIndex,
                markupSubtypeOverride,
                { preferEditorColor: false },
            );
            queueMicrotask(() => {
                if (!isAnnotationUiManagerCurrent(uiManager)) {
                    return;
                }
                markupSubtype.syncMarkupSubtypePresentationForEditors();
            });
            return true;
        };

        const clearEditorSelectionVisuals = (editor: IPdfjsEditor | null) => {
            if (!isAnnotationUiManagerCurrent(uiManager)) {
                return;
            }
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
                window.setTimeout(clearSelectionClasses, SELECTION_CLEAR_FALLBACK_DELAY_MS);
            }
        };

        try {
            await switchToAnnotationModeOrThrow(toolManager, uiManager, AnnotationEditorType.HIGHLIGHT, pageNumber);
            await uiManager.waitForEditorsRendered(pageNumber);
            if (!isAnnotationUiManagerCurrent(uiManager)) {
                return false;
            }

            const layer = getAnnotationEditorLayer(uiManager, pageNumber - 1);
            let undoRegistered = false;
            const registerCreatedEditorUndo = (editor: IPdfjsEditor | null) => {
                if (!editor || undoRegistered || !isAnnotationUiManagerCurrent(uiManager)) {
                    return false;
                }
                try {
                    if (deferCreatedEditorUndoToStorage) {
                        undoRegistered = true;
                        return true;
                    }
                    if (editor.__evbCreationHistoryRegistered) {
                        undoRegistered = true;
                        return true;
                    }
                    const activeLayer = getAnnotationEditorLayer(uiManager, pageIndex) ?? layer ?? editor.parent ?? null;
                    if (!addUndoableEditorToLayer(activeLayer, editor)) {
                        return false;
                    }
                    editor.__evbCreationHistoryRegistered = true;
                    undoRegistered = true;
                    return true;
                } catch (error) {
                    BrowserLogger.warn('annotations', `Failed to register created text markup undo command: ${errorToLogText(error)}`);
                    return false;
                }
            };
            replaceOverlappingSelectionMarkup(
                pageIndex,
                boxes,
                markupSubtypeOverride,
                getEditorsForPage,
                layer,
                markupSubtype,
            );
            editorSnapshot = captureEditorSnapshot(pageIndex, getEditorsForPage, identity.getEditorIdentity);
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
            registerCreatedEditorUndo(targetEditor);
            attachSelectionPreviewText(targetEditor, selectionPreviewText);
            applySubtypeOverrideToEditor(targetEditor);

            if (!targetEditor && !withComment) {
                let attempts = 0;
                const hydrateEditorLater = () => {
                    if (!isAnnotationUiManagerCurrent(uiManager)) {
                        return;
                    }
                    const lateEditor = pickCreatedEditorCandidate(pageIndex, editorSnapshot, getEditorsForPage, identity.getEditorIdentity);
                    registerCreatedEditorUndo(lateEditor);
                    attachSelectionPreviewText(lateEditor, selectionPreviewText);
                    if (applySubtypeOverrideToEditor(lateEditor)) {
                        return;
                    }
                    if (lateEditor && !markupSubtypeOverride) {
                        return;
                    }
                    attempts += 1;
                    if (attempts < ANNOTATION_EDITOR_RETRY_ATTEMPTS) {
                        scheduleSubtypeRetry(hydrateEditorLater, ANNOTATION_EDITOR_RETRY_DELAY_MS);
                    }
                };
                scheduleSubtypeRetry(hydrateEditorLater, ANNOTATION_EDITOR_RETRY_DELAY_MS);
            }

            if (withComment) {
                deferredNoteSummary = handleCreatedHighlightComment({
                    targetEditor,
                    pageIndex,
                    selectionPreviewText,
                    editorSnapshot,
                    getEditorsForPage,
                    identity,
                    markupSubtypeOverride,
                    markupSubtype,
                    commentSync,
                    modeRestoredPromise: modeRestored.promise,
                    registerCreatedEditorUndo,
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

        if (deferredNoteSummary && isAnnotationUiManagerCurrent(uiManager)) {
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
            BrowserLogger.debug('annotations', 'Selection markup skipped because no text selection was available', () => ({
                tool: annotationTool.value,
                viewerHasTextLayers: (viewerContainer.value?.querySelectorAll('.text-layer, .textLayer').length ?? 0) > 0,
                renderedTextSpanCount: viewerContainer.value?.querySelectorAll('.text-layer span, .textLayer span').length ?? 0,
                selectionText: document.getSelection()?.toString() ?? '',
                selectionRangeCount: document.getSelection()?.rangeCount ?? 0,
                selectionCollapsed: document.getSelection()?.isCollapsed ?? null,
            }));
            return false;
        }
        return highlightSelectionInternal(false, range);
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

    function getLayerOffsetPoint(layerDiv: HTMLElement, clientX: number, clientY: number) {
        const rect = layerDiv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return null;
        }

        return {
            offsetX: Math.min(Math.max(clientX - rect.left, 0), rect.width),
            offsetY: Math.min(Math.max(clientY - rect.top, 0), rect.height),
        };
    }

    function createFreeTextEditorAtPoint(
        uiManager: AnnotationEditorUIManager,
        pageIndex: number,
        layerDiv: HTMLElement,
        clientX: number,
        clientY: number,
    ) {
        const layer = getAnnotationEditorLayer(uiManager, pageIndex);
        const offsetPoint = getLayerOffsetPoint(layerDiv, clientX, clientY);
        if (!layer || !offsetPoint) {
            return null;
        }

        const editor = layer.createAndAddNewEditor(
            offsetPoint as PointerEvent,
            false,
        );
        return asPdfjsEditor(editor);
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
        for (let attempt = 0; attempt < ANNOTATION_EDITOR_RETRY_ATTEMPTS; attempt += 1) {
            const markerRect = toMarkerRectFromEditor(editor);
            if (markerRect) {
                break;
            }
            await delay(ANNOTATION_EDITOR_MARKER_RECT_RETRY_DELAY_MS);
            await nextTick();
        }
    }

    async function preparePointNoteEditor(
        editor: IPdfjsEditor,
        pageIndex: number,
        diagnosticsContext?: INotePlacementDiagnosticsContext,
    ) {
        markCommentMarkerAnchorEditor(editor);
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

    function resolveTextMarkupSubtype(markup: TAgentTextMarkupKind | undefined): TMarkupSubtype {
        switch (markup) {
            case 'underline':
                return 'Underline';
            case 'strikethrough':
                return 'StrikeOut';
            case 'squiggly':
                return 'Squiggly';
            case 'highlight':
            default:
                return 'Highlight';
        }
    }

    function getPageContainerByNumber(pageNumber: number) {
        return viewerContainer.value?.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        ) ?? null;
    }

    function normalizePositiveInteger(value: number | undefined, fallback: number) {
        return typeof value === 'number' && Number.isFinite(value)
            ? Math.max(1, Math.trunc(value))
            : fallback;
    }

    async function createTextMarkupFromText(
        textMarkupOptions: ICreateTextMarkupFromTextOptions,
    ): Promise<ICreateTextMarkupFromTextResult> {
        const pageNumber = normalizePositiveInteger(textMarkupOptions.pageNumber, currentPage.value);
        const occurrence = normalizePositiveInteger(textMarkupOptions.occurrence, 1);
        const requestedText = textMarkupOptions.text.trim();
        const subtype = resolveTextMarkupSubtype(textMarkupOptions.markup);
        const createResult = (
            created: boolean,
            matchedText: string | null,
            reason?: string,
        ): ICreateTextMarkupFromTextResult => ({
            created,
            pageNumber,
            requestedText,
            matchedText,
            occurrence,
            subtype,
            ...(reason ? {reason} : {}),
        });

        if (!requestedText) {
            return createResult(false, null, 'Text is required.');
        }

        if (pageNumber > numPages.value) {
            return createResult(false, null, `Page ${pageNumber} is outside the document.`);
        }

        try {
            await ensureAnnotationEditorLayerReady?.(pageNumber);
            await nextTick();
        } catch (error) {
            BrowserLogger.warn('annotations', `Failed to prepare page ${pageNumber} for text markup: ${errorToLogText(error)}`);
        }

        const pageContainer = getPageContainerByNumber(pageNumber);
        if (!pageContainer) {
            return createResult(false, null, `Page ${pageNumber} is not rendered.`);
        }

        const match = buildRangeFromPageText(pageContainer, {
            text: requestedText,
            occurrence,
            caseSensitive: textMarkupOptions.caseSensitive,
            wholeWord: textMarkupOptions.wholeWord,
        });
        if (!match) {
            return createResult(false, null, `Text was not found on page ${pageNumber}.`);
        }

        const created = await highlightSelectionInternal(
            textMarkupOptions.withNote === true,
            match.range,
            {markupSubtype: subtype},
        );
        return createResult(created, match.matchedText, created ? undefined : 'Text markup could not be created.');
    }

    async function waitForEditorsRenderedWithTimeout(
        uiManager: AnnotationEditorUIManager,
        pageNumber: number,
        reason: string,
        diagnosticsContext?: INotePlacementDiagnosticsContext,
    ) {
        const timeoutController = new AbortController();
        try {
            await Promise.race([
                uiManager.waitForEditorsRendered(pageNumber),
                delay(EDITOR_RENDER_WAIT_TIMEOUT_MS, { signal: timeoutController.signal }).then(() => {
                    throw new Error(`Timed out waiting for PDF.js editor layer (${reason})`);
                }),
            ]);
            return true;
        } catch (error) {
            BrowserLogger.diagnostic(NOTE_PLACEMENT_LOG_SECTION, 'Timed out waiting for PDF.js editor layer before creating note', {
                attemptId: diagnosticsContext?.attemptId ?? null,
                pageNumber,
                reason,
                error: errorToLogText(error),
            });
            return false;
        } finally {
            timeoutController.abort();
        }
    }

    async function ensureEditorLayerDivReady(
        uiManager: AnnotationEditorUIManager,
        pageNumber: number,
        diagnosticsContext?: INotePlacementDiagnosticsContext,
    ) {
        let layerDiv = getAnnotationEditorLayerDiv(uiManager, pageNumber - 1);
        if (layerDiv) {
            return layerDiv;
        }
        if (!ensureAnnotationEditorLayerReady) {
            return null;
        }

        try {
            await ensureAnnotationEditorLayerReady(pageNumber);
            layerDiv = getAnnotationEditorLayerDiv(uiManager, pageNumber - 1);
            if (layerDiv) {
                return layerDiv;
            }
            await waitForEditorsRenderedWithTimeout(
                uiManager,
                pageNumber,
                'rerender-create',
                diagnosticsContext,
            );
        } catch (error) {
            BrowserLogger.diagnostic(NOTE_PLACEMENT_LOG_SECTION, 'Failed to rerender PDF.js editor layer before creating note', {
                attemptId: diagnosticsContext?.attemptId ?? null,
                pageNumber,
                error: errorToLogText(error),
            });
        }

        layerDiv = getAnnotationEditorLayerDiv(uiManager, pageNumber - 1);
        return layerDiv;
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
        BrowserLogger.diagnostic(NOTE_PLACEMENT_LOG_SECTION, 'Quick-note page mismatch: summary page differs from requested page', {
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
                window.setTimeout(restoreViewerScroll, SCROLL_RESTORE_FALLBACK_DELAY_MS);
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

    function isDeletedEditor(editor: IPdfjsEditor) {
        return typeof editor.comment === 'object'
            && editor.comment !== null
            && editor.comment.deleted === true;
    }

    function pickCreatedEditorCandidate(
        pageIndex: number,
        snapshot: IEditorSnapshot,
        getEditorsForPage: (pageIndex: number) => IPdfjsEditor[],
        getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string,
    ) {
        const editorsAfter = getEditorsForPage(pageIndex).filter(editor => !isDeletedEditor(editor));
        return editorsAfter.find((editor) => {
            if (!snapshot.editorsBeforeRefs.has(editor)) {
                return true;
            }
            return !snapshot.editorsBeforeIds.has(getEditorIdentity(editor, pageIndex));
        }) ?? null;
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
                await waitForEditorsRenderedWithTimeout(
                    uiManager,
                    pageNumber,
                    'resolve-created-editor',
                    diagnosticsContext,
                );
            } catch { /* ignore */ }
            await delay(CREATED_EDITOR_SETTLE_DELAY_MS);
            await nextTick();
            if (!isAnnotationUiManagerCurrent(uiManager)) {
                return null;
            }
            return pickCreatedEditorCandidate(pageIndex, editorSnapshot, getEditorsForPage, identity.getEditorIdentity);
        };

        const previousMode = uiManager.getMode();
        try {
            await switchToAnnotationModeOrThrow(toolManager, uiManager, AnnotationEditorType.FREETEXT, pageNumber);
            if (!isAnnotationUiManagerCurrent(uiManager)) {
                return false;
            }
            const layerDiv = await ensureEditorLayerDivReady(uiManager, pageNumber, diagnosticsContext);
            if (!layerDiv) {
                return false;
            }

            const directlyCreatedEditor = createFreeTextEditorAtPoint(
                uiManager,
                pageIndex,
                layerDiv,
                pageClientPoint.x,
                pageClientPoint.y,
            );
            if (!directlyCreatedEditor) {
                dispatchFreeTextPointer(layerDiv, pageClientPoint.x, pageClientPoint.y);
            }

            const resolvedEditor = await resolveCreatedEditor(directlyCreatedEditor);
            if (!resolvedEditor) {
                return false;
            }

            await preparePointNoteEditor(resolvedEditor, pageIndex, diagnosticsContext);

            const clickMarkerRect = markerRectFromPoint(pageX, pageY);
            syncCommentMarkerAnchorEditor(resolvedEditor, clickMarkerRect);
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
                BrowserLogger.diagnostic(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint threw while creating quick-note annotation', {
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
        stopDrag();
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
        const menuComment = resolveCommentWithRenderedTextMarkupColorAtPoint(
            viewerContainer.value,
            comment,
            clientX,
            clientY,
        );
        return {
            comment: menuComment,
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
        createTextMarkupFromText,
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
