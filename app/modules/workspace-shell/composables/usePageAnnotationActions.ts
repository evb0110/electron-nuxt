import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platform-api';
import { BrowserLogger } from '@app/utils/browser-logger';
import { useContextMenuPosition } from '@app/composables/useContextMenuPosition';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
    IShapeAnnotation,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfPlacedImageFinalizePayload } from '@app/types/pdf-image-placement';
import { getElectronAPI } from '@app/utils/platform';

type TPdfSidebarTab = 'annotations' | 'thumbnails' | 'bookmarks' | 'search';
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

interface IPdfViewerForAnnotationActions {
    commentSelection: () => Promise<boolean>;
    commentAtPoint: (
        pageNumber: number,
        pageX: number,
        pageY: number,
        options?: { preferTextAnchor?: boolean },
    ) => Promise<boolean>;
    startCommentPlacement: () => void;
    cancelCommentPlacement: () => void;
    focusAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    highlightSelection: () => Promise<boolean>;
    updateAnnotationComment: (comment: IAnnotationCommentSummary, text: string) => boolean;
    deleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<boolean>;
    suppressAnnotationId: (id: string) => void;
    removeAnnotationFromDom: (comment: IAnnotationCommentSummary) => void;
    removeAnnotationFromInternalCache: (stableKey: string) => void;
    selectedShapeId: string | null;
    updateShape: (id: string, updates: Partial<IShapeAnnotation>) => void;
    getSelectedShape: () => IShapeAnnotation | null;
    deleteSelectedShape: () => void;
    saveDocument: () => Promise<Uint8Array | null>;
    startImagePlacement: (
        file: File,
        options?: {
            pageNumber?: number | null;
            pageX?: number | null;
            pageY?: number | null;
        },
    ) => Promise<boolean>;
    restorePendingImagePlacement?: () => void;
}

interface IPageAnnotationActionsDeps {
    pdfViewerRef: Ref<IPdfViewerForAnnotationActions | null>;
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
    annotationNoteWindows: Ref<Array<{ comment: IAnnotationCommentSummary }>>;
    deleteEmbeddedByRef: (comment: IAnnotationCommentSummary) => Promise<Uint8Array | null>;
    loadPdfFromData: (data: Uint8Array, opts?: {
        pushHistory?: boolean;
        persistWorkingCopy?: boolean;
    }) => Promise<void>;
    waitForPdfReload: (page: number) => Promise<void>;
    removeAnnotationFromCache: (stableKey: string) => void;
    persistPdfDataSilently: (data: Uint8Array) => Promise<void>;
    markAnnotationSaved: () => void;
    resetAnnotationStorageModified: () => void;
    embedPlacedImageToPage: (
        data: Uint8Array,
        placement: IPdfPlacedImageFinalizePayload,
    ) => Promise<Uint8Array>;
}

