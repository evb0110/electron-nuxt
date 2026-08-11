import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import * as VueUse from '@vueuse/core';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';
import { runWithoutDocumentOperationLease } from '@app/utils/runWithoutDocumentOperationLease';
import type * as WorkspaceOrchestration from '@app/modules/workspace-shell/types/workspaceOrchestration.types';
import type { TPageAnnotationActionsPdfViewer } from '@app/modules/workspace-shell/composables/pageAnnotationActionsPdfViewer';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    IShapeAnnotation,
    ITextMarkupAnnotationProperties,
    TAnnotationCommentsStatus,
    TAnnotationTool,
    TShapeAnnotationPatch,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import {
    getShapeRect,
    resolveAnnotationCommentTextMarkupColor,
    annotationIdForSummary,
    resolvePdfViewerSaveTransactionFinalBytes,
} from '@app/modules/pdf-viewer/public';
import { getAnnotationPageNumber } from '@app/modules/workspace-shell/annotations/getAnnotationPageNumber';
import { withOpenedAnnotationNoteCreationTimestamp } from '@app/modules/workspace-shell/annotations/withOpenedAnnotationNoteCreationTimestamp';
import { pickPageAnnotationImageFile } from '@app/modules/workspace-shell/annotations/pickPageAnnotationImageFile';
import { readPageAnnotationImageFileFromClipboard } from '@app/modules/workspace-shell/annotations/readPageAnnotationImageFileFromClipboard';
import { resolveShapeAnnotationDefaultSettings } from '@app/modules/workspace-shell/annotations/resolveShapeAnnotationDefaultSettings';
import { createPageAnnotationDeleteActions } from '@app/modules/workspace-shell/composables/createPageAnnotationDeleteActions';
interface IPageAnnotationActionsDeps {
    pdfViewerRef: Ref<TPageAnnotationActionsPdfViewer | null>;
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
    sidebarTab: Ref<WorkspaceOrchestration.TPdfSidebarTab>;
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
    removeAnnotationNoteWindow: (annotationId: string) => void;
    setAnnotationNoteWindowError: (annotationId: string, error: string | null) => void;
    isSameAnnotationComment: (a: IAnnotationCommentSummary, b: IAnnotationCommentSummary) => boolean;
    annotationNoteWindows: Ref<Array<{
        annotationId: string;
        draftText: string;
        createdAtMs?: number | undefined;
    }>>;
    loadPdfFromData: (data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean;
    }) => Promise<void>;
    waitForPdfReload: (page: number) => Promise<void>;
    invalidateThumbnailPages?: (pages: number[]) => void;
    markPreservedAnnotationSourceDirty?: () => void;
    setPreservedAnnotationSourceDirty?: (dirty: boolean) => void;
    getAnnotationCommentsSnapshot?: () => IAnnotationCommentSummary[];
    getAnnotationCommentsStatusSnapshot?: () => TAnnotationCommentsStatus;
    getEmbeddedMutationBaseData: () => Promise<Uint8Array | null>;
    embedPlacedImageToPage: (
        data: Uint8Array,
        placement: IPdfPlacedImageFinalizePayload,
    ) => Promise<Uint8Array>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const usePageAnnotationActions = (deps: IPageAnnotationActionsDeps) => {
    const { t } = useTypedI18n();
    const { clampToViewport } = useContextMenuPosition();
    const { copy: copyClipboardText } = VueUse.useClipboard();

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
        annotationNoteWindows,
        loadPdfFromData,
        waitForPdfReload,
        invalidateThumbnailPages,
        isSameAnnotationComment,
        getEmbeddedMutationBaseData,
        embedPlacedImageToPage,
        runWithDocumentOperationLease = runWithoutDocumentOperationLease,
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
    const viewerContainer = computed(() => pdfViewerRef.value?.getViewerContainer?.() ?? null);
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
        const viewerContainer = pdfViewerRef.value?.getViewerContainer?.();
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
        annotationActiveCommentStableKey.value = annotationIdForSummary(comment);
        showSidebar.value = true;
        sidebarTab.value = 'annotations';
        dragMode.value = false;
        await pdfViewerRef.value.focusAnnotationComment(comment);
    }

    function handleAnnotationCommentClick(comment: IAnnotationCommentSummary) {
        annotationActiveCommentStableKey.value = annotationIdForSummary(comment);
        dragMode.value = false;
    }

    function invalidateAnnotationPage(comment: IAnnotationCommentSummary) {
        const page = getAnnotationPageNumber(comment);
        pdfViewerRef.value?.invalidatePages([page]);
        invalidateThumbnailPages?.([page]);
    }

    function toAnnotationNoteWindowComment(note: {
        annotationId: string;
        draftText: string;
    }): IAnnotationCommentSummary | null {
        const comment = getAnnotationCommentsSnapshot()?.find(candidate => (
            annotationIdForSummary(candidate) === note.annotationId
        ));
        if (!comment) {
            return null;
        }
        return {
            ...comment,
            text: note.draftText,
            hasNote: true,
        };
    }

    function getAnnotationCommentsSnapshot() {
        return deps.getAnnotationCommentsSnapshot?.() ?? null;
    }

    function isAnnotationCommentsSnapshotReady() {
        return deps.getAnnotationCommentsStatusSnapshot?.() === 'ready';
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
            const comment = toAnnotationNoteWindowComment(note);
            if (!comment || stableKeys.has(comment.stableKey)) {
                return;
            }
            stableKeys.add(comment.stableKey);
            removeAnnotationNoteWindow(note.annotationId ?? annotationIdForSummary(comment));
        });
    }

    function removeDeletedAnnotationState(
        comment: IAnnotationCommentSummary,
        commentsBeforeDelete: IAnnotationCommentSummary[] | null = null,
    ) {
        const stableKeys = new Set<string>([comment.stableKey]);
        annotationNoteWindows.value
            .filter((note) => {
                const noteComment = toAnnotationNoteWindowComment(note);
                return Boolean(noteComment && isSameAnnotationComment(noteComment, comment)) || (
                    note.annotationId
                    ?? (noteComment ? annotationIdForSummary(noteComment) : null)
                ) === annotationIdForSummary(comment);
            })
            .forEach((note) => {
                const noteComment = toAnnotationNoteWindowComment(note);
                if (noteComment) stableKeys.add(noteComment.stableKey);
                removeAnnotationNoteWindow(note.annotationId ?? annotationIdForSummary(noteComment ?? comment));
            });

        if (shouldCloseRemainingNoteWindowsAfterExplicitDelete(commentsBeforeDelete)) {
            closeRemainingAnnotationNoteWindows(stableKeys);
        }

        if (
            annotationActiveCommentStableKey.value === annotationIdForSummary(comment)
        ) {
            annotationActiveCommentStableKey.value = null;
        }
    }

    function handleOpenAnnotationNote(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        const noteComment = withOpenedAnnotationNoteCreationTimestamp(comment);
        annotationActiveCommentStableKey.value = annotationIdForSummary(noteComment);
        openAnnotationNoteWindow(noteComment);
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
        const viewerContainer = pdfViewerRef.value?.getViewerContainer?.();
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
        const didUpdate = Boolean(
            selectedMarkup
            && pdfViewerRef.value?.updateSelectedTextMarkupAnnotationColor?.(color, selectedMarkup) === true,
        );
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
        invalidateAnnotationPage(nextComment);
        if (deps.setPreservedAnnotationSourceDirty) {
            deps.setPreservedAnnotationSourceDirty(colorEdited);
        } else if (colorEdited) {
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

    function updateTextMarkupColorWithHistory(
        comment: IAnnotationCommentSummary,
        color: string,
    ) {
        const previousColor = resolveContextTextMarkupUndoColor(comment);
        const previousColorEdited = comment.colorEdited === true;
        const didUpdate = applyContextTextMarkupColorUpdate(comment, color, { sourceColor: previousColor });
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
        return didUpdate;
    }

    function handleContextTextMarkupColorUpdate(color: string) {
        const comment = annotationContextMenu.value.comment;
        if (!comment) {
            return;
        }
        updateTextMarkupColorWithHistory(comment, color);
        closeAnnotationContextMenu();
    }

    function updateShapeDefaultSettings(
        updates: TShapeAnnotationPatch,
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

    function handleShapePropertyUpdate(updates: TShapeAnnotationPatch) {
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

    watch((): string | null => selectedShapeId.value, (shapeId, previousShapeId) => {
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

    VueUse.useEventListener(viewerContainer, 'scroll', handleViewportChange, { passive: true });
    VueUse.useEventListener(windowTarget, 'resize', handleViewportChange);
    VueUse.useEventListener(viewerContainer, 'pointerup', () => setTimeout(refreshSelectedTextMarkupProperties, 0));
    VueUse.useEventListener(viewerContainer, 'keyup', refreshSelectedTextMarkupProperties);

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
            annotationActiveCommentStableKey.value = annotationIdForSummary(payload.comment);
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
        try {
            const file = await pickPageAnnotationImageFile();
            if (!file) {
                return;
            }
            await viewer.startImagePlacement(file, {
                ...(pageNumber !== undefined ? { pageNumber } : {}),
                ...(pageX !== undefined ? { pageX } : {}),
                ...(pageY !== undefined ? { pageY } : {}),
            });
        } catch (error) {
            BrowserLogger.warn('annotations', 'Failed to insert image from file', error);
        }
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
            return await runWithDocumentOperationLease('page-operation', async () => {
                const capturedWorkingCopy = captureActiveWorkingCopy();
                const rawData = await getEmbeddedMutationBaseData();
                if (!rawData) {
                    pdfViewerRef.value?.restorePendingImagePlacement?.();
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
            });
        } catch (error) {
            BrowserLogger.warn('annotations', 'Failed to finalize placed image', error);
            pdfViewerRef.value?.restorePendingImagePlacement?.();
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

        const contextMenu = annotationContextMenu.value;
        const pageNumber = typeof contextMenu.pageNumber === 'number' && Number.isFinite(contextMenu.pageNumber) ? contextMenu.pageNumber : null;
        const pageX = typeof contextMenu.pageX === 'number' && Number.isFinite(contextMenu.pageX) ? contextMenu.pageX : null;
        const pageY = typeof contextMenu.pageY === 'number' && Number.isFinite(contextMenu.pageY) ? contextMenu.pageY : null;
        if (
            pageNumber === null
            || pageX === null
            || pageY === null
        ) {
            closeAnnotationContextMenu();
            return;
        }

        isCreatingContextMenuFreeNote = true;
        closeAnnotationContextMenu();
        try {
            await pdfViewerRef.value.commentAtPoint(
                pageNumber,
                pageX,
                pageY,
                { preferTextAnchor: false },
            );
        } catch (error) {
            BrowserLogger.diagnostic('note-placement', 'Failed to create note from annotation context menu', error);
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

        return runWithDocumentOperationLease('page-operation', async () => {
            const capturedWorkingCopy = captureActiveWorkingCopy();
            const saveTransaction = await pdfViewerRef.value?.runSaveTransaction({
                mode: 'embedded-mutation',
                forcePdfjsMaterialize: true,
            });
            const rawData = resolvePdfViewerSaveTransactionFinalBytes(saveTransaction);
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
        });
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

    const { handleDeleteAnnotationComment } = createPageAnnotationDeleteActions({
        pdfViewerRef,
        closeAnnotationContextMenu,
        getAnnotationCommentsSnapshot,
        getDeleteErrorMessage: () => t('errors.annotation.delete'),
        invalidateAnnotationPage,
        removeDeletedAnnotationState,
        setAnnotationNoteWindowError,
    });

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
        updateTextMarkupColorWithHistory,
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
        handleFinalizePlacedImage,
        insertImageFromFileAt,
        pasteImageFromClipboardAt,
    };
};
