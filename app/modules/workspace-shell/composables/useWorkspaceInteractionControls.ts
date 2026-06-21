import type {
    ComputedRef,
    Ref,
} from 'vue';
import { ZOOM } from '@app/constants/pdfLayout';
import { usePageShortcuts } from '@app/modules/workspace-shell/composables/usePageShortcuts';
import { useWorkspaceCrop } from '@app/modules/workspace-shell/composables/useWorkspaceCrop';
import { useWorkspaceSplitPayload } from '@app/modules/workspace-shell/composables/useWorkspaceSplitPayload';
import { useWorkspaceViewerDefaults } from '@app/modules/workspace-shell/composables/useWorkspaceViewerDefaults';
import type {
    IDocumentViewerExpose,
    IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { ISettingsData } from '@contracts/shared';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    TFitMode,
    TPdfSource,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdf';

interface IWorkspaceInteractionControlsOptions {
    isActive: Ref<boolean>;
    appSettings: Ref<ISettingsData>;
    annotationSettings: Ref<IAnnotationSettings>;
    viewMode: Ref<TPdfViewMode>;
    continuousScroll: Ref<boolean>;
    fitMode: Ref<TFitMode>;
    zoom: Ref<number>;
    effectiveZoom: Ref<number>;
    zoomMode: Ref<TZoomMode>;
    pdfSrc: Ref<TPdfSource | null>;
    canSave: Ref<boolean>;
    showSettings: Ref<boolean>;
    annotationTool: Ref<TAnnotationTool>;
    annotationPlacingPageNote: Ref<boolean>;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    documentViewerRef: Ref<IDocumentViewerExpose | null>;
    shapePropertiesPopoverVisible: ComputedRef<boolean>;
    annotationContextMenuVisible: ComputedRef<boolean>;
    pageContextMenuVisible: ComputedRef<boolean>;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeShapeProperties: () => void;
    openSearch: () => void;
    openAnnotations: () => void;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
    handleSave: () => Promise<unknown>;
    handlePrint: () => void | Promise<void>;
    handleToggleSidebar: () => void;
    handleDropdownOpenChange: (
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) => void;
    clearDocxExportError: () => void;
    workingCopyPath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    currentPage: Ref<number>;
    totalPages: Ref<number>;
    fileName: Ref<string | null>;
    originalPath: Ref<TDocumentRef | null>;
    hasPendingTabChanges: ComputedRef<boolean>;
    pdfData: Ref<Uint8Array | null>;
    openFileWithDjvuCleanup: (result: TOpenFileResult) => Promise<TDocumentOpenOutcome>;
    waitForPdfReload: (page: number) => Promise<void>;
    loadPdfFromPath: (path: TDocumentRef, options?: { markDirty?: boolean }) => Promise<void>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const useWorkspaceInteractionControls = (options: IWorkspaceInteractionControlsOptions) => {
    const {
        isActive,
        appSettings,
        annotationSettings,
        viewMode,
        continuousScroll,
        fitMode,
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
        showSettings,
        annotationTool,
        annotationPlacingPageNote,
        pdfViewerRef,
        documentViewerRef,
        shapePropertiesPopoverVisible,
        annotationContextMenuVisible,
        pageContextMenuVisible,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
        openAnnotations,
        handleAnnotationToolChange,
        handleSave,
        handleDropdownOpenChange,
        clearDocxExportError,
        workingCopyPath,
        isDjvuMode,
        djvuSourcePath,
        currentPage,
        totalPages,
        fileName,
        originalPath,
        hasPendingTabChanges,
        pdfData,
        openFileWithDjvuCleanup,
        waitForPdfReload,
        loadPdfFromPath,
        runWithDocumentOperationLease,
    } = options;

    const {
        resolveDisplayZoom,
        setCustomZoomFromDisplay,
    } = useWorkspaceViewerDefaults({
        appSettings,
        annotationSettings,
        viewMode,
        continuousScroll,
        fitMode,
        zoom,
        effectiveZoom,
        zoomMode,
        pdfSrc,
    });

    function handleZoomIn() {
        setCustomZoomFromDisplay(resolveDisplayZoom() + ZOOM.STEP);
    }

    function handleZoomOut() {
        setCustomZoomFromDisplay(resolveDisplayZoom() - ZOOM.STEP);
    }

    usePageShortcuts({
        isActive,
        pdfSrc,
        canSave: options.canSave,
        showSettings,
        annotationTool,
        annotationPlacingPageNote,
        pdfViewerRef,
        shapePropertiesPopoverVisible,
        annotationContextMenuVisible,
        pageContextMenuVisible,
        closeAnnotationContextMenu,
        closePageContextMenu,
        closeShapeProperties,
        openSearch,
        openAnnotations,
        handleAnnotationToolChange,
        handleZoomIn,
        handleZoomOut,
        handleActualSize: () => {
            setCustomZoomFromDisplay(1);
        },
        handleSave: () => {
            void handleSave();
        },
        handlePrint: () => {
            void options.handlePrint();
        },
        handleToggleSidebar: options.handleToggleSidebar,
    });

    const isCapturingRegion = computed(() => pdfViewerRef.value?.isCapturingRegion ?? false);

    function handleCaptureRegion() {
        if (!pdfViewerRef.value || isDjvuMode.value) {
            return;
        }
        void pdfViewerRef.value.captureRegionToClipboard();
    }

    function handleActualSize() {
        setCustomZoomFromDisplay(1);
    }

    const {
        cropDialogOpen,
        cropDialogLoading,
        cropDialogMargins,
        cropDialogMediaBox,
        cropDialogCurrentBox,
        cropDialogPageNumber,
        cropDialogRotation,
        isCropSelecting,
        handleCrop,
    } = useWorkspaceCrop({
        pdfViewerRef,
        workingCopyPath,
    });

    function handleDropdownOpen(
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow' | 'appMenu',
        isOpen: boolean,
    ) {
        handleDropdownOpenChange(dropdown, isOpen);
        if (isOpen && dropdown === 'ocr') {
            clearDocxExportError();
        }
    }

    const {
        captureSplitPayload,
        restoreSplitPayload,
    } = useWorkspaceSplitPayload({
        pdfSrc,
        isDjvuMode,
        djvuSourcePath,
        currentPage,
        totalPages,
        fileName,
        originalPath,
        workingCopyPath,
        hasPendingTabChanges,
        pdfViewerRef,
        documentViewerRef,
        pdfData,
        openFileWithDjvuCleanup,
        waitForPdfReload,
        loadPdfFromPath,
        ...(runWithDocumentOperationLease !== undefined ? { runWithDocumentOperationLease } : {}),
    });

    return {
        isCapturingRegion,
        handleZoomIn,
        handleZoomOut,
        handleCaptureRegion,
        handleActualSize,
        cropDialogOpen,
        cropDialogLoading,
        cropDialogMargins,
        cropDialogMediaBox,
        cropDialogCurrentBox,
        cropDialogPageNumber,
        cropDialogRotation,
        isCropSelecting,
        handleCrop,
        handleDropdownOpen,
        captureSplitPayload,
        restoreSplitPayload,
    };
};
