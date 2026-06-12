import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    useClipboard,
    useEventListener,
} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';
import type {
    IPdfViewerExpose,
    TPdfSidebarTab,
} from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    IShapeAnnotation,
    ITextMarkupAnnotationProperties,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import {
    getShapeRect,
    resolveAnnotationCommentTextMarkupColor,
    normalizeMarkerRect,
} from '@app/modules/pdf-viewer/public';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { commentsShareDeleteTarget as doCommentsShareDeleteTarget } from '@app/modules/workspace-shell/annotations/commentsShareDeleteTarget';
import { getAnnotationPageNumber } from '@app/modules/workspace-shell/annotations/getAnnotationPageNumber';
import { isFreshEditorNoteCreationForUndo } from '@app/modules/workspace-shell/annotations/isFreshEditorNoteCreationForUndo';
import { isUndoableFreshEmptyEditorNote } from '@app/modules/workspace-shell/annotations/isUndoableFreshEmptyEditorNote';
import { withOpenedAnnotationNoteCreationTimestamp } from '@app/modules/workspace-shell/annotations/withOpenedAnnotationNoteCreationTimestamp';
import { pickPageAnnotationImageFile } from '@app/modules/workspace-shell/annotations/pickPageAnnotationImageFile';
import { readPageAnnotationImageFileFromClipboard } from '@app/modules/workspace-shell/annotations/readPageAnnotationImageFileFromClipboard';
import { resolveShapeAnnotationDefaultSettings } from '@app/modules/workspace-shell/annotations/resolveShapeAnnotationDefaultSettings';

type TPdfViewerForAnnotationActions = Pick<IPdfViewerExpose,
    'cancelCommentPlacement'
    | 'commentAtPoint'
    | 'commentSelection'
    | 'deleteAnnotationComment'
    | 'deleteSelectedShape'
    | 'focusAnnotationComment'
    | 'getSelectedShape'
    | 'getSelectedTextMarkupAnnotationProperties'
    | 'getViewerContainer'
    | 'highlightSelection'
    | 'invalidatePages'
    | 'removeAnnotationFromDom'
    | 'removeAnnotationFromInternalCache'
    | 'saveDocument'
    | 'selectedShapeId'
    | 'startCommentPlacement'
    | 'startImagePlacement'
    | 'suppressAnnotationId'
    | 'suppressAnnotationStableKey'
    | 'updateAnnotationComment'
    | 'updateSelectedTextMarkupAnnotationColor'
    | 'updateTextMarkupAnnotationColor'
    | 'updateShape'
> & Partial<Pick<IPdfViewerExpose,
    'registerAnnotationHistoryCommand'
    | 'clearPendingImagePlacement'
    | 'restorePendingImagePlacement'
    | 'restoreAnnotationToInternalCache'
    | 'unsuppressAnnotationId'
    | 'unsuppressAnnotationStableKey'
>>;

interface IPageAnnotationActionsDeps {
    pdfViewerRef: Ref<TPdfViewerForAnnotationActions | null>;
    annotationTool: Ref<TAnnotationTool>;
    annotationKeepActive: Ref<boolean>;
    annotationPlacingPageNote: Ref<boolean>;
    annotationSettings: Ref<IAnnotationSettings>;
    annotationActiveCommentStableKey: Ref<string | null>;
    annotationContextMenu: Ref<{
        visible: boolean;
        comment: IAnnotationCommentSummary | null;
        hasSelection: boolean;
        selectionText: string;
        pageNumber: number | null;
        pageX: number | null;
        pageY: number | null;
    }>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TPdfSidebarTab>;
    dragMode: Ref<boolean>;
    currentPage: Ref<number>;
    workingCopyPath: Ref<TDocumentRef | null>;
    closeAnnotationContextMenu: () => void;
    showAnnotationContextMenu: (payload: {
        comment: IAnnotationCommentSummary | null;
        clientX: number;
        clientY: number;
        hasSelection: boolean;
        selectionText: string;
        pageNumber: number | null;
        pageX: number | null;
        pageY: number | null;
    }) => void;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
    openAnnotationNoteWindow: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationNoteWindow: (stableKey: string) => void;
    setAnnotationNoteWindowError: (stableKey: string, error: string | null) => void;
    isSameAnnotationComment: (a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) => boolean;
    annotationNoteWindows: Ref<Array<{
        comment: IAnnotationCommentSummary;
        text?: string | undefined;
        createdAtMs?: number | undefined;
    }>>;
    loadPdfFromData: (data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean;
    }) => Promise<void>;
    waitForPdfReload: (page: number) => Promise<void>;
    invalidateThumbnailPages?: (pages: number[]) => void;
    removeAnnotationFromCache: (stableKey: string) => void;
    restoreAnnotationToCache: (comment: IAnnotationCommentSummary) => void;
    queuePendingEmbeddedAnnotationDelete: (comment: IAnnotationCommentSummary) => void;
    unqueuePendingEmbeddedAnnotationDelete: (stableKey: string) => void;
    isNativeFreeTextNoteSaved?: (comment: IAnnotationCommentSummary) => boolean;
    markPreservedAnnotationSourceDirty?: () => void;
    setPreservedAnnotationSourceDirty?: (dirty: boolean) => void;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    getAnnotationCommentsStatusSnapshot?: () => TAnnotationCommentsStatus;
    getEmbeddedMutationBaseData: () => Promise<Uint8Array | null>;
    embedPlacedImageToPage: (
        data: Uint8Array,
        placement: IPdfPlacedImageFinalizePayload,
    ) => Promise<Uint8Array>;
}

