// PDF.js-private highlight executor. Application features consume the thin
// runtime port; raw editors never cross this bridge as retained state.
import { AnnotationEditorType } from '@app/services/pdfjs/runtimeLib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import {
    tryOnScopeDispose,
    useEventListener,
} from '@vueuse/core';
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
import { getCommentText } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/getCommentText';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import { clamp01 } from '@app/modules/pdf-viewer/engine/annotation-geometry/clamp01';
import { errorToLogText } from '@app/modules/pdf-viewer/engine/annotation-css-utils/errorToLogText';
import { BrowserLogger } from '@app/utils/browserLogger';
import { runGuardedTask } from '@app/utils/asyncGuard';
import {
    addUndoableEditorToLayer,
    clearSelectedEditorState,
    createAnnotationEditorAtPoint,
    createAnnotationEditorWithSyntheticPointer,
    dispatchAnnotationEditorPointerTap,
    getActiveEditor,
    getAnnotationEditorLayer,
    getAnnotationEditorLayerDiv,
    getEditorsOnPage,
    getPdfjsEditorFacadeState,
    isEditorCommentDeleted,
    isPdfjsEditorWithEditComment,
} from '@app/modules/pdf-viewer/annotations/bridge/pdfjsAnnotationFacade';
import {
    deleteEditor,
    removeEditor,
} from '@app/services/pdfjs/annotationEditorAdapter';
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
import { useAnnotationTextSelectionCache } from '@app/modules/pdf-viewer/runtime/annotations/useAnnotationTextSelectionCache';
import type { ITextMarkupPresentationController } from '@app/modules/pdf-viewer/runtime/annotations/useTextMarkupPresentationController';

interface IHighlightIdentity {getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;}

interface IHighlightMarkupSubtype {
    toolToMarkupSubtype: Partial<Record<TAnnotationTool, TMarkupSubtype>>;
    isSelectionMarkupTool: (tool: TAnnotationTool) => boolean;
    setEditorMarkupSubtypeOverride: (
        editor: IPdfjsEditor,
        pageIndex: number,
        subtype: TMarkupSubtype,
        options?: { preferEditorColor?: boolean },
    ) => void;
    resolveEditorMarkupSubtypeOverride: (editor: IPdfjsEditor, pageIndex: number) => TMarkupSubtype | null;
    resolveEditorSubtypeFromPresentation: (editor: IPdfjsEditor) => TMarkupSubtype | null;
}

interface IHighlightSync {
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
    isActive: {value: boolean};
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    numPages: {value: number};
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    getIdentity: () => IHighlightIdentity;
    getMarkupSubtype: () => IHighlightMarkupSubtype;
    getSync: () => IHighlightSync;
    getToolManager: () => IHighlightToolManager;
    textMarkupPresentation: ITextMarkupPresentationController;
    annotationIntentSink: {
        submitSelectionMarkupIntent: (input: {
            pageIndex: number;
            requestedSubtype: TMarkupSubtype | null;
            geometry: readonly IAnnotationMarkerRect[];
            observedEditors: ReadonlyArray<{
                summary: IAnnotationCommentSummary;
                subtype: TMarkupSubtype;
                geometry: readonly IAnnotationMarkerRect[];
            }>;
        }) => {
            annotationId: string;
            subtype: TMarkupSubtype;
            comment: IAnnotationCommentSummary;
            replacements: ReadonlyArray<{
                annotationId: string;
                sourceStableKey: string;
                geometry: readonly IAnnotationMarkerRect[];
                deleted: boolean;
            }>;
        };
        submitStickyNoteIntent: (input: {
            pageIndex: number;
            anchor: IAnnotationMarkerRect;
        }) => {
            annotationId: string;
            comment: IAnnotationCommentSummary;
        };
        bindProjectedEditorIdentity: (
            annotationId: string,
            summary: IAnnotationCommentSummary,
        ) => void;
    };
    ensureAnnotationEditorLayerReady?: (pageNumber: number) => Promise<void>;
    deferCreatedEditorUndoToStorage?: boolean;
    stopDrag: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationNotePlacementChange: (active: boolean) => void;
}

interface IEditorSnapshot {editorsBeforeIds: Set<string>;}