export const usePageAnnotationActions = (deps: IPageAnnotationActionsDeps) => {
    const { t } = useTypedI18n();
    const { clampToViewport } = useContextMenuPosition();

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
        embedPlacedImageToPage,
    } = deps;

    const shapePropertiesPopover = ref<{
        visible: boolean;
        x: number;
        y: number;
    }>({
        visible: false,
        x: 0,
        y: 0,
    });

    const selectedShapeForProperties = computed(() =>
        shapePropertiesPopover.value.visible
            ? pdfViewerRef.value?.getSelectedShape() ?? null
            : null,
    );

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
        const documents = getElectronAPI().documents;
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

    function handleOpenAnnotationNote(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        annotationActiveCommentStableKey.value = comment.stableKey;
        openAnnotationNoteWindow(comment);
        dragMode.value = false;
    }

    function closeShapeProperties() {
        shapePropertiesPopover.value = {
            visible: false,
            x: 0,
            y: 0,
        };
    }

    function handleShapePropertyUpdate(updates: Partial<IShapeAnnotation>) {
        const id = pdfViewerRef.value?.selectedShapeId;
        if (!id) {
            return;
        }

        const nextSettings: IAnnotationSettings = { ...annotationSettings.value };
        let didUpdateDefaults = false;
        if (typeof updates.color === 'string' && updates.color.trim()) {
            nextSettings.shapeColor = updates.color;
            didUpdateDefaults = true;
        }
        if (typeof updates.strokeWidth === 'number' && Number.isFinite(updates.strokeWidth)) {
            nextSettings.shapeStrokeWidth = updates.strokeWidth;
            didUpdateDefaults = true;
        }
        if (typeof updates.opacity === 'number' && Number.isFinite(updates.opacity)) {
            nextSettings.shapeOpacity = updates.opacity;
            didUpdateDefaults = true;
        }
        if ('fillColor' in updates) {
            const fill = updates.fillColor ?? 'transparent';
            nextSettings.shapeFillColor = fill;
            didUpdateDefaults = true;
        }
        if (didUpdateDefaults) {
            annotationSettings.value = nextSettings;
        }

        pdfViewerRef.value?.updateShape(id, updates);
    }

    function handleShapeContextMenu(payload: {
        shapeId: string;
        clientX: number;
        clientY: number;
    }) {
        closeAnnotationContextMenu();
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
            pageNumber,
            pageX,
            pageY,
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
                pageNumber,
                pageX,
                pageY,
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
            const rawData = await pdfViewerRef.value.saveDocument();
            if (!rawData) {
                pdfViewerRef.value.restorePendingImagePlacement?.();
                return false;
            }

            const embeddedData = await embedPlacedImageToPage(rawData, placement);
            const pageToRestore = placement.pageNumber || currentPage.value;
            const restorePromise = waitForPdfReload(pageToRestore);
            await loadPdfFromData(embeddedData, {
                pushHistory: true,
                persistWorkingCopy: !!workingCopyPath.value,
            });
            await restorePromise;
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
            await navigator.clipboard.writeText(text);
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

        await pdfViewerRef.value.commentAtPoint(
            pageNumber as number,
            pageX as number,
            pageY as number,
            { preferTextAnchor: false },
        );
        closeAnnotationContextMenu();
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
            await navigator.clipboard.writeText(text);
        } catch (error) {
            BrowserLogger.debug('annotations', 'Failed to copy annotation comment text to clipboard', error);
        }
    }

    let annotationDeleteQueue: Promise<void> = Promise.resolve();

    async function performDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        closeAnnotationContextMenu();
        if (!pdfViewerRef.value) {
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
        let deleted = await pdfViewerRef.value.deleteAnnotationComment(comment);
        BrowserLogger.debug('annotations', 'Delete annotation comment viewer result', {
            stableKey: comment.stableKey,
            deleted,
        });
        // PDF-sourced annotations render via the annotation layer, not the
        // editor layer. uiManager.delete() operates on the editor layer and
        // may falsely report success. Always attempt embedded-level fallback.
        if (!deleted || comment.source === 'pdf' || Boolean(comment.annotationId)) {
            if (comment.annotationId && pdfViewerRef.value) {
                // Optimistic path — instant visual removal, no PDF reload
                pdfViewerRef.value.suppressAnnotationId(comment.annotationId);
                pdfViewerRef.value.removeAnnotationFromDom(comment);
                pdfViewerRef.value.removeAnnotationFromInternalCache(comment.stableKey);
                deps.removeAnnotationFromCache(comment.stableKey);
                deleted = true;

                // Persist: rewrite PDF bytes without the annotation, then save to disk
                try {
                    const updatedData = await deps.deleteEmbeddedByRef(comment);
                    if (updatedData) {
                        await deps.persistPdfDataSilently(updatedData);
                        deps.markAnnotationSaved();
                        deps.resetAnnotationStorageModified();
                    } else {
                        BrowserLogger.warn('annotations', 'Embedded delete returned no data', {
                            stableKey: comment.stableKey,
                            annotationId: comment.annotationId,
                        });
                    }
                } catch (err) {
                    BrowserLogger.warn('annotations', 'Embedded delete or persist failed', {
                        stableKey: comment.stableKey,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            } else {
                // Fallback for annotations without ID — use reload path
                BrowserLogger.debug('annotations', 'Attempting PDF-level embedded delete fallback (reload)', {
                    stableKey: comment.stableKey,
                    source: comment.source,
                    annotationId: null,
                });
                const updatedData = await deps.deleteEmbeddedByRef(comment);
                if (updatedData) {
                    const pageToRestore = currentPage.value;
                    const restorePromise = waitForPdfReload(pageToRestore);
                    await loadPdfFromData(updatedData, {
                        pushHistory: true,
                        persistWorkingCopy: !!workingCopyPath.value,
                    });
                    await restorePromise;
                    deleted = true;
                }
            }
        }
        if (!deleted) {
            BrowserLogger.warn('annotations', 'Delete annotation comment failed after all fallbacks', {
                stableKey: comment.stableKey,
                source: comment.source,
                annotationId: comment.annotationId ?? null,
                uid: comment.uid ?? null,
                id: comment.id,
            });
            setAnnotationNoteWindowError(comment.stableKey, t('errors.annotation.delete'));
            return;
        }
        annotationNoteWindows.value
            .filter(note => isSameAnnotationComment(note.comment, comment))
            .forEach(note => removeAnnotationNoteWindow(note.comment.stableKey));
    }

    async function handleDeleteAnnotationComment(comment: IAnnotationCommentSummary) {
        annotationDeleteQueue = annotationDeleteQueue
            .catch(() => undefined)
            .then(async () => {
                await performDeleteAnnotationComment(comment);
            });
        await annotationDeleteQueue;
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
        handleFinalizePlacedImage,
        insertImageFromFileAt,
        pasteImageFromClipboardAt,
    };
};