export const usePageAnnotationActions = (deps: IPageAnnotationActionsDeps) => {
    const { t } = useTypedI18n();
    const { clampToViewport } = useContextMenuPosition();
    const { copy: copyClipboardText } = useClipboard();

    const {
        pdfViewerRef,
        annotationTool,
        annotationKeepActive,
        annotationPlacingPageNote,
        annotationSettings,
        annotationActiveCommentStableKey,
        annotationContextMenu,
        showSidebar,
        sidebarTab,
        dragMode,
        currentPage,
        workingCopyPath,
        closeAnnotationContextMenu,
        showAnnotationContextMenu,
        handleAnnotationToolChange,
        openAnnotationNoteWindow,
        removeAnnotationNoteWindow,
        setAnnotationNoteWindowError,
        isSameAnnotationComment,
        annotationNoteWindows,
        loadPdfFromData,
        waitForPdfReload,
        invalidateThumbnailPages,
        removeAnnotationFromCache,
        restoreAnnotationToCache,
        getEmbeddedMutationBaseData,
        embedPlacedImageToPage,
    } = deps;

    let isCreatingContextMenuFreeNote = false;

    const shapePropertiesPopover = ref<{
        visible: boolean;
        x: number;
        y: number;
    }>({
        visible: false,
        x: 0,
        y: 0,
    });
    const dismissedShapePropertiesId = ref<string | null>(null);
    const selectedShapeId = computed(() => pdfViewerRef.value?.selectedShapeId ?? null);
    const selectedShape = computed(() => {
        if (!selectedShapeId.value) {
            return null;
        }
        return pdfViewerRef.value?.getSelectedShape() ?? null;
    });

    const selectedShapeForProperties = computed(() =>
        shapePropertiesPopover.value.visible
            ? selectedShape.value
            : null,
    );
    const selectedTextMarkupForProperties = ref<ITextMarkupAnnotationProperties | null>(null);
    const textMarkupPropertiesPopover = ref<{
        visible: boolean;
        x: number;
        y: number;
    }>({
        visible: false,
        x: 0,
        y: 0,
    });
    const viewerContainer = computed(() => pdfViewerRef.value?.getViewerContainer() ?? null);
    const windowTarget = computed(() => (
        typeof window !== 'undefined' && typeof window.addEventListener === 'function'
            ? window
            : null
    ));

    function captureActiveWorkingCopy() {
        return workingCopyPath.value;
    }

    function isCapturedWorkingCopyActive(capturedWorkingCopy: TDocumentRef | null) {
        return workingCopyPath.value === capturedWorkingCopy && Boolean(pdfViewerRef.value);
    }

    function updateShapePropertiesPopoverPosition(shape: IShapeAnnotation) {
        const viewerContainer = pdfViewerRef.value?.getViewerContainer();
        if (!viewerContainer) {
            return false;
        }

        const pageContainer = viewerContainer.querySelector<HTMLElement>(
            `.page_container[data-page="${shape.pageIndex + 1}"]`,
        );
        if (!pageContainer) {
            return false;
        }

        const pageRect = pageContainer.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
            return false;
        }

        const bounds = getShapeRect(shape, { rectFallbackMinSize: 0.01 });
        const desiredX = pageRect.left + ((bounds.x + bounds.width) * pageRect.width) + 12;
        const desiredY = pageRect.top + (bounds.y * pageRect.height) - 8;
        const clampedPosition = clampToViewport(
            desiredX,
            desiredY,
            260,
            220,
            8,
        );

        shapePropertiesPopover.value = {
            visible: true,
            x: clampedPosition.x,
            y: clampedPosition.y,
        };
        return true;
    }

    async function handleCommentSelection() {
        if (!pdfViewerRef.value) {
            return;
        }
        await pdfViewerRef.value.commentSelection();
    }

    async function handleQuickNoteAction() {
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return;
        }

        const previousSidebarVisibility = showSidebar.value;
        const previousSidebarTab = sidebarTab.value;
        try {
            const didAddToSelection = await viewer.commentSelection();
            if (didAddToSelection) {
                if (annotationPlacingPageNote.value) {
                    viewer.cancelCommentPlacement();
                    annotationPlacingPageNote.value = false;
                }
                return;
            }

            dragMode.value = false;
            annotationTool.value = 'none';
            if (!annotationPlacingPageNote.value) {
                viewer.startCommentPlacement();
                annotationPlacingPageNote.value = true;
            }
        } finally {
            await nextTick();
            showSidebar.value = previousSidebarVisibility;
            sidebarTab.value = previousSidebarTab;
        }
    }

    function handleStartPlaceNote() {
        if (!pdfViewerRef.value) {
            return;
        }

        if (annotationPlacingPageNote.value) {
            pdfViewerRef.value.cancelCommentPlacement();
            annotationPlacingPageNote.value = false;
            return;
        }

        showSidebar.value = true;
        sidebarTab.value = 'annotations';
        dragMode.value = false;
        annotationTool.value = 'none';
        pdfViewerRef.value.startCommentPlacement();
        annotationPlacingPageNote.value = true;
    }

    async function handleAnnotationFocusComment(comment: IAnnotationCommentSummary) {
        if (!pdfViewerRef.value) {
            return;
        }
        annotationActiveCommentStableKey.value = comment.stableKey;
        showSidebar.value = true;
        sidebarTab.value = 'annotations';
        dragMode.value = false;
        await pdfViewerRef.value.focusAnnotationComment(comment);
    }

    function handleAnnotationCommentClick(comment: IAnnotationCommentSummary) {
        annotationActiveCommentStableKey.value = comment.stableKey;
        dragMode.value = false;
    }

    function invalidateAnnotationPage(comment: IAnnotationCommentSummary) {
        const page = getAnnotationPageNumber(comment);
        pdfViewerRef.value?.invalidatePages([page]);
        invalidateThumbnailPages?.([page]);
    }

    function commentsShareDeleteTarget(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        return doCommentsShareDeleteTarget(left, right, isSameAnnotationComment);
    }

    function hasOpenAnnotationNoteWindow(comment: IAnnotationCommentSummary) {
        return annotationNoteWindows.value.some(note => commentsShareDeleteTarget(note.comment, comment));
    }

    function toAnnotationNoteWindowComment(note: {
        comment: IAnnotationCommentSummary;
        text?: string | undefined;
    }) {
        return {
            ...note.comment,
            text: typeof note.text === 'string' ? note.text : note.comment.text,
            hasNote: true,
        };
    }

    function getAnnotationCommentsSnapshot() {
        return deps.getAnnotationCommentsSnapshot?.() ?? null;
    }

    function findLiveAnnotationNoteComment(comment: IAnnotationCommentSummary) {
        const openNote = annotationNoteWindows.value.find(note =>
            commentsShareDeleteTarget(toAnnotationNoteWindowComment(note), comment),
        );
        if (openNote) {
            return toAnnotationNoteWindowComment(openNote);
        }

        return getAnnotationCommentsSnapshot()?.find(candidate =>
            commentsShareDeleteTarget(candidate, comment),
        ) ?? null;
    }

    function isAnnotationCommentsSnapshotReady() {
        return deps.getAnnotationCommentsStatusSnapshot?.() === 'ready';
    }

    function removeAnnotationCacheKeys(stableKeys: Set<string>, removedStableKeys: Set<string>) {
        stableKeys.forEach((stableKey) => {
            if (removedStableKeys.has(stableKey)) {
                return;
            }
            removedStableKeys.add(stableKey);
            removeAnnotationFromCache(stableKey);
        });
    }

    function shouldCloseRemainingNoteWindowsAfterExplicitDelete(
        commentsBeforeDelete: IAnnotationCommentSummary[] | null,
    ) {
        const commentsAfterDelete = getAnnotationCommentsSnapshot();
        if (
            !commentsAfterDelete
            || commentsAfterDelete.length > 0
            || annotationNoteWindows.value.length === 0
        ) {
            return false;
        }

        if (commentsBeforeDelete && commentsBeforeDelete.length > 0) {
            return true;
        }

        return isAnnotationCommentsSnapshotReady();
    }

    function closeRemainingAnnotationNoteWindows(stableKeys: Set<string>) {
        annotationNoteWindows.value.forEach((note) => {
            if (stableKeys.has(note.comment.stableKey)) {
                return;
            }
            stableKeys.add(note.comment.stableKey);
            removeAnnotationNoteWindow(note.comment.stableKey);
        });
    }

    function removeDeletedAnnotationState(
        comment: IAnnotationCommentSummary,
        commentsBeforeDelete: IAnnotationCommentSummary[] | null = null,
    ) {
        const stableKeys = new Set<string>([comment.stableKey]);
        const removedStableKeys = new Set<string>();
        annotationNoteWindows.value
            .filter(note => commentsShareDeleteTarget(note.comment, comment))
            .forEach((note) => {
                stableKeys.add(note.comment.stableKey);
                removeAnnotationNoteWindow(note.comment.stableKey);
            });

        removeAnnotationCacheKeys(stableKeys, removedStableKeys);
        if (shouldCloseRemainingNoteWindowsAfterExplicitDelete(commentsBeforeDelete)) {
            closeRemainingAnnotationNoteWindows(stableKeys);
            removeAnnotationCacheKeys(stableKeys, removedStableKeys);
        }

        if (
            annotationActiveCommentStableKey.value
            && stableKeys.has(annotationActiveCommentStableKey.value)
        ) {
            annotationActiveCommentStableKey.value = null;
        }
    }

    function registerFreshNoteCreationUndo(noteComment: IAnnotationCommentSummary) {
        const viewer = pdfViewerRef.value;
        if (!viewer?.registerAnnotationHistoryCommand) {
            return;
        }

        let creationSnapshot = noteComment;
        const refreshCreationSnapshot = () => {
            creationSnapshot = findLiveAnnotationNoteComment(creationSnapshot) ?? creationSnapshot;
            return creationSnapshot;
        };

        const undoCreate = () => {
            const currentSnapshot = refreshCreationSnapshot();
            viewer.removeAnnotationFromDom(currentSnapshot);
            viewer.removeAnnotationFromInternalCache(currentSnapshot.stableKey);
            removeDeletedAnnotationState(currentSnapshot);
            invalidateAnnotationPage(currentSnapshot);
        };
        const redoCreate = () => {
            restoreAnnotationToCache(creationSnapshot);
            viewer.restoreAnnotationToInternalCache?.(creationSnapshot);
            openAnnotationNoteWindow(creationSnapshot);
            annotationActiveCommentStableKey.value = creationSnapshot.stableKey;
            invalidateAnnotationPage(creationSnapshot);
        };

        viewer.registerAnnotationHistoryCommand({
            cmd: redoCreate,
            undo: undoCreate,
        });
    }

    function queueFreshNoteCreationUndoRegistration(noteComment: IAnnotationCommentSummary) {
        const schedule = typeof window !== 'undefined' && typeof window.setTimeout === 'function'
            ? window.setTimeout.bind(window)
            : setTimeout;
        schedule(() => {
            if (!hasOpenAnnotationNoteWindow(noteComment)) {
                return;
            }
            registerFreshNoteCreationUndo(noteComment);
        }, 0);
    }

    function handleOpenAnnotationNote(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        const noteComment = withOpenedAnnotationNoteCreationTimestamp(comment);
        const wasAlreadyOpen = hasOpenAnnotationNoteWindow(noteComment);
        annotationActiveCommentStableKey.value = noteComment.stableKey;
        restoreAnnotationToCache(noteComment);
        pdfViewerRef.value?.restoreAnnotationToInternalCache?.(noteComment);
        openAnnotationNoteWindow(noteComment);
        if (isFreshEditorNoteCreationForUndo(comment, noteComment, wasAlreadyOpen)) {
            queueFreshNoteCreationUndoRegistration(noteComment);
        }
        invalidateAnnotationPage(noteComment);
        dragMode.value = false;
    }

    function closeShapeProperties() {
        dismissedShapePropertiesId.value = selectedShape.value?.id ?? null;
        shapePropertiesPopover.value = {
            visible: false,
            x: 0,
            y: 0,
        };
    }

    function closeTextMarkupProperties() {
        selectedTextMarkupForProperties.value = null;
        textMarkupPropertiesPopover.value = {
            visible: false,
            x: 0,
            y: 0,
        };
    }

    function updateTextMarkupPropertiesPopoverPosition(markup: ITextMarkupAnnotationProperties) {
        const markerRect = markup.markerRect;
        const viewerContainer = pdfViewerRef.value?.getViewerContainer();
        if (!markerRect || !viewerContainer) {
            return false;
        }

        const pageContainer = viewerContainer.querySelector<HTMLElement>(
            `.page_container[data-page="${markup.pageIndex + 1}"]`,
        );
        if (!pageContainer) {
            return false;
        }

        const pageRect = pageContainer.getBoundingClientRect();
        if (pageRect.width <= 0 || pageRect.height <= 0) {
            return false;
        }

        const desiredX = pageRect.left + ((markerRect.left + markerRect.width) * pageRect.width) + 12;
        const desiredY = pageRect.top + (markerRect.top * pageRect.height) - 8;
        const clampedPosition = clampToViewport(
            desiredX,
            desiredY,
            260,
            90,
            8,
        );

        textMarkupPropertiesPopover.value = {
            visible: true,
            x: clampedPosition.x,
            y: clampedPosition.y,
        };
        return true;
    }

    function refreshSelectedTextMarkupProperties() {
        const markup = pdfViewerRef.value?.getSelectedTextMarkupAnnotationProperties?.() ?? null;
        selectedTextMarkupForProperties.value = markup;
        if (!markup) {
            textMarkupPropertiesPopover.value = {
                visible: false,
                x: 0,
                y: 0,
            };
            return;
        }
        updateTextMarkupPropertiesPopoverPosition(markup);
    }

    function normalizeTextMarkupColorValue(color: string | null | undefined) {
        return color?.trim().toLowerCase() ?? '';
    }

    function applySelectedTextMarkupColorUpdate(color: string) {
        const selectedMarkup = selectedTextMarkupForProperties.value;
        const didUpdate = pdfViewerRef.value?.updateSelectedTextMarkupAnnotationColor?.(color) === true;
        if (!didUpdate) {
            return false;
        }
        if (selectedMarkup) {
            const nextSettings: IAnnotationSettings = { ...annotationSettings.value };
            if (selectedMarkup.subtype === 'Underline') {
                nextSettings.underlineColor = color;
            } else if (selectedMarkup.subtype === 'StrikeOut') {
                nextSettings.strikethroughColor = color;
            } else if (selectedMarkup.subtype === 'Squiggly') {
                nextSettings.squigglyColor = color;
            } else if (selectedMarkup.subtype === 'Highlight') {
                nextSettings.highlightColor = color;
            }
            annotationSettings.value = nextSettings;
        }
        selectedTextMarkupForProperties.value = pdfViewerRef.value?.getSelectedTextMarkupAnnotationProperties?.() ?? selectedTextMarkupForProperties.value;
        return true;
    }

    function handleTextMarkupColorUpdate(color: string) {
        const selectedMarkup = selectedTextMarkupForProperties.value;
        const previousColor = selectedMarkup?.color ?? null;
        const didUpdate = applySelectedTextMarkupColorUpdate(color);
        if (!didUpdate) {
            return;
        }
        if (
            selectedMarkup
            && previousColor
            && normalizeTextMarkupColorValue(previousColor) !== normalizeTextMarkupColorValue(color)
        ) {
            pdfViewerRef.value?.registerAnnotationHistoryCommand?.({
                cmd: () => {
                    selectedTextMarkupForProperties.value = selectedMarkup;
                    applySelectedTextMarkupColorUpdate(color);
                },
                undo: () => {
                    selectedTextMarkupForProperties.value = selectedMarkup;
                    applySelectedTextMarkupColorUpdate(previousColor);
                },
            });
        }
        closeTextMarkupProperties();
    }

    function updateTextMarkupDefaultSettings(comment: IAnnotationCommentSummary, color: string) {
        const subtype = (comment.subtype ?? '').trim().toLowerCase();
        const nextSettings: IAnnotationSettings = { ...annotationSettings.value };
        if (subtype === 'underline') {
            nextSettings.underlineColor = color;
        } else if (subtype === 'strikeout' || subtype === 'strikethrough') {
            nextSettings.strikethroughColor = color;
        } else if (subtype === 'squiggly') {
            nextSettings.squigglyColor = color;
        } else if (subtype === 'highlight') {
            nextSettings.highlightColor = color;
        } else {
            return;
        }
        annotationSettings.value = nextSettings;
    }

    function applyContextTextMarkupColorUpdate(
        comment: IAnnotationCommentSummary,
        color: string,
        options: {
            colorEdited?: boolean;
            sourceColor?: string | null;
        } = {},
    ) {
        const colorEdited = options.colorEdited ?? true;
        const sourceColor = options.sourceColor ?? comment.color ?? null;
        const nextComment = {
            ...comment,
            color,
            colorEdited,
        };
        const didUpdate = pdfViewerRef.value?.updateTextMarkupAnnotationColor?.({
            ...nextComment,
            color: sourceColor ?? nextComment.color,
        }, color) === true;
        updateTextMarkupDefaultSettings(comment, color);
        annotationContextMenu.value = {
            ...annotationContextMenu.value,
            comment: nextComment,
        };
        restoreAnnotationToCache(nextComment);
        pdfViewerRef.value?.restoreAnnotationToInternalCache?.(nextComment);
        invalidateAnnotationPage(nextComment);
        const nextSnapshot = [
            ...(deps.getAnnotationCommentsSnapshot?.() ?? []).filter(candidate => candidate.stableKey !== nextComment.stableKey),
            nextComment,
        ];
        const hasColorEdits = nextSnapshot.some(candidate => candidate.colorEdited === true);
        if (deps.setPreservedAnnotationSourceDirty) {
            deps.setPreservedAnnotationSourceDirty(hasColorEdits);
        } else if (hasColorEdits) {
            deps.markPreservedAnnotationSourceDirty?.();
        }
        if (!didUpdate) {
            BrowserLogger.debug('annotations', 'Context-menu text markup color state updated before DOM repaint', () => ({
                annotationId: comment.annotationId ?? null,
                stableKey: comment.stableKey,
                subtype: comment.subtype ?? null,
                color,
            }));
        }
        return didUpdate;
    }

    function resolveContextTextMarkupUndoColor(comment: IAnnotationCommentSummary) {
        if (comment.color) {
            return comment.color;
        }
        const container = viewerContainer.value;
        if (!container) {
            return null;
        }
        return resolveAnnotationCommentTextMarkupColor(container, comment);
    }

    function handleContextTextMarkupColorUpdate(color: string) {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return;
        }
        const previousColor = resolveContextTextMarkupUndoColor(comment);
        const previousColorEdited = comment.colorEdited === true;
        applyContextTextMarkupColorUpdate(comment, color, { sourceColor: previousColor });
        if (
            previousColor
            && normalizeTextMarkupColorValue(previousColor) !== normalizeTextMarkupColorValue(color)
        ) {
            pdfViewerRef.value?.registerAnnotationHistoryCommand?.({
                cmd: () => {
                    applyContextTextMarkupColorUpdate(
                        {
                            ...comment,
                            color,
                            colorEdited: true,
                        },
                        color,
                        { sourceColor: previousColor },
                    );
                },
                undo: () => {
                    applyContextTextMarkupColorUpdate(
                        {
                            ...comment,
                            color: previousColor,
                            colorEdited: previousColorEdited,
                        },
                        previousColor,
                        {
                            colorEdited: previousColorEdited,
                            sourceColor: color,
                        },
                    );
                },
            });
        }
        closeAnnotationContextMenu();
    }

    function updateShapeDefaultSettings(
        updates: Partial<IShapeAnnotation>,
        isInkShape: boolean | undefined,
    ) {
        const nextDefaults = resolveShapeAnnotationDefaultSettings(
            annotationSettings.value,
            updates,
            isInkShape,
        );
        if (nextDefaults.didUpdate) {
            annotationSettings.value = nextDefaults.settings;
        }
    }

    function handleShapePropertyUpdate(updates: Partial<IShapeAnnotation>) {
        const id = pdfViewerRef.value?.selectedShapeId;
        if (!id) {
            return;
        }

        const currentSelectedShape = selectedShape.value;
        const isInkShape = currentSelectedShape?.pdfSubtype === 'Ink';
        updateShapeDefaultSettings(updates, isInkShape);

        pdfViewerRef.value?.updateShape(id, updates);
    }

    function handleShapeContextMenu(payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) {
        closeAnnotationContextMenu();
        dismissedShapePropertiesId.value = null;
        const clampedPosition = clampToViewport(
            payload.clientX,
            payload.clientY,
            260,
            200,
            8,
        );

        shapePropertiesPopover.value = {
            visible: true,
            x: clampedPosition.x,
            y: clampedPosition.y,
        };
    }

    function handleDeleteSelectedShape() {
        pdfViewerRef.value?.deleteSelectedShape();
        closeShapeProperties();
    }

    watch(
        () => selectedShapeId.value,
        (shapeId, previousShapeId) => {
            if (!shapeId) {
                dismissedShapePropertiesId.value = null;
                shapePropertiesPopover.value = {
                    visible: false,
                    x: 0,
                    y: 0,
                };
                return;
            }

            if (shapeId === previousShapeId && shapePropertiesPopover.value.visible) {
                return;
            }

            if (dismissedShapePropertiesId.value === shapeId) {
                return;
            }

            if (selectedShape.value) {
                updateShapePropertiesPopoverPosition(selectedShape.value);
            }
        },
        { immediate: true },
    );

    watch(
        () => {
            const shape = selectedShape.value;
            if (!shape || !shapePropertiesPopover.value.visible) {
                return null;
            }
            return JSON.stringify({
                id: shape.id,
                x: shape.x,
                y: shape.y,
                width: shape.width,
                height: shape.height,
                x2: shape.x2 ?? null,
                y2: shape.y2 ?? null,
                points: shape.points ?? null,
                strokes: shape.strokes ?? null,
            });
        },
        () => {
            if (selectedShape.value && shapePropertiesPopover.value.visible) {
                updateShapePropertiesPopoverPosition(selectedShape.value);
            }
        },
    );

    function handleViewportChange() {
        if (selectedShape.value && shapePropertiesPopover.value.visible) {
            updateShapePropertiesPopoverPosition(selectedShape.value);
        }
        if (selectedTextMarkupForProperties.value && textMarkupPropertiesPopover.value.visible) {
            updateTextMarkupPropertiesPopoverPosition(selectedTextMarkupForProperties.value);
        }
    }

    useEventListener(viewerContainer, 'scroll', handleViewportChange, { passive: true });
    useEventListener(windowTarget, 'resize', handleViewportChange);
    useEventListener(viewerContainer, 'pointerup', () => setTimeout(refreshSelectedTextMarkupProperties, 0));
    useEventListener(viewerContainer, 'keyup', refreshSelectedTextMarkupProperties);

    function handleViewerAnnotationContextMenu(payload: {
        comment: IAnnotationCommentSummary | null;
        clientX: number;
        clientY: number;
        hasSelection: boolean;
        selectionText: string;
        pageNumber: number | null;
        pageX: number | null;
        pageY: number | null;
    }) {
        if (payload.comment) {
            annotationActiveCommentStableKey.value = payload.comment.stableKey;
        } else {
            annotationActiveCommentStableKey.value = null;
        }

        showAnnotationContextMenu(payload);
    }

    async function insertImageFromFileAt(
        pageNumber?: number | null,
        pageX?: number | null,
        pageY?: number | null,
    ) {
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return;
        }

        closeAnnotationContextMenu();
        const file = await pickPageAnnotationImageFile();
        if (!file) {
            return;
        }
        await viewer.startImagePlacement(file, {
            ...(pageNumber !== undefined ? { pageNumber } : {}),
            ...(pageX !== undefined ? { pageX } : {}),
            ...(pageY !== undefined ? { pageY } : {}),
        });
    }

    async function pasteImageFromClipboardAt(
        pageNumber?: number | null,
        pageX?: number | null,
        pageY?: number | null,
    ) {
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return;
        }

        closeAnnotationContextMenu();

        try {
            const file = await readPageAnnotationImageFileFromClipboard();
            if (!file) {
                return;
            }
            await viewer.startImagePlacement(file, {
                ...(pageNumber !== undefined ? { pageNumber } : {}),
                ...(pageX !== undefined ? { pageX } : {}),
                ...(pageY !== undefined ? { pageY } : {}),
            });
        } catch (error) {
            BrowserLogger.warn('annotations', 'Failed to paste image from clipboard', error);
        }
    }

    let imageFinalizeInFlight = false;

    async function handleFinalizePlacedImage(placement: IPdfPlacedImageFinalizePayload) {
        if (imageFinalizeInFlight || !pdfViewerRef.value) {
            return false;
        }

        imageFinalizeInFlight = true;
        try {
            const capturedWorkingCopy = captureActiveWorkingCopy();
            const rawData = await getEmbeddedMutationBaseData();
            if (!rawData) {
                pdfViewerRef.value.restorePendingImagePlacement?.();
                return false;
            }
            if (!isCapturedWorkingCopyActive(capturedWorkingCopy)) {
                pdfViewerRef.value?.clearPendingImagePlacement?.();
                return false;
            }

            const embeddedData = await embedPlacedImageToPage(rawData, placement);
            if (!isCapturedWorkingCopyActive(capturedWorkingCopy)) {
                pdfViewerRef.value?.clearPendingImagePlacement?.();
                return false;
            }
            const pageToRestore = placement.pageNumber || currentPage.value;
            const restorePromise = waitForPdfReload(pageToRestore);
            await loadPdfFromData(embeddedData, {
                pushHistory: true,
                persistWorkingCopy: !!capturedWorkingCopy,
            });
            if (!isCapturedWorkingCopyActive(capturedWorkingCopy)) {
                void restorePromise.catch(() => {});
                pdfViewerRef.value?.clearPendingImagePlacement?.();
                return false;
            }
            await restorePromise;
            if (!isCapturedWorkingCopyActive(capturedWorkingCopy)) {
                pdfViewerRef.value?.clearPendingImagePlacement?.();
                return false;
            }
            pdfViewerRef.value?.clearPendingImagePlacement?.();
            return true;
        } catch (error) {
            BrowserLogger.warn('annotations', 'Failed to finalize placed image', error);
            pdfViewerRef.value.restorePendingImagePlacement?.();
            return false;
        } finally {
            imageFinalizeInFlight = false;
        }
    }

    function openContextMenuNote() {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return;
        }
        handleOpenAnnotationNote(comment);
        closeAnnotationContextMenu();
    }

    function copyContextMenuNoteText() {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return;
        }
        void handleCopyAnnotationComment(comment);
        closeAnnotationContextMenu();
    }

    async function copyContextMenuSelectionText() {
        const text = annotationContextMenu.value.selectionText.trim();
        closeAnnotationContextMenu();
        if (!text) {
            return;
        }
        try {
            await copyClipboardText(text);
        } catch (error) {
            BrowserLogger.debug('annotations', 'Failed to copy selected text to clipboard', error);
        }
    }

    function deleteContextMenuComment() {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return;
        }
        void handleDeleteAnnotationComment(comment);
        closeAnnotationContextMenu();
    }

    async function createContextMenuFreeNote() {
        if (isCreatingContextMenuFreeNote) {
            closeAnnotationContextMenu();
            return;
        }
        if (!pdfViewerRef.value) {
            closeAnnotationContextMenu();
            return;
        }

        const {
            pageNumber,
            pageX,
            pageY,
        } = annotationContextMenu.value;
        if (
            !Number.isFinite(pageNumber)
            || !Number.isFinite(pageX)
            || !Number.isFinite(pageY)
        ) {
            closeAnnotationContextMenu();
            return;
        }

        isCreatingContextMenuFreeNote = true;
        closeAnnotationContextMenu();
        try {
            await pdfViewerRef.value.commentAtPoint(
                pageNumber as number,
                pageX as number,
                pageY as number,
                { preferTextAnchor: false },
            );
        } catch (error) {
            BrowserLogger.warn('note-placement', 'Failed to create note from annotation context menu', error);
        } finally {
            isCreatingContextMenuFreeNote = false;
        }
    }

    async function createContextMenuSelectionNote() {
        await pdfViewerRef.value?.commentSelection();
        closeAnnotationContextMenu();
    }

    async function insertContextMenuImageFromFile() {
        await insertImageFromFileAt(
            annotationContextMenu.value.pageNumber,
            annotationContextMenu.value.pageX,
            annotationContextMenu.value.pageY,
        );
    }

    async function pasteContextMenuImageFromClipboard() {
        await pasteImageFromClipboardAt(
            annotationContextMenu.value.pageNumber,
            annotationContextMenu.value.pageX,
            annotationContextMenu.value.pageY,
        );
    }

    async function createContextMenuMarkup(tool: TAnnotationTool) {
        if (!pdfViewerRef.value) {
            closeAnnotationContextMenu();
            return;
        }
        handleAnnotationToolChange(tool);
        await nextTick();
        await pdfViewerRef.value.highlightSelection();
        if (!annotationKeepActive.value) {
            annotationTool.value = 'none';
        }
        closeAnnotationContextMenu();
    }

    async function serializeCurrentPdfForEmbeddedFallback() {
        if (!pdfViewerRef.value) {
            return false;
        }

        const capturedWorkingCopy = captureActiveWorkingCopy();
        const rawData = await pdfViewerRef.value.saveDocument();
        if (!rawData) {
            return false;
        }
        if (!isCapturedWorkingCopyActive(capturedWorkingCopy)) {
            return false;
        }

        const pageToRestore = currentPage.value;
        const restorePromise = waitForPdfReload(pageToRestore);
        await loadPdfFromData(rawData, {
            pushHistory: true,
            persistWorkingCopy: !!capturedWorkingCopy,
        });
        if (!isCapturedWorkingCopyActive(capturedWorkingCopy)) {
            void restorePromise.catch(() => {});
            return false;
        }
        await restorePromise;
        if (!isCapturedWorkingCopyActive(capturedWorkingCopy)) {
            return false;
        }
        return true;
    }

    async function handleCopyAnnotationComment(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        const text = comment.text?.trim();
        if (!text) {
            return;
        }
        try {
            await copyClipboardText(text);
        } catch (error) {
            BrowserLogger.debug('annotations', 'Failed to copy annotation comment text to clipboard', error);
        }
    }

    let annotationDeleteQueue: Promise<void> = Promise.resolve();
    const pendingAnnotationDeleteStableKeys = new Set<string>();

    function resolveEmbeddedPdfAnnotationId(comment: IAnnotationCommentSummary) {
        const annotationId = normalizePdfJsAnnotationId(comment.annotationId);
        if (parsePdfJsAnnotationRef(annotationId)) {
            return annotationId;
        }

        const stableRef = comment.stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/iu)?.[1];
        const stableAnnotationId = normalizePdfJsAnnotationId(stableRef);
        if (parsePdfJsAnnotationRef(stableAnnotationId)) {
            return stableAnnotationId;
        }

        return null;
    }

    function shouldUseEmbeddedDeletePath(comment: IAnnotationCommentSummary) {
        return comment.source !== 'shape'
            && (comment.source === 'pdf' || Boolean(resolveEmbeddedPdfAnnotationId(comment)));
    }

    function isReplayableEditorOnlyFreeTextNote(comment: IAnnotationCommentSummary) {
        const subtype = comment.subtype?.trim().toLowerCase();
        return comment.source === 'editor'
            && !parsePdfJsAnnotationRef(comment.annotationId)
            && Boolean(comment.hasNote)
            && Boolean(normalizeMarkerRect(comment.markerRect))
            && (subtype === 'freetext' || subtype === 'typewriter');
    }

    function shouldQueueNativeSavedFreeTextDelete(comment: IAnnotationCommentSummary) {
        return isReplayableEditorOnlyFreeTextNote(comment)
            && deps.isNativeFreeTextNoteSaved?.(comment) === true;
    }

    function shouldUseEmbeddedDeleteFallback(comment: IAnnotationCommentSummary, deleted: boolean) {
        return !deleted && shouldUseEmbeddedDeletePath(comment);
    }

    function queueDeferredEmbeddedDelete(comment: IAnnotationCommentSummary) {
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return false;
        }
        const embeddedAnnotationId = resolveEmbeddedPdfAnnotationId(comment);
        const deletionComment: IAnnotationCommentSummary = embeddedAnnotationId && embeddedAnnotationId !== comment.annotationId
            ? {
                ...comment,
                annotationId: embeddedAnnotationId,
            }
            : comment;

        const applyDelete = () => {
            viewer.suppressAnnotationStableKey(comment.stableKey);
            deps.queuePendingEmbeddedAnnotationDelete(deletionComment);
            if (embeddedAnnotationId) {
                viewer.suppressAnnotationId(embeddedAnnotationId);
            }
            viewer.removeAnnotationFromDom(deletionComment);
            viewer.removeAnnotationFromInternalCache(comment.stableKey);
            deps.removeAnnotationFromCache(comment.stableKey);
            invalidateAnnotationPage(comment);
        };
        const undoDelete = () => {
            deps.unqueuePendingEmbeddedAnnotationDelete(comment.stableKey);
            viewer.unsuppressAnnotationStableKey?.(comment.stableKey);
            if (embeddedAnnotationId) {
                viewer.unsuppressAnnotationId?.(embeddedAnnotationId);
            }
            viewer.restoreAnnotationToInternalCache?.(comment);
            deps.restoreAnnotationToCache(comment);
            invalidateAnnotationPage(comment);
        };

        // Keep embedded annotation deletes local until the user saves.
        // This matches note text edits and avoids an immediate rewrite/reload.
        applyDelete();
        viewer.registerAnnotationHistoryCommand?.({
            cmd: applyDelete,
            undo: undoDelete,
        });
        return true;
    }

    function handleAnnotationDeleteFailure(comment: IAnnotationCommentSummary) {
        BrowserLogger.warn('annotations', 'Delete annotation comment failed after all fallbacks', {
            stableKey: comment.stableKey,
            source: comment.source,
            annotationId: comment.annotationId ?? null,
            uid: comment.uid ?? null,
            id: comment.id,
        });
        setAnnotationNoteWindowError(comment.stableKey, t('errors.annotation.delete'));
    }

    function deleteAnnotationCommentWithFallbacks(comment: IAnnotationCommentSummary, deleted: boolean) {
        if (!shouldUseEmbeddedDeleteFallback(comment, deleted)) {
            return deleted;
        }
        return queueDeferredEmbeddedDelete(comment);
    }

    async function performDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        const viewer = pdfViewerRef.value;
        if (!viewer) {
            return;
        }
        BrowserLogger.debug('annotations', 'Delete annotation comment requested', {
            stableKey: comment.stableKey,
            source: comment.source,
            annotationId: comment.annotationId ?? null,
            uid: comment.uid ?? null,
            pageNumber: comment.pageNumber,
        });
        setAnnotationNoteWindowError(comment.stableKey, null);
        const commentsBeforeDelete = getAnnotationCommentsSnapshot();
        if (shouldUseEmbeddedDeletePath(comment)) {
            const deleted = deleteAnnotationCommentWithFallbacks(comment, false);
            if (!deleted) {
                handleAnnotationDeleteFailure(comment);
                return;
            }
            removeDeletedAnnotationState(comment, commentsBeforeDelete);
            return;
        }

        const shouldQueueNativeFreeTextDelete = shouldQueueNativeSavedFreeTextDelete(comment);
        const viewerDeleted = await viewer.deleteAnnotationComment(comment);
        BrowserLogger.debug('annotations', 'Delete annotation comment viewer result', {
            stableKey: comment.stableKey,
            deleted: viewerDeleted,
            shouldQueueNativeFreeTextDelete,
        });

        const queuedNativeFreeTextDelete = shouldQueueNativeFreeTextDelete
            ? queueDeferredEmbeddedDelete(comment)
            : false;
        const deleted = shouldQueueNativeFreeTextDelete
            ? viewerDeleted || queuedNativeFreeTextDelete
            : deleteAnnotationCommentWithFallbacks(comment, viewerDeleted);
        if (!deleted) {
            handleAnnotationDeleteFailure(comment);
            return;
        }
        removeDeletedAnnotationState(comment, commentsBeforeDelete);
        invalidateAnnotationPage(comment);
    }

    async function handleDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        if (pendingAnnotationDeleteStableKeys.has(comment.stableKey)) {
            return;
        }
        pendingAnnotationDeleteStableKeys.add(comment.stableKey);
        annotationDeleteQueue = annotationDeleteQueue
            .catch(() => undefined)
            .then(async () => {
                try {
                    await performDeleteAnnotationComment(comment);
                } finally {
                    pendingAnnotationDeleteStableKeys.delete(comment.stableKey);
                }
            });
        await annotationDeleteQueue;
    }

    async function undoLatestFreshAnnotationNoteCreation() {
        const note = [...annotationNoteWindows.value]
            .reverse()
            .find(candidate => isUndoableFreshEmptyEditorNote(candidate));
        if (!note) {
            return false;
        }
        await handleDeleteAnnotationComment(note.comment);
        return true;
    }

    return {
        shapePropertiesPopover,
        selectedShapeForProperties,
        textMarkupPropertiesPopover,
        selectedTextMarkupForProperties,
        handleCommentSelection,
        handleQuickNoteAction,
        handleStartPlaceNote,
        handleAnnotationFocusComment,
        handleAnnotationCommentClick,
        handleOpenAnnotationNote,
        closeShapeProperties,
        closeTextMarkupProperties,
        handleDeleteSelectedShape,
        handleShapePropertyUpdate,
        handleTextMarkupColorUpdate,
        handleContextTextMarkupColorUpdate,
        handleShapeContextMenu,
        handleViewerAnnotationContextMenu,
        openContextMenuNote,
        copyContextMenuNoteText,
        copyContextMenuSelectionText,
        deleteContextMenuComment,
        createContextMenuFreeNote,
        createContextMenuSelectionNote,
        insertContextMenuImageFromFile,
        pasteContextMenuImageFromClipboard,
        createContextMenuMarkup,
        serializeCurrentPdfForEmbeddedFallback,
        handleCopyAnnotationComment,
        handleDeleteAnnotationComment,
        undoLatestFreshAnnotationNoteCreation,
        handleFinalizePlacedImage,
        insertImageFromFileAt,
        pasteImageFromClipboardAt,
    };
};
