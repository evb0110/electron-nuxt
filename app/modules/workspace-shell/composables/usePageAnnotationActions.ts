import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platformApi';
import {
    useClipboard,
    useEventListener,
} from '@vueuse/core';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';
import type {
    IPdfViewerExpose,
    TPdfSidebarTab,
} from '@app/modules/workspace-shell/composables/workspaceOrchestration.types';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdfImagePlacement';
import { getShapeRect } from '@app/composables/pdf/pdfShapeResize';
import { getDocumentsCapability } from '@app/utils/platformDocuments';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import {
    isNoteEligibleComment,
    markerRectCenterDistance,
} from '@app/composables/pdf/annotations/annotationRules';

const SUPPORTED_IMAGE_MIME_TYPES = [
    'image/apng',
    'image/avif',
    'image/bmp',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/svg+xml',
    'image/webp',
    'image/x-icon',
] as const;
const PREFERRED_CLIPBOARD_IMAGE_TYPES = SUPPORTED_IMAGE_MIME_TYPES.filter(type => type !== 'image/svg+xml');
const FRESH_NOTE_CREATION_UNDO_WINDOW_MS = 5_000;
const INVISIBLE_NOTE_PLACEHOLDER_RE = /[\u200B\uFEFF]/gu;

type TPdfViewerForAnnotationActions = Pick<IPdfViewerExpose,
    'cancelCommentPlacement'
    | 'commentAtPoint'
    | 'commentSelection'
    | 'deleteAnnotationComment'
    | 'deleteSelectedShape'
    | 'focusAnnotationComment'
    | 'getSelectedShape'
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
    markPreservedAnnotationSourceDirty?: () => void;
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

    function mimeTypeFromPath(path: string) {
        const normalized = path.toLowerCase();
        if (normalized.endsWith('.apng')) {
            return 'image/apng';
        }
        if (normalized.endsWith('.avif')) {
            return 'image/avif';
        }
        if (normalized.endsWith('.bmp')) {
            return 'image/bmp';
        }
        if (normalized.endsWith('.gif')) {
            return 'image/gif';
        }
        if (normalized.endsWith('.jpeg') || normalized.endsWith('.jpg')) {
            return 'image/jpeg';
        }
        if (normalized.endsWith('.png')) {
            return 'image/png';
        }
        if (normalized.endsWith('.svg') || normalized.endsWith('.svgz')) {
            return 'image/svg+xml';
        }
        if (normalized.endsWith('.webp')) {
            return 'image/webp';
        }
        if (normalized.endsWith('.ico')) {
            return 'image/x-icon';
        }
        return 'image/png';
    }

    function extensionForMimeType(mimeType: string) {
        switch (mimeType) {
            case 'image/apng':
                return 'apng';
            case 'image/avif':
                return 'avif';
            case 'image/bmp':
                return 'bmp';
            case 'image/gif':
                return 'gif';
            case 'image/jpeg':
                return 'jpg';
            case 'image/png':
                return 'png';
            case 'image/webp':
                return 'webp';
            case 'image/x-icon':
                return 'ico';
            default:
                return 'img';
        }
    }

    async function pickImageFile() {
        const documents = getDocumentsCapability();
        const imagePath = await documents.openImageDialog();
        if (!imagePath) {
            return null;
        }

        try {
            const bytes = await documents.readFile(imagePath);
            const fileBytes = Uint8Array.from(bytes);
            const mimeType = mimeTypeFromPath(imagePath);
            const fileName = imagePath.split(/[\\/]/).pop() ?? `image.${extensionForMimeType(mimeType)}`;
            return new File([fileBytes], fileName, {
                type: mimeType,
                lastModified: Date.now(),
            });
        } finally {
            if (typeof documents.cleanupFile === 'function') {
                await documents.cleanupFile(imagePath).catch(() => {});
            }
        }
    }

    async function readImageFileFromClipboard() {
        if (!globalThis.navigator?.clipboard || typeof globalThis.navigator.clipboard.read !== 'function') {
            return null;
        }

        const items = await globalThis.navigator.clipboard.read();
        for (const item of items) {
            const mimeType = PREFERRED_CLIPBOARD_IMAGE_TYPES.find(type => item.types.includes(type));
            if (!mimeType) {
                continue;
            }

            const blob = await item.getType(mimeType);
            return new File([blob], `clipboard-image.${extensionForMimeType(mimeType)}`, {
                type: mimeType,
                lastModified: Date.now(),
            });
        }

        return null;
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

    function withOpenedAnnotationNoteCreationTimestamp(comment: IAnnotationCommentSummary) {
        if (comment.source !== 'editor' || comment.createdAt || comment.modifiedAt) {
            return comment;
        }
        return {
            ...comment,
            createdAt: Date.now(),
        };
    }

    function getAnnotationPageNumber(comment: IAnnotationCommentSummary) {
        const pageNumber = Number.isFinite(comment.pageNumber)
            ? comment.pageNumber
            : comment.pageIndex + 1;
        return Math.max(1, Math.round(pageNumber));
    }

    function invalidateAnnotationPage(comment: IAnnotationCommentSummary) {
        const page = getAnnotationPageNumber(comment);
        pdfViewerRef.value?.invalidatePages([page]);
        invalidateThumbnailPages?.([page]);
    }

    function hasOpenAnnotationNoteWindow(comment: IAnnotationCommentSummary) {
        return annotationNoteWindows.value.some(note => commentsShareDeleteTarget(note.comment, comment));
    }

    function isFreshEditorNoteCreationForUndo(
        originalComment: IAnnotationCommentSummary,
        noteComment: IAnnotationCommentSummary,
        wasAlreadyOpen: boolean,
    ) {
        if (
            wasAlreadyOpen
            || originalComment.source !== 'editor'
            || noteComment.source !== 'editor'
            || !isNoteEligibleComment(noteComment)
            || noteComment.text.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim().length > 0
        ) {
            return false;
        }

        const timestamp = noteComment.createdAt ?? noteComment.modifiedAt;
        return typeof timestamp === 'number'
            && Number.isFinite(timestamp)
            && Math.abs(Date.now() - timestamp) <= FRESH_NOTE_CREATION_UNDO_WINDOW_MS;
    }

    function isUndoableFreshEmptyEditorNote(note: {
        comment: IAnnotationCommentSummary;
        text?: string | undefined;
        createdAtMs?: number | undefined;
    }) {
        const { comment } = note;
        const noteText = typeof note.text === 'string' ? note.text : comment.text;
        if (
            comment.source !== 'editor'
            || !isNoteEligibleComment(comment)
            || noteText.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim().length > 0
        ) {
            return false;
        }

        const timestamp = comment.createdAt ?? comment.modifiedAt ?? note.createdAtMs;
        return (
            typeof timestamp !== 'number'
            || !Number.isFinite(timestamp)
            || Math.abs(Date.now() - timestamp) <= FRESH_NOTE_CREATION_UNDO_WINDOW_MS
        );
    }

    function commentsShareDeleteTarget(
        left: IAnnotationCommentSummary,
        right: IAnnotationCommentSummary,
    ) {
        if (left.stableKey && left.stableKey === right.stableKey) {
            return true;
        }
        if (isSameAnnotationComment(left, right)) {
            return true;
        }
        if (left.pageIndex !== right.pageIndex) {
            return false;
        }
        if (left.annotationId && left.annotationId === right.annotationId) {
            return true;
        }
        if (left.uid && left.uid === right.uid) {
            return true;
        }
        if (left.id && left.id === right.id && left.source === right.source) {
            return true;
        }
        if (!isNoteEligibleComment(left) || !isNoteEligibleComment(right)) {
            return false;
        }

        const leftText = left.text.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim();
        const rightText = right.text.replace(INVISIBLE_NOTE_PLACEHOLDER_RE, '').trim();
        const sameText = leftText.length > 0 && leftText === rightText;
        const closePlacement = markerRectCenterDistance(left.markerRect, right.markerRect) < 0.035;
        const oneHasStableEditorRef = Boolean(left.annotationId || left.uid) !== Boolean(right.annotationId || right.uid);
        return (
            sameText && (closePlacement || oneHasStableEditorRef)
        ) || (
            closePlacement && oneHasStableEditorRef
        );
    }

    function removeDeletedAnnotationState(comment: IAnnotationCommentSummary) {
        const stableKeys = new Set<string>([comment.stableKey]);
        annotationNoteWindows.value
            .filter(note => commentsShareDeleteTarget(note.comment, comment))
            .forEach((note) => {
                stableKeys.add(note.comment.stableKey);
                removeAnnotationNoteWindow(note.comment.stableKey);
            });

        stableKeys.forEach(stableKey => removeAnnotationFromCache(stableKey));
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

        const undoCreate = () => {
            viewer.removeAnnotationFromDom(noteComment);
            viewer.removeAnnotationFromInternalCache(noteComment.stableKey);
            removeDeletedAnnotationState(noteComment);
            invalidateAnnotationPage(noteComment);
        };
        const redoCreate = () => {
            restoreAnnotationToCache(noteComment);
            viewer.restoreAnnotationToInternalCache?.(noteComment);
            openAnnotationNoteWindow(noteComment);
            annotationActiveCommentStableKey.value = noteComment.stableKey;
            invalidateAnnotationPage(noteComment);
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

    function updateShapeColorDefault(
        settings: IAnnotationSettings,
        isInkShape: boolean,
        color: string | null | undefined,
    ) {
        if (typeof color !== 'string' || !color.trim()) {
            return false;
        }
        if (isInkShape) {
            settings.inkColor = color;
        } else {
            settings.shapeColor = color;
        }
        return true;
    }

    function updateShapeStrokeWidthDefault(
        settings: IAnnotationSettings,
        isInkShape: boolean,
        strokeWidth: number | null | undefined,
    ) {
        if (typeof strokeWidth !== 'number' || !Number.isFinite(strokeWidth)) {
            return false;
        }
        if (isInkShape) {
            settings.inkThickness = strokeWidth;
        } else {
            settings.shapeStrokeWidth = strokeWidth;
        }
        return true;
    }

    function updateShapeOpacityDefault(
        settings: IAnnotationSettings,
        isInkShape: boolean,
        opacity: number | null | undefined,
    ) {
        if (typeof opacity !== 'number' || !Number.isFinite(opacity)) {
            return false;
        }
        if (isInkShape) {
            settings.inkOpacity = opacity;
        } else {
            settings.shapeOpacity = opacity;
        }
        return true;
    }

    function updateShapeFillColorDefault(
        settings: IAnnotationSettings,
        fillColor: string | null | undefined,
    ) {
        settings.shapeFillColor = fillColor ?? 'transparent';
        return true;
    }

    function updateShapeDefaultSettings(
        updates: Partial<IShapeAnnotation>,
        isInkShape: boolean,
    ) {
        const nextSettings: IAnnotationSettings = { ...annotationSettings.value };
        const didUpdateDefaults = [
            updateShapeColorDefault(nextSettings, isInkShape, updates.color),
            updateShapeStrokeWidthDefault(nextSettings, isInkShape, updates.strokeWidth),
            updateShapeOpacityDefault(nextSettings, isInkShape, updates.opacity),
            'fillColor' in updates
                ? updateShapeFillColorDefault(nextSettings, updates.fillColor)
                : false,
        ].some(Boolean);

        if (didUpdateDefaults) {
            annotationSettings.value = nextSettings;
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
    }

    useEventListener(viewerContainer, 'scroll', handleViewportChange, { passive: true });
    useEventListener(windowTarget, 'resize', handleViewportChange);

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
        const file = await pickImageFile();
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
            const file = await readImageFileFromClipboard();
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
            const rawData = await getEmbeddedMutationBaseData();
            if (!rawData) {
                pdfViewerRef.value.restorePendingImagePlacement?.();
                return false;
            }

            const capturedWorkingCopy = captureActiveWorkingCopy();
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
            await restorePromise;
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

        const rawData = await pdfViewerRef.value.saveDocument();
        if (!rawData) {
            return false;
        }

        const pageToRestore = currentPage.value;
        const restorePromise = waitForPdfReload(pageToRestore);
        await loadPdfFromData(rawData, {
            pushHistory: true,
            persistWorkingCopy: !!workingCopyPath.value,
        });
        await restorePromise;
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
            deps.markPreservedAnnotationSourceDirty?.();
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
        if (shouldUseEmbeddedDeletePath(comment)) {
            const deleted = deleteAnnotationCommentWithFallbacks(comment, false);
            if (!deleted) {
                handleAnnotationDeleteFailure(comment);
                return;
            }
            removeDeletedAnnotationState(comment);
            return;
        }

        const viewerDeleted = await viewer.deleteAnnotationComment(comment);
        BrowserLogger.debug('annotations', 'Delete annotation comment viewer result', {
            stableKey: comment.stableKey,
            deleted: viewerDeleted,
        });

        const deleted = deleteAnnotationCommentWithFallbacks(comment, viewerDeleted);
        if (!deleted) {
            handleAnnotationDeleteFailure(comment);
            return;
        }
        removeDeletedAnnotationState(comment);
        invalidateAnnotationPage(comment);
    }

    async function handleDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        annotationDeleteQueue = annotationDeleteQueue
            .catch(() => undefined)
            .then(async () => {
                await performDeleteAnnotationComment(comment);
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
        handleCommentSelection,
        handleQuickNoteAction,
        handleStartPlaceNote,
        handleAnnotationFocusComment,
        handleAnnotationCommentClick,
        handleOpenAnnotationNote,
        closeShapeProperties,
        handleDeleteSelectedShape,
        handleShapePropertyUpdate,
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
