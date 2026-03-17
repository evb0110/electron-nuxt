import type {
    ComputedRef,
    Ref,
} from 'vue';
import { ZOOM } from '@app/constants/pdf-layout';
import { usePageShortcuts } from '@app/modules/workspace-shell/composables/usePageShortcuts';
import { useWorkspaceCrop } from '@app/modules/workspace-shell/composables/useWorkspaceCrop';
import { useWorkspaceSplitPayload } from '@app/modules/workspace-shell/composables/useWorkspaceSplitPayload';
import { useWorkspaceViewerDefaults } from '@app/modules/workspace-shell/composables/useWorkspaceViewerDefaults';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspace-orchestration.types';
import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';
import type { ISettingsData } from '@contracts/shared';
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
    showSettings: Ref<boolean>;
    annotationTool: Ref<TAnnotationTool>;
    annotationPlacingPageNote: Ref<boolean>;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    shapePropertiesPopoverVisible: ComputedRef<boolean>;
    annotationContextMenuVisible: ComputedRef<boolean>;
    pageContextMenuVisible: ComputedRef<boolean>;
    closeAnnotationContextMenu: () => void;
    closePageContextMenu: () => void;
    closeShapeProperties: () => void;
    openSearch: () => void;
    openAnnotations: () => void;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
    handleSave: () => Promise<void>;
    handleDropdownOpenChange: (
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow',
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
    openFileWithDjvuCleanup: (result: TOpenFileResult) => Promise<void>;
    waitForPdfReload: (page: number) => Promise<void>;
    loadPdfFromPath: (path: TDocumentRef, options?: { markDirty?: boolean }) => Promise<void>;
}

export function useWorkspaceInteractionControls(options: IWorkspaceInteractionControlsOptions) {
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

    const {
        setupShortcuts,
        cleanupShortcuts,
    } = usePageShortcuts({
        isActive,
        pdfSrc,
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
        handleZoomIn: () => {
            setCustomZoomFromDisplay(resolveDisplayZoom() + ZOOM.STEP);
        },
        handleZoomOut: () => {
            setCustomZoomFromDisplay(resolveDisplayZoom() - ZOOM.STEP);
        },
        handleActualSize: () => {
            setCustomZoomFromDisplay(1);
        },
        handleSave: () => {
            void handleSave();
        },
    });

    const isCapturingRegion = computed(() => pdfViewerRef.value?.isCapturingRegion ?? false);

    function handleCaptureRegion() {
        if (!pdfViewerRef.value) {
            return;
        }
        void pdfViewerRef.value.captureRegionToClipboard();
    }

    const {
        cropDialogOpen,
        cropDialogMargins,
        cropDialogMediaBox,
        cropDialogCurrentBox,
        isCropSelecting,
        handleCrop,
    } = useWorkspaceCrop({
        pdfViewerRef,
        workingCopyPath,
    });

    function handleDropdownOpen(
        dropdown: 'zoom' | 'page' | 'ocr' | 'overflow',
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
        pdfData,
        openFileWithDjvuCleanup,
        waitForPdfReload,
        loadPdfFromPath,
    });

    return {
        setupShortcuts,
        cleanupShortcuts,
        isCapturingRegion,
        handleCaptureRegion,
        cropDialogOpen,
        cropDialogMargins,
        cropDialogMediaBox,
        cropDialogCurrentBox,
        isCropSelecting,
        handleCrop,
        handleDropdownOpen,
        captureSplitPayload,
        restoreSplitPayload,
    };
}
