import {
    AnnotationEditorType,
    type AnnotationEditorUIManager,
} from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
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
import {
    getOptionalFunction,
    isRecord,
} from '@app/services/pdfjs/runtime';

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

interface IAnnotationEditorLayerLike {
    div?: HTMLElement | null;
    createAndAddNewEditor?: (...args: unknown[]) => unknown;
}

function toAnnotationEditorLayerLike(value: unknown): IAnnotationEditorLayerLike | null {
    if (!isRecord(value)) {
        return null;
    }

    const div = value.div;
    if (div !== undefined && div !== null && !(div instanceof HTMLElement)) {
        return null;
    }

    return {
        div: div instanceof HTMLElement ? div : null,
        createAndAddNewEditor: getOptionalFunction(value, 'createAndAddNewEditor') ?? undefined,
    };
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
                throw highlightModeError instanceof Error
                    ? highlightModeError
                    : new Error(String(highlightModeError));
            }
            await uiManager.waitForEditorsRendered(pageNumber);

            const layer = toAnnotationEditorLayerLike(
                uiManager.getLayer(pageNumber - 1) ?? uiManager.currentLayer,
            );
            const createdEditor = layer?.createAndAddNewEditor?.(
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
        const pageClientX = pageRect.left + clamp01(pageX) * pageRect.width;
        const pageClientY = pageRect.top + clamp01(pageY) * pageRect.height;

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
                throw freeTextModeError instanceof Error
                    ? freeTextModeError
                    : new Error(String(freeTextModeError));
            }
            await uiManager.waitForEditorsRendered(pageNumber);
            const layer = toAnnotationEditorLayerLike(
                uiManager.getLayer(pageNumber - 1) ?? uiManager.currentLayer,
            );
            if (!layer?.div) {
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

            const resolvedEditor = await resolveCreatedEditor(null);
            if (!resolvedEditor) {
                return false;
            }

            // Prevent PDF.js from removing this empty FreeText editor during mode
            // transitions.  When updateMode switches away from FREETEXT,
            // commitOrRemove() fires on the active editor.  If isEmpty() returns true
            // the editor self-destructs, but we need it alive so the save path can
            // locate it via getEditors() later.
            //
            // Insert a zero-width space into editorDiv so that:
            //  1. isEmpty() naturally returns false (innerText is non-empty after trim)
            //  2. PDF.js serializes the editor with non-empty value + rect into the PDF
            //  3. The annotation round-trips correctly on reopen
            const editorDiv = resolvedEditor.div?.querySelector<HTMLElement>('[contenteditable]')
                ?? (resolvedEditor as { editorDiv?: HTMLElement }).editorDiv;
            if (editorDiv) {
                editorDiv.textContent = '\u200B';
            }
            resolvedEditor.isEmpty = () => false;

            // The ZWS content auto-sizes the editorDiv to a nearly zero-width rect.
            // When PDF.js serializes via getPDFRect(), it uses editor.width/height
            // (normalized 0–1 fractions of page dimensions).  A zero-area rect causes
            // toMarkerRectFromPdfRect → normalizeMarkerRect to return null on reopen,
            // making the marker invisible.  Set a minimum size matching the standard
            // note anchor area so the annotation round-trips with a valid marker rect.
            const MIN_NOTE_EDITOR_SIZE = DEFAULT_POINT_MARKER_SIZE;
            if ((resolvedEditor.width ?? 0) < MIN_NOTE_EDITOR_SIZE) {
                resolvedEditor.width = MIN_NOTE_EDITOR_SIZE;
            }
            if ((resolvedEditor.height ?? 0) < MIN_NOTE_EDITOR_SIZE) {
                resolvedEditor.height = MIN_NOTE_EDITOR_SIZE;
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
            if (diagnosticsContext && summaryPageNumber !== pageNumber) {
                BrowserLogger.warn(NOTE_PLACEMENT_LOG_SECTION, 'Quick-note page mismatch: summary page differs from requested page', {
                    attemptId: diagnosticsContext.attemptId ?? null,
                    requestedPageNumber: pageNumber,
                    summaryPageNumber,
                    summaryPageIndex: summary.pageIndex,
                    summaryStableKey: summary.stableKey,
                });
            }
            const summaryForNote = {
                ...summary,
                markerRect: finalMarkerRect,
            };

            try {
                emitAnnotationOpenNote(summaryForNote);
            } catch (error) {
                const resolvedEditorWithComment = resolvedEditor as IPdfjsEditor & { editComment?: () => void };
                if (typeof resolvedEditorWithComment.editComment !== 'function') {
                    throw error instanceof Error
                        ? error
                        : new Error(String(error));
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
                resolvedEditorWithComment.editComment();
                pinViewerScroll();
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
            throw error instanceof Error
                ? error
                : new Error(String(error));
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
}