const ANNOTATION_EDITOR_RETRY_ATTEMPTS = 12;
const ANNOTATION_EDITOR_RETRY_DELAY_MS = 80;
const SELECTION_CLEAR_FALLBACK_DELAY_MS = 80;
const CREATED_EDITOR_SETTLE_DELAY_MS = 60;

export const useAnnotationHighlight = (options: IUseAnnotationHighlightOptions) => {
    const {
        viewerContainer,
        isActive,
        annotationUiManager,
        numPages,
        currentPage,
        annotationTool,
        getIdentity,
        getMarkupSubtype,
        getSync,
        getToolManager,
        textMarkupPresentation,
        annotationIntentSink,
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
    const {
        cacheCurrentTextSelection,
        clearSelectionCache,
        getPageNumberForTextLayer,
        getSelectionRangeForCommentAction,
        resolveTextLayerForRange,
        restoreSelectionRange,
    } = useAnnotationTextSelectionCache({
        viewerContainer,
        currentPage,
    });

    function isAnnotationUiManagerCurrent(uiManager: AnnotationEditorUIManager) {
        return annotationUiManager.value === uiManager;
    }

    const subtypeRetryTimers = new Set<ReturnType<typeof setTimeout>>();

    tryOnScopeDispose(() => {
        subtypeRetryTimers.forEach(timer => clearTimeout(timer));
        subtypeRetryTimers.clear();
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

    function markerRectsFromBoxes(boxes: readonly IPdfjsHighlightBox[]) {
        return boxes.map(box => ({
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height,
        }));
    }

    function boxesFromMarkerRects(rects: readonly IAnnotationMarkerRect[]) {
        return rects.map(rect => ({
            x: rect.left,
            y: rect.top,
            width: rect.width,
            height: rect.height,
        }));
    }

    function getEditorMarkupBoxes(editor: IPdfjsEditor) {
        const editorState = getPdfjsEditorFacadeState(editor);
        if (editorState.markupBoxes?.length) {
            return editorState.markupBoxes;
        }
        if (
            Number.isFinite(editor.x)
            && Number.isFinite(editor.y)
            && Number.isFinite(editor.width)
            && Number.isFinite(editor.height)
            && (editor.width ?? 0) > 0
            && (editor.height ?? 0) > 0
        ) {
            return [{
                x: editor.x!,
                y: editor.y!,
                width: editor.width!,
                height: editor.height!,
            }];
        }
        return null;
    }

    function removeProjectedEditor(editor: IPdfjsEditor) {
        try {
            if (!removeEditor(editor)) {
                deleteEditor(editor);
            }
        } catch (error) {
            BrowserLogger.debug('annotations', `Failed to remove replaced markup editor: ${errorToLogText(error)}`);
        }
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
        getPdfjsEditorFacadeState(editor).selectionText = previewText;
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
        clearSelectionCache();

        const previousMode = uiManager.getMode();
        const observedEditors = getEditorsForPage(pageIndex).flatMap((editor) => {
            const observedSubtype = markupSubtype.resolveEditorMarkupSubtypeOverride(editor, pageIndex)
                ?? markupSubtype.resolveEditorSubtypeFromPresentation(editor);
            const editorBoxes = getEditorMarkupBoxes(editor);
            if (!observedSubtype || !editorBoxes) {
                return [];
            }
            return [{
                editor,
                summary: commentSync.toEditorSummary(editor, pageIndex, getCommentText(editor)),
                subtype: observedSubtype,
                geometry: markerRectsFromBoxes(editorBoxes),
            }];
        });
        const canonicalPlan = annotationIntentSink.submitSelectionMarkupIntent({
            pageIndex,
            requestedSubtype: selectionOptions.markupSubtype ?? null,
            geometry: markerRectsFromBoxes(boxes),
            observedEditors: observedEditors.map(candidate => ({
                summary: candidate.summary,
                subtype: candidate.subtype,
                geometry: candidate.geometry,
            })),
        });
        const projectedSubtype = canonicalPlan.subtype;
        const createdAnnotation = true;
        let editorSnapshot = captureEditorSnapshot(pageIndex, getEditorsForPage, identity.getEditorIdentity);

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
        const bindCanonicalEditor = (editor: IPdfjsEditor | null, annotationId: string) => {
            if (!editor || !isAnnotationUiManagerCurrent(uiManager)) {
                return false;
            }
            getPdfjsEditorFacadeState(editor).canonicalAnnotationId = annotationId;
            annotationIntentSink.bindProjectedEditorIdentity(
                annotationId,
                commentSync.toEditorSummary(editor, pageIndex, getCommentText(editor)),
            );
            return true;
        };
        const applySubtypeOverrideToEditor = (editor: IPdfjsEditor | null) => {
            if (!editor || !isAnnotationUiManagerCurrent(uiManager)) {
                return false;
            }
            attachSelectionPreviewText(editor, selectionPreviewText);
            getPdfjsEditorFacadeState(editor).markupBoxes = cloneHighlightBoxes(boxes);
            markupSubtype.setEditorMarkupSubtypeOverride(
                editor,
                pageIndex,
                projectedSubtype,
                { preferEditorColor: false },
            );
            textMarkupPresentation.notify({kind: 'editors-changed'});
            return true;
        };

        const clearEditorSelectionVisuals = (editor: IPdfjsEditor | null) => {
            if (!isAnnotationUiManagerCurrent(uiManager)) {
                return;
            }
            const editorElement = editor?.div ?? null;
            clearSelectedEditorState(uiManager);

            const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
                editorElement?.classList.remove('selectedEditor', 'selected');
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
                return createdAnnotation;
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
                    if (getPdfjsEditorFacadeState(editor).creationHistoryRegistered) {
                        undoRegistered = true;
                        return true;
                    }
                    const activeLayer = getAnnotationEditorLayer(uiManager, pageIndex) ?? layer ?? editor.parent ?? null;
                    if (!addUndoableEditorToLayer(activeLayer, editor)) {
                        return false;
                    }
                    getPdfjsEditorFacadeState(editor).creationHistoryRegistered = true;
                    undoRegistered = true;
                    return true;
                } catch (error) {
                    BrowserLogger.warn('annotations', `Failed to register created text markup undo command: ${errorToLogText(error)}`);
                    return false;
                }
            };
            canonicalPlan.replacements.forEach((replacement) => {
                const source = observedEditors.find(candidate => (
                    candidate.summary.stableKey === replacement.sourceStableKey
                ))?.editor;
                if (!source) {
                    return;
                }
                if (!replacement.deleted && replacement.geometry.length > 0) {
                    const replacementBoxes = boxesFromMarkerRects(replacement.geometry);
                    const replacementEditor = createAnnotationEditorWithSyntheticPointer(layer, {
                        methodOfCreation: 'toolbar',
                        boxes: replacementBoxes,
                        color: source.color,
                        opacity: source.opacity,
                        text: '',
                    });
                    if (replacementEditor) {
                        const replacementState = getPdfjsEditorFacadeState(replacementEditor);
                        replacementState.markupBoxes = replacementBoxes;
                        replacementState.markupSubtypeColor
                            = getPdfjsEditorFacadeState(source).markupSubtypeColor ?? null;
                        markupSubtype.setEditorMarkupSubtypeOverride(
                            replacementEditor,
                            pageIndex,
                            projectedSubtype,
                        );
                        bindCanonicalEditor(replacementEditor, replacement.annotationId);
                    }
                }
                removeProjectedEditor(source);
            });
            editorSnapshot = captureEditorSnapshot(pageIndex, getEditorsForPage, identity.getEditorIdentity);
            const createdEditor = createAnnotationEditorWithSyntheticPointer(layer, {
                methodOfCreation: 'toolbar',
                boxes,
                anchorNode: startContainer,
                anchorOffset: startOffset,
                focusNode: endContainer,
                focusOffset: endOffset,
                text,
            });
            const targetEditor = await resolveCreatedEditor(createdEditor);
            registerCreatedEditorUndo(targetEditor);
            attachSelectionPreviewText(targetEditor, selectionPreviewText);
            applySubtypeOverrideToEditor(targetEditor);
            bindCanonicalEditor(targetEditor, canonicalPlan.annotationId);

            if (!targetEditor) {
                let attempts = 0;
                const hydrateEditorLater = () => {
                    if (!isAnnotationUiManagerCurrent(uiManager)) {
                        return;
                    }
                    const lateEditor = pickCreatedEditorCandidate(pageIndex, editorSnapshot, getEditorsForPage, identity.getEditorIdentity);
                    registerCreatedEditorUndo(lateEditor);
                    attachSelectionPreviewText(lateEditor, selectionPreviewText);
                    applySubtypeOverrideToEditor(lateEditor);
                    if (bindCanonicalEditor(lateEditor, canonicalPlan.annotationId)) {
                        return;
                    }
                    attempts += 1;
                    if (attempts < ANNOTATION_EDITOR_RETRY_ATTEMPTS) {
                        scheduleSubtypeRetry(hydrateEditorLater, ANNOTATION_EDITOR_RETRY_DELAY_MS);
                    }
                };
                scheduleSubtypeRetry(hydrateEditorLater, ANNOTATION_EDITOR_RETRY_DELAY_MS);
            }

            clearEditorSelectionVisuals(targetEditor);
        } catch (error) {
            BrowserLogger.warn('annotations', `Failed to highlight selection: ${errorToLogText(error)}`);
        }

        if (createdAnnotation) {
            toolManager.maybeAutoResetAnnotationTool();
        }

        await restoreHighlightModeAfterSelection(toolManager, uiManager, previousMode, pageNumber);

        if (withComment && isAnnotationUiManagerCurrent(uiManager)) {
            emitAnnotationOpenNote(canonicalPlan.comment);
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

    function keepFreeTextEditorAlive(editor: IPdfjsEditor) {
        const editorDiv = editor.div?.querySelector<HTMLElement>('[contenteditable]')
            ?? ('editorDiv' in editor && editor.editorDiv instanceof HTMLElement ? editor.editorDiv : undefined);
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

    function preparePointNoteEditor(
        editor: IPdfjsEditor,
        pageIndex: number,
        diagnosticsContext?: INotePlacementDiagnosticsContext,
    ) {
        markCommentMarkerAnchorEditor(editor);
        keepFreeTextEditorAlive(editor);
        enforceMinimumNoteEditorSize(editor);
        const editorState = getPdfjsEditorFacadeState(editor);
        editorState.resolvedPageIndex = pageIndex;
        editorState.placementAttemptId = diagnosticsContext?.attemptId ?? null;
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
            case undefined:
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

    function pinViewerScrollAroundEditorComment(editor: IPdfjsEditor) {
        if (!isPdfjsEditorWithEditComment(editor)) {
            return;
        }
        editor.editComment();
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
        return {editorsBeforeIds: new Set<string>(editorsBefore.map(editor => getEditorIdentity(editor, pageIndex)))};
    }

    function isDeletedEditor(editor: IPdfjsEditor) {
        return isEditorCommentDeleted(editor);
    }

    function pickCreatedEditorCandidate(
        pageIndex: number,
        snapshot: IEditorSnapshot,
        getEditorsForPage: (pageIndex: number) => IPdfjsEditor[],
        getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string,
    ) {
        const editorsAfter = getEditorsForPage(pageIndex).filter(editor => !isDeletedEditor(editor));
        return editorsAfter.find(editor => (
            !snapshot.editorsBeforeIds.has(getEditorIdentity(editor, pageIndex))
        )) ?? null;
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
        const clickMarkerRect = markerRectFromPoint(pageX, pageY);
        if (!clickMarkerRect) {
            return false;
        }
        const canonicalNote = annotationIntentSink.submitStickyNoteIntent({
            pageIndex,
            anchor: clickMarkerRect,
        });
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
        const prepareCreatedEditor = async (createdEditor: IPdfjsEditor | null) => {
            const editor = await resolveCreatedEditor(createdEditor);
            if (!editor) {
                return null;
            }
            preparePointNoteEditor(editor, pageIndex, diagnosticsContext);
            return editor;
        };
        const bindCanonicalPointEditor = (editor: IPdfjsEditor | null) => {
            if (!editor || !isAnnotationUiManagerCurrent(uiManager)) {
                return false;
            }
            getPdfjsEditorFacadeState(editor).canonicalAnnotationId = canonicalNote.annotationId;
            annotationIntentSink.bindProjectedEditorIdentity(
                canonicalNote.annotationId,
                commentSync.toEditorSummary(editor, pageIndex, getCommentText(editor)),
            );
            return true;
        };

        const previousMode = uiManager.getMode();
        let preparedEditor: IPdfjsEditor | null = null;
        try {
            await switchToAnnotationModeOrThrow(toolManager, uiManager, AnnotationEditorType.FREETEXT, pageNumber);
            if (isAnnotationUiManagerCurrent(uiManager)) {
                const layerDiv = await ensureEditorLayerDivReady(uiManager, pageNumber, diagnosticsContext);
                if (layerDiv) {
                    const directlyCreatedEditor = createAnnotationEditorAtPoint(
                        uiManager,
                        pageIndex,
                        layerDiv,
                        pageClientPoint.x,
                        pageClientPoint.y,
                    );
                    if (!directlyCreatedEditor) {
                        dispatchAnnotationEditorPointerTap(layerDiv, pageClientPoint.x, pageClientPoint.y);
                    }
                    preparedEditor = await prepareCreatedEditor(directlyCreatedEditor);
                    if (preparedEditor && isAnnotationUiManagerCurrent(uiManager)) {
                        syncCommentMarkerAnchorEditor(preparedEditor, clickMarkerRect);
                        bindCanonicalPointEditor(preparedEditor);
                    }
                }
            }
        } catch (error) {
            BrowserLogger.diagnostic(NOTE_PLACEMENT_LOG_SECTION, 'Point-note projection failed after canonical creation', {
                attemptId: diagnosticsContext?.attemptId ?? null,
                pageNumber,
                error: errorToLogText(error),
            });
        } finally {
            await restorePreviousAnnotationMode(toolManager, uiManager, previousMode, pageNumber);
        }
        if (!preparedEditor) {
            let attempts = 0;
            const bindLateEditor = () => {
                const lateEditor = pickCreatedEditorCandidate(
                    pageIndex,
                    editorSnapshot,
                    getEditorsForPage,
                    identity.getEditorIdentity,
                );
                if (lateEditor) {
                    preparePointNoteEditor(lateEditor, pageIndex, diagnosticsContext);
                    syncCommentMarkerAnchorEditor(lateEditor, clickMarkerRect);
                    bindCanonicalPointEditor(lateEditor);
                    return;
                }
                attempts += 1;
                if (attempts < ANNOTATION_EDITOR_RETRY_ATTEMPTS) {
                    scheduleSubtypeRetry(bindLateEditor, ANNOTATION_EDITOR_RETRY_DELAY_MS);
                }
            };
            scheduleSubtypeRetry(bindLateEditor, ANNOTATION_EDITOR_RETRY_DELAY_MS);
            emitAnnotationOpenNote(canonicalNote.comment);
        } else {
            openPointNoteSummary(preparedEditor, canonicalNote.comment);
        }
        return true;
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
        const enrichedDiagnosticsContext: INotePlacementDiagnosticsContext = {
            ...diagnosticsContext,
            attemptId,
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
        return created;
    }

    function handleDocumentPointerUp(event: PointerEvent) {
        if (event.button !== 0) {
            return;
        }
        runGuardedTask(() => maybeApplySelectionMarkup(), {
            category: 'user-visible-operation',
            scope: 'annotations',
            message: 'Failed to apply selection markup on pointer up',
        });
    }

    const documentTarget = typeof document !== 'undefined' ? document : null;
    useEventListener(
        documentTarget,
        'selectionchange',
        () => {
            if (isActive.value) {
                cacheCurrentTextSelection();
            }
        },
        { passive: true },
    );
    useEventListener(
        documentTarget,
        'pointerup',
        (event) => {
            if (isActive.value && event instanceof PointerEvent) {
                handleDocumentPointerUp(event);
            }
        },
        { passive: true },
    );

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
        maybeApplySelectionMarkup,
        buildAnnotationContextMenuPayload,
        resolvePagePointTarget,
        findPageContainerFromClientPoint,
        clearSelectionCache,
        highlightSelectionInternal,
    };
};
