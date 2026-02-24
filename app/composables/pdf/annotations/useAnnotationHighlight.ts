import {
    AnnotationEditorType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import {
    nextTick,
    ref,
    type Ref,
    type ShallowRef,
} from 'vue';
import {
    useTimeoutFn,
    tryOnScopeDispose,
} from '@vueuse/core';
import { delay } from 'es-toolkit/promise';
import type {
    IAnnotationCommentSummary,
    TAnnotationTool,
    TMarkupSubtype,
    IPdfjsEditor,
    IAnnotationContextMenuPayload,
    IPagePointTarget,
} from '@app/composables/pdf/annotations/types';
import { markerRectCenterDistance } from '@app/composables/pdf/annotations/types';
import {
    getCommentText,
    errorToLogText,
    clamp01,
    normalizeMarkerRect,
    toMarkerRectFromEditor,
} from '@app/composables/pdf/pdfAnnotationUtils';
import { SELECTION_CACHE_TTL_MS } from '@app/constants/timeouts';
import { BrowserLogger } from '@app/utils/browser-logger';
import { runGuardedTask } from '@app/utils/async-guard';

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

interface IGeometryResolution {
    pageContainer: HTMLElement | null;
    source: 'inside' | 'nearest' | 'none';
    candidates: IPageCandidateLogEntry[] | null;
}

export function useAnnotationHighlight(options: IUseAnnotationHighlightOptions) {
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

    const { stop: stopSubtypeRetry } = useTimeoutFn(() => {}, 0, { immediate: false });

    tryOnScopeDispose(() => {
        stopSubtypeRetry();
        cachedSelectionRange = null;
    });

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

    async function highlightSelectionInternal(withComment: boolean, explicitRange: Range | null = null): Promise<boolean> {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return false;
        }

        const identity = getIdentity();
        const markupSubtype = getMarkupSubtype();
        const commentSync = getSync();
        const toolManager = getToolManager();

        let selection = document.getSelection();
        const activeRange = explicitRange?.cloneRange() ?? getSelectionRangeForCommentAction();
        if (!activeRange) {
            return false;
        }

        try {
            selection = document.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(activeRange.cloneRange());
        } catch (error) {
            BrowserLogger.debug('annotations', `Failed to restore current text selection: ${errorToLogText(error)}`);
        }

        const {
            startContainer,
            startOffset,
            endContainer,
            endOffset,
            commonAncestorContainer,
        } = activeRange;
        const text = activeRange.toString();

        const anchorElement = startContainer.nodeType === Node.TEXT_NODE
            ? startContainer.parentElement
            : (startContainer as HTMLElement | null);
        const commonAncestorElement = commonAncestorContainer.nodeType === Node.TEXT_NODE
            ? commonAncestorContainer.parentElement
            : (commonAncestorContainer as HTMLElement | null);
        const textLayer = (anchorElement?.closest('.text-layer, .textLayer')
            ?? commonAncestorElement?.closest('.text-layer, .textLayer')) as HTMLElement | null;
        if (!textLayer) {
            return false;
        }

        const boxes = uiManager.getSelectionBoxes(textLayer);
        if (!boxes) {
            return false;
        }

        const pageContainer = textLayer.closest<HTMLElement>('.page_container');
        const pageNumber = pageContainer?.dataset.page
            ? Number(pageContainer.dataset.page)
            : currentPage.value;
        const pageIndex = Math.max(0, pageNumber - 1);

        const editorsBefore = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
        const editorsBeforeRefs = new Set<IPdfjsEditor>(editorsBefore);
        const editorsBeforeIds = new Set<string>(editorsBefore.map(editor => identity.getEditorIdentity(editor, pageIndex)));

        selection?.removeAllRanges();
        cachedSelectionRange = null;
        cachedSelectionTimestamp = 0;

        const previousMode = uiManager.getMode();
        const markupSubtypeOverride = markupSubtype.TOOL_TO_MARKUP_SUBTYPE[annotationTool.value] ?? null;
        let createdAnnotation = false;
        let deferredNoteSummary: IAnnotationCommentSummary | null = null;
        let modeRestoredResolve: () => void = () => {};
        const modeRestoredPromise = new Promise<void>((resolve) => { modeRestoredResolve = resolve; });

        const pickCreatedEditorCandidate = () => {
            const editorsAfter = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
            return editorsAfter.find((editor) => {
                if (!editorsBeforeRefs.has(editor)) {
                    return true;
                }
                const editorIdentity = identity.getEditorIdentity(editor, pageIndex);
                return !editorsBeforeIds.has(editorIdentity);
            }) ?? editorsAfter.at(-1) ?? null;
        };

        const resolveCreatedEditor = async (createdEditor: IPdfjsEditor | null) => {
            if (createdEditor) {
                return createdEditor;
            }
            const activeEditor = (uiManager as AnnotationEditorUIManager & { getActive?: () => unknown })
                .getActive?.() as IPdfjsEditor | null | undefined;
            if (activeEditor) {
                return activeEditor;
            }
            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch (error) {
                BrowserLogger.debug('annotations', `Editor render wait failed while resolving created highlight: ${errorToLogText(error)}`);
            }
            await nextTick();
            return pickCreatedEditorCandidate();
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
            const managerWithSelection = uiManager as AnnotationEditorUIManager & {
                unselectAll?: () => void;
                setSelected?: (editor: unknown) => void;
            };
            managerWithSelection.unselectAll?.();
            try {
                managerWithSelection.setSelected?.(null);
            } catch (error) {
                BrowserLogger.debug('annotations', `Failed to clear selected editor via uiManager: ${errorToLogText(error)}`);
            }

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
            const highlightModeError = await toolManager.updateModeWithRetry(uiManager, AnnotationEditorType.HIGHLIGHT, pageNumber);
            if (highlightModeError) {
                throw highlightModeError;
            }
            await uiManager.waitForEditorsRendered(pageNumber);

            const layer = uiManager.getLayer(pageNumber - 1) ?? uiManager.currentLayer;
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
            const targetEditor = await resolveCreatedEditor((createdEditor ?? null) as IPdfjsEditor | null);
            applySubtypeOverrideToEditor(targetEditor);

            if (!targetEditor && !withComment && markupSubtypeOverride) {
                let attempts = 0;
                const applySubtypeLater = () => {
                    const lateEditor = pickCreatedEditorCandidate();
                    if (applySubtypeOverrideToEditor(lateEditor)) {
                        return;
                    }
                    attempts += 1;
                    if (attempts < 12) {
                        const { start } = useTimeoutFn(applySubtypeLater, 80, { immediate: false });
                        start();
                    }
                };
                const { start } = useTimeoutFn(applySubtypeLater, 80, { immediate: false });
                start();
            }

            if (withComment) {
                if (targetEditor) {
                    commentSync.pendingCommentEditorKeys.add(identity.getEditorPendingKey(targetEditor, pageIndex));
                    deferredNoteSummary = commentSync.toEditorSummary(targetEditor, pageIndex, getCommentText(targetEditor));
                    clearEditorSelectionVisuals(targetEditor);
                } else {
                    let attempts = 0;
                    const tryEmitLater = () => {
                        const lateEditor = pickCreatedEditorCandidate();
                        if (!lateEditor) {
                            attempts += 1;
                            if (attempts < 12) {
                                const { start } = useTimeoutFn(tryEmitLater, 80, { immediate: false });
                                start();
                            }
                            return;
                        }
                        applySubtypeOverrideToEditor(lateEditor);
                        commentSync.pendingCommentEditorKeys.add(identity.getEditorPendingKey(lateEditor, pageIndex));
                        const summary = commentSync.toEditorSummary(lateEditor, pageIndex, getCommentText(lateEditor));
                        clearEditorSelectionVisuals(lateEditor);
                        void modeRestoredPromise.then(() => {
                            emitAnnotationOpenNote(summary);
                        });
                    };
                    const { start } = useTimeoutFn(tryEmitLater, 80, { immediate: false });
                    start();
                }
            }
        } catch (error) {
            BrowserLogger.warn('annotations', `Failed to highlight selection: ${errorToLogText(error)}`);
            modeRestoredResolve();
        }

        if (createdAnnotation) {
            toolManager.maybeAutoResetAnnotationTool();
        }

        const restoreModeError = await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
        if (restoreModeError) {
            BrowserLogger.warn('annotations', 'Failed to restore annotation mode', restoreModeError);
        }

        modeRestoredResolve();

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
            return {
                pageContainer: null,
                source: 'none',
                candidates: collectCandidates ? [] : null,
            };
        }
        const pages = Array.from(container.querySelectorAll<HTMLElement>('.page_container'));
        if (pages.length === 0) {
            return {
                pageContainer: null,
                source: 'none',
                candidates: collectCandidates ? [] : null,
            };
        }

        let nearest: {
            element: HTMLElement;
            distanceSquared: number
        } | null = null;
        let insideMatch: HTMLElement | null = null;
        const candidates: IPageCandidateLogEntry[] = [];

        for (const element of pages) {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                continue;
            }
            const inside = (
                clientX >= rect.left
                && clientX <= rect.right
                && clientY >= rect.top
                && clientY <= rect.bottom
            );
            const dx = clientX < rect.left
                ? rect.left - clientX
                : (clientX > rect.right ? clientX - rect.right : 0);
            const dy = clientY < rect.top
                ? rect.top - clientY
                : (clientY > rect.bottom ? clientY - rect.bottom : 0);
            const distanceSquared = dx * dx + dy * dy;
            if (collectCandidates && candidates.length < MAX_PAGE_CANDIDATE_LOG_ENTRIES) {
                candidates.push({
                    pageNumber: parsePageNumberFromContainer(element),
                    inside,
                    distanceSquared: roundForLog(distanceSquared),
                    rect: toRectLog(rect),
                });
            }
            if (inside && !collectCandidates) {
                return {
                    pageContainer: element,
                    source: 'inside',
                    candidates: null,
                };
            }
            if (inside && !insideMatch) {
                insideMatch = element;
            }
            if (!nearest || distanceSquared < nearest.distanceSquared) {
                nearest = {
                    element,
                    distanceSquared,
                };
            }
        }

        if (insideMatch) {
            return {
                pageContainer: insideMatch,
                source: 'inside',
                candidates: collectCandidates ? candidates : null,
            };
        }
        if (nearest) {
            return {
                pageContainer: nearest.element,
                source: 'nearest',
                candidates: collectCandidates ? candidates : null,
            };
        }
        return {
            pageContainer: null,
            source: 'none',
            candidates: collectCandidates ? candidates : null,
        };
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
        if (!pageContainer || !container.contains(pageContainer)) {
            return null;
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

    function resolvePagePointTarget(
        clientX: number,
        clientY: number,
        targetElement?: HTMLElement | null,
        diagnostics?: INotePlacementDiagnosticsContext,
    ): IPagePointTarget | null {
        const targetPageContainer = resolvePageContainerFromTarget(targetElement);
        const documentPointResolution = resolvePageContainerFromDocumentPoint(clientX, clientY);
        const geometryResolution = resolvePageContainerByGeometry(clientX, clientY, {collectCandidates: Boolean(diagnostics)});
        const byTargetPage = parsePageNumberFromContainer(targetPageContainer);
        const byElementFromPointPage = parsePageNumberFromContainer(documentPointResolution.pageContainer);
        const byGeometryPage = parsePageNumberFromContainer(geometryResolution.pageContainer);

        const targetConflictsWithElementPoint = (
            byTargetPage !== null
            && byElementFromPointPage !== null
            && byTargetPage !== byElementFromPointPage
        );
        const targetConflictsWithGeometry = (
            byTargetPage !== null
            && byGeometryPage !== null
            && byTargetPage !== byGeometryPage
        );
        const hasTargetConflict = targetConflictsWithElementPoint || targetConflictsWithGeometry;

        let pageContainer: HTMLElement | null = null;
        let selectedSource = 'none';
        if (targetPageContainer && !hasTargetConflict) {
            pageContainer = targetPageContainer;
            selectedSource = 'target-element';
        }
        else if (documentPointResolution.pageContainer) {
            pageContainer = documentPointResolution.pageContainer;
            selectedSource = 'document.elementFromPoint';
        }
        else if (geometryResolution.pageContainer) {
            pageContainer = geometryResolution.pageContainer;
            selectedSource = geometryResolution.source === 'inside'
                ? 'geometry-inside'
                : 'geometry-nearest';
        }
        else if (targetPageContainer) {
            pageContainer = targetPageContainer;
            selectedSource = 'target-element-conflicted-fallback';
        }

        if (diagnostics && hasTargetConflict) {
            const viewer = viewerContainer.value;
            BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Quick-note page target conflict detected', {
                attemptId: diagnostics.attemptId ?? null,
                source: diagnostics.source ?? null,
                selectedSource,
                byTargetPage,
                byElementFromPointPage,
                byGeometryPage,
                targetConflictsWithElementPoint,
                targetConflictsWithGeometry,
                clickTarget: summarizeElementForLog(targetElement ?? null),
                pointElement: summarizeElementForLog(documentPointResolution.pointElement),
                renderedPageCandidates: geometryResolution.candidates,
                visiblePageWindow: summarizeVisiblePageWindowForLog(),
                viewerScrollTop: viewer?.scrollTop ?? null,
                viewerScrollLeft: viewer?.scrollLeft ?? null,
                clickMeta: diagnostics.clickMeta ?? null,
            });
        }

        if (!pageContainer) {
            if (diagnostics) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Failed to resolve quick-note page container', {
                    attemptId: diagnostics.attemptId ?? null,
                    source: diagnostics.source ?? null,
                    clientX: roundForLog(clientX),
                    clientY: roundForLog(clientY),
                    currentPage: currentPage.value,
                    byTargetPage,
                    byElementFromPointPage,
                    byGeometryPage,
                    selectedSource,
                    clickTarget: summarizeElementForLog(targetElement ?? null),
                    pointElement: summarizeElementForLog(documentPointResolution.pointElement),
                    renderedPageCandidates: geometryResolution.candidates,
                    visiblePageWindow: summarizeVisiblePageWindowForLog(),
                    clickMeta: diagnostics.clickMeta ?? null,
                });
            }
            return null;
        }
        const rect = pageContainer.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            if (diagnostics) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note page container has invalid rect', {
                    attemptId: diagnostics.attemptId ?? null,
                    selectedSource,
                    pageNumberFromDataset: pageContainer.dataset.page ?? null,
                    rect: toRectLog(rect),
                });
            }
            return null;
        }
        const pageNumber = pageContainer.dataset.page
            ? Number(pageContainer.dataset.page)
            : currentPage.value;
        if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
            if (diagnostics) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note page container has invalid page number', {
                    attemptId: diagnostics.attemptId ?? null,
                    selectedSource,
                    datasetPage: pageContainer.dataset.page ?? null,
                    fallbackCurrentPage: currentPage.value,
                });
            }
            return null;
        }
        const pageX = clamp01((clientX - rect.left) / rect.width);
        const pageY = clamp01((clientY - rect.top) / rect.height);
        if (diagnostics) {
            BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note target page', {
                attemptId: diagnostics.attemptId ?? null,
                source: diagnostics.source ?? null,
                selectedSource,
                pageNumber,
                pageX: roundForLog(pageX, 4),
                pageY: roundForLog(pageY, 4),
                byTargetPage,
                byElementFromPointPage,
                byGeometryPage,
                hasTargetConflict,
                clickTarget: summarizeElementForLog(targetElement ?? null),
                pointElement: summarizeElementForLog(documentPointResolution.pointElement),
                renderedPageCandidates: geometryResolution.candidates,
                visiblePageWindow: summarizeVisiblePageWindowForLog(),
                clickMeta: diagnostics.clickMeta ?? null,
            });
        }
        return {
            pageContainer,
            pageNumber,
            pageX,
            pageY,
        };
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
            const inside = targetX >= rect.left && targetX <= rect.right && targetY >= rect.top && targetY <= rect.bottom;
            const dx = inside ? 0 : Math.min(Math.abs(targetX - rect.left), Math.abs(targetX - rect.right));
            const dy = inside ? 0 : Math.min(Math.abs(targetY - rect.top), Math.abs(targetY - rect.bottom));
            const score = (dx * dx) + (dy * dy);
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

    function resolveWordOffsets(text: string, seedOffset: number) {
        const length = text.length;
        if (length <= 0) {
            return null;
        }

        let offset = Math.max(0, Math.min(length - 1, seedOffset));
        if (/\s/.test(text[offset] ?? '')) {
            let left = offset - 1;
            let right = offset + 1;
            while (left >= 0 || right < length) {
                if (left >= 0 && !/\s/.test(text[left] ?? '')) {
                    offset = left;
                    break;
                }
                if (right < length && !/\s/.test(text[right] ?? '')) {
                    offset = right;
                    break;
                }
                left -= 1;
                right += 1;
            }
        }

        let start = offset;
        let end = Math.min(length, offset + 1);
        while (start > 0 && !/\s/.test(text[start - 1] ?? '')) {
            start -= 1;
        }
        while (end < length && !/\s/.test(text[end] ?? '')) {
            end += 1;
        }

        if (start === end) {
            end = Math.min(length, start + 1);
        }
        return {
            start,
            end, 
        };
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
            if (diagnosticsContext) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint aborted: viewer container or uiManager is missing', {
                    attemptId: diagnosticsContext.attemptId ?? null,
                    pageNumber,
                    pageX: roundForLog(pageX, 4),
                    pageY: roundForLog(pageY, 4),
                    hasContainer: Boolean(container),
                    hasUiManager: Boolean(uiManager),
                });
            }
            return false;
        }

        const identity = getIdentity();
        const commentSync = getSync();
        const toolManager = getToolManager();

        const pageContainer = container.querySelector<HTMLElement>(`.page_container[data-page="${pageNumber}"]`);
        if (!pageContainer) {
            if (diagnosticsContext) {
                const visiblePageWindow = summarizeVisiblePageWindowForLog();
                const renderedPages = Array.from(container.querySelectorAll<HTMLElement>('.page_container'))
                    .slice(0, MAX_PAGE_CANDIDATE_LOG_ENTRIES)
                    .map((page) => ({
                        pageNumber: parsePageNumberFromContainer(page),
                        rect: toRectLog(page.getBoundingClientRect()),
                    }));
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint aborted: requested page is not currently rendered', {
                    attemptId: diagnosticsContext.attemptId ?? null,
                    requestedPageNumber: pageNumber,
                    currentPage: currentPage.value,
                    renderedPages,
                    visiblePageWindow,
                    viewerScrollTop: roundForLog(container.scrollTop),
                    viewerScrollLeft: roundForLog(container.scrollLeft),
                });
            }
            return false;
        }
        const pageRect = pageContainer.getBoundingClientRect();
        const pageClientX = pageRect.left + clamp01(pageX) * pageRect.width;
        const pageClientY = pageRect.top + clamp01(pageY) * pageRect.height;
        if (diagnosticsContext) {
            BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint started', {
                attemptId: diagnosticsContext.attemptId ?? null,
                source: diagnosticsContext.source ?? null,
                requestedPageNumber: pageNumber,
                pageRect: toRectLog(pageRect),
                pageX: roundForLog(pageX, 4),
                pageY: roundForLog(pageY, 4),
                pageClientX: roundForLog(pageClientX),
                pageClientY: roundForLog(pageClientY),
                currentPage: currentPage.value,
                visiblePageWindow: summarizeVisiblePageWindowForLog(),
                clickMeta: diagnosticsContext.clickMeta ?? null,
            });
        }

        if (pointOptions.preferTextAnchor ?? true) {
            const range = buildRangeFromPagePoint({
                pageContainer,
                pageNumber,
                pageX: clamp01(pageX),
                pageY: clamp01(pageY),
            });
            if (range) {
                const created = await highlightSelectionInternal(true, range);
                if (created) {
                    if (diagnosticsContext) {
                        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint completed via text-anchor path', {
                            attemptId: diagnosticsContext.attemptId ?? null,
                            pageNumber,
                        });
                    }
                    return true;
                }
            }
        }

        const pageIndex = Math.max(0, pageNumber - 1);
        const editorsBefore = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
        const editorsBeforeRefs = new Set<IPdfjsEditor>(editorsBefore);
        const editorsBeforeIds = new Set<string>(editorsBefore.map(editor => identity.getEditorIdentity(editor, pageIndex)));

        const pickCreatedEditorCandidate = () => {
            const editorsAfter = Array.from(uiManager.getEditors(pageIndex)) as IPdfjsEditor[];
            return editorsAfter.find((editor) => {
                if (!editorsBeforeRefs.has(editor)) {
                    return true;
                }
                return !editorsBeforeIds.has(identity.getEditorIdentity(editor, pageIndex));
            }) ?? editorsAfter.at(-1) ?? null;
        };

        const resolveCreatedEditor = async (createdEditor: IPdfjsEditor | null) => {
            if (createdEditor) {
                return createdEditor;
            }
            const immediate = pickCreatedEditorCandidate();
            if (immediate) {
                return immediate;
            }
            try {
                await uiManager.waitForEditorsRendered(pageNumber);
            } catch { /* ignore */ }
            await delay(60);
            await nextTick();
            return pickCreatedEditorCandidate();
        };

        const previousMode = uiManager.getMode();
        try {
            const freeTextModeError = await toolManager.updateModeWithRetry(uiManager, AnnotationEditorType.FREETEXT, pageNumber);
            if (freeTextModeError) {
                throw freeTextModeError;
            }
            await uiManager.waitForEditorsRendered(pageNumber);
            const layer = uiManager.getLayer(pageNumber - 1) ?? uiManager.currentLayer;
            if (!layer?.div) {
                if (diagnosticsContext) {
                    BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint aborted: annotation layer div missing', {
                        attemptId: diagnosticsContext.attemptId ?? null,
                        pageNumber,
                    });
                }
                return false;
            }

            const eventInit: PointerEventInit = {
                clientX: pageClientX,
                clientY: pageClientY,
                button: 0,
                buttons: 1,
                bubbles: true,
                pointerType: 'mouse',
                isPrimary: true,
            };
            layer.div.dispatchEvent(new PointerEvent('pointerdown', eventInit));
            layer.div.dispatchEvent(new PointerEvent('pointerup', eventInit));
            if (diagnosticsContext) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Dispatched synthetic pointer events for quick-note placement', {
                    attemptId: diagnosticsContext.attemptId ?? null,
                    pageNumber,
                    clientX: roundForLog(eventInit.clientX ?? 0),
                    clientY: roundForLog(eventInit.clientY ?? 0),
                });
            }

            const resolvedEditor = await resolveCreatedEditor(null);
            if (!resolvedEditor) {
                if (diagnosticsContext) {
                    BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint aborted: failed to resolve created editor', {
                        attemptId: diagnosticsContext.attemptId ?? null,
                        pageNumber,
                    });
                }
                return false;
            }
            resolvedEditor.__evbResolvedPageIndex = pageIndex;
            resolvedEditor.__evbPlacementAttemptId = diagnosticsContext?.attemptId ?? null;

            for (let attempt = 0; attempt < 12; attempt += 1) {
                const markerRect = toMarkerRectFromEditor(resolvedEditor);
                if (markerRect) {
                    break;
                }
                await delay(16);
                await nextTick();
            }

            const clickMarkerRect = markerRectFromPoint(pageX, pageY);
            resolvedEditor.__evbPendingAnchorRect = clickMarkerRect;
            commentSync.pendingCommentEditorKeys.add(identity.getEditorPendingKey(resolvedEditor, pageIndex));
            if (diagnosticsContext) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Prepared pending quick-note anchor rect', {
                    attemptId: diagnosticsContext.attemptId ?? null,
                    pageNumber,
                    clickMarkerRect,
                    editorPendingKey: identity.getEditorPendingKey(resolvedEditor, pageIndex),
                });
            }

            const resolvedEditorWithComment = resolvedEditor as IPdfjsEditor & { editComment?: () => void };
            if (typeof resolvedEditorWithComment.editComment === 'function') {
                resolvedEditorWithComment.editComment();
                if (diagnosticsContext) {
                    BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Opened editor comment dialog through editComment()', {
                        attemptId: diagnosticsContext.attemptId ?? null,
                        pageNumber,
                    });
                }
            } else {
                const summary = commentSync.toEditorSummary(resolvedEditor, pageIndex, getCommentText(resolvedEditor));
                let finalMarkerRect = summary.markerRect ?? clickMarkerRect;
                const centerDistance = markerRectCenterDistance(summary.markerRect, clickMarkerRect);
                const shouldUseClickAnchor = Boolean(
                    clickMarkerRect
                    && (!summary.markerRect || centerDistance > 0.14),
                );
                if (shouldUseClickAnchor) {
                    finalMarkerRect = clickMarkerRect;
                }
                const summaryPageNumber = Number.isFinite(summary.pageNumber)
                    ? summary.pageNumber
                    : (summary.pageIndex + 1);
                if (diagnosticsContext) {
                    BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Resolved quick-note summary before opening note window', {
                        attemptId: diagnosticsContext.attemptId ?? null,
                        requestedPageNumber: pageNumber,
                        summaryPageNumber,
                        summaryPageIndex: summary.pageIndex,
                        summaryStableKey: summary.stableKey,
                        summarySource: summary.source,
                        summaryMarkerRect: summary.markerRect ?? null,
                        clickMarkerRect,
                        finalMarkerRect,
                        centerDistance: roundForLog(centerDistance, 5),
                        shouldUseClickAnchor,
                    });
                }
                if (diagnosticsContext && summaryPageNumber !== pageNumber) {
                    BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Quick-note page mismatch: summary page differs from requested page', {
                        attemptId: diagnosticsContext.attemptId ?? null,
                        requestedPageNumber: pageNumber,
                        summaryPageNumber,
                        summaryPageIndex: summary.pageIndex,
                        summaryStableKey: summary.stableKey,
                    });
                }
                emitAnnotationOpenNote({
                    ...summary,
                    markerRect: finalMarkerRect,
                });
            }
            if (diagnosticsContext) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint completed successfully', {
                    attemptId: diagnosticsContext.attemptId ?? null,
                    pageNumber,
                });
            }
            return true;
        } catch (error) {
            if (diagnosticsContext) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'commentAtPoint threw while creating quick-note annotation', {
                    attemptId: diagnosticsContext.attemptId ?? null,
                    pageNumber,
                    error: errorToLogText(error),
                });
            }
            throw error;
        } finally {
            if (previousMode !== AnnotationEditorType.FREETEXT) {
                await toolManager.updateModeWithRetry(uiManager, previousMode, pageNumber);
            }
        }
    }

    function setCommentPlacementMode(active: boolean) {
        if (isPlacingComment.value === active) {
            return;
        }
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Comment placement mode changed', {
            active,
            currentPage: currentPage.value,
            annotationTool: annotationTool.value,
            stack: (() => {
                try {
                    return (new Error('note-placement-mode-change'))
                        .stack
                        ?.split('\n')
                        .slice(1, 5)
                        .map(entry => entry.trim());
                } catch {
                    return null;
                }
            })(),
        });
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
            ?? `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const viewer = viewerContainer.value;
        const viewerRect = viewer?.getBoundingClientRect() ?? null;
        const enrichedDiagnosticsContext: INotePlacementDiagnosticsContext = {
            ...diagnosticsContext,
            attemptId,
        };
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Quick-note placeCommentAtClientPoint invoked', {
            attemptId,
            source: diagnosticsContext?.source ?? null,
            clickCapturedAtMs: diagnosticsContext?.clickCapturedAtMs ?? null,
            nowMs: Date.now(),
            currentPage: currentPage.value,
            annotationTool: annotationTool.value,
            isPlacingComment: isPlacingComment.value,
            clientX: roundForLog(clientX),
            clientY: roundForLog(clientY),
            clickTarget: summarizeElementForLog(targetElement ?? null),
            viewerRect: viewerRect ? toRectLog(viewerRect) : null,
            viewerScrollTop: viewer?.scrollTop ?? null,
            viewerScrollLeft: viewer?.scrollLeft ?? null,
            clickMeta: diagnosticsContext?.clickMeta ?? null,
        });
        const target = resolvePagePointTarget(clientX, clientY, targetElement, enrichedDiagnosticsContext);
        if (!target) {
            BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'placeCommentAtClientPoint aborted: no resolved target', {attemptId});
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
        BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'placeCommentAtClientPoint finished', {
            attemptId,
            created,
            resolvedPageNumber: target.pageNumber,
            resolvedPageX: roundForLog(target.pageX, 4),
            resolvedPageY: roundForLog(target.pageY, 4),
        });
        if (created) {
            setCommentPlacementMode(false);
        }
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
}
