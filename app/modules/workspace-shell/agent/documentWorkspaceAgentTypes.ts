import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfViewMode } from '@contracts/shared';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import type {
    IAnnotationCommentSummary,
    TAnnotationCommentsStatus,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IAnnotationNoteWindowState } from '@app/utils/pdf-viewer/annotations/annotationNoteWindowTypes';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/types/workspaceOrchestration.types';

export type TWorkspaceAgentSidebarTab = 'annotations' | 'bookmarks' | 'thumbnails' | 'search';
export type TWorkspaceAgentFitMode = 'width' | 'height';
export type TWorkspaceAgentRotateAngle = 90 | 180 | 270;
export type TWorkspaceAgentTranslate = (key: 'bookmarks.untitled') => string;

export type TAgentOcrPageRange = 'all' | 'current' | 'custom';

export interface IAgentOcrRunOptions {
    pageRange?: TAgentOcrPageRange;
    customRange?: string;
    languages?: string[];
    open?: boolean;
}

export interface IOcrPopupAgentExpose {
    runOcrForAgent: (options?: IAgentOcrRunOptions) => Promise<Record<string, unknown>>;
    cancelOcrForAgent: () => Record<string, unknown>;
    getAgentOcrSnapshot: () => Record<string, unknown>;
}

export interface IUseDocumentWorkspaceAgentOptions {
    annotationComments: Ref<IAnnotationCommentSummary[]>;
    annotationCommentsStatus: Ref<TAnnotationCommentsStatus>;
    annotationDirty: Ref<boolean>;
    annotationPlacingPageNote: Ref<boolean>;
    annotationTool: Ref<TAnnotationTool>;
    bookmarkItems: Ref<IPdfBookmarkEntry[]>;
    bookmarksDirty: Ref<boolean>;
    canSave: Ref<boolean>;
    closeAllDropdowns: () => void;
    closeShapeProperties: () => void;
    closeTextMarkupProperties: () => void;
    continuousScroll: Ref<boolean>;
    currentPage: Ref<number>;
    dragMode: Ref<boolean>;
    enableDragMode: () => void;
    fitMode: Ref<unknown>;
    handleActualSize: () => void;
    handleAnnotationFocusComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    handleAnnotationToolChange: (tool: TAnnotationTool) => void;
    handleBookmarksChange: (payload: {
        bookmarks: IPdfBookmarkEntry[];
        dirty: boolean;
    }) => void;
    handleDeleteAnnotationComment: (comment: IAnnotationCommentSummary) => Promise<void>;
    handleDropdownOpen: (dropdown: 'ocr', open: boolean) => void;
    handleExportDocx: () => Promise<unknown>;
    handleExportImages: () => Promise<unknown>;
    handleExportMultiPageTiff: () => Promise<unknown>;
    handleFitMode: (mode: TWorkspaceAgentFitMode) => void;
    handleGoToPage: (page: number) => void;
    handleOpenAnnotationNote: (comment: IAnnotationCommentSummary) => void;
    handleOpenFileFromUi: () => Promise<unknown>;
    handlePageLabelRangesUpdate: (ranges: IPdfPageLabelRange[]) => void;
    handlePageRotate: (pages: number[], degrees: TWorkspaceAgentRotateAngle) => Promise<unknown>;
    handlePrint: () => void;
    handlePrintCurrentPage: () => Promise<unknown>;
    handleQuickNoteAction: () => Promise<unknown>;
    handleSave: () => Promise<boolean>;
    handleSaveAs: () => Promise<unknown>;
    handleZoomIn: () => void;
    handleZoomOut: () => void;
    hasPdf: Ref<boolean>;
    isAnySaving: Ref<boolean>;
    isDjvuMode: Ref<boolean>;
    isSameAnnotationComment: (left: IAnnotationCommentSummary, right: IAnnotationCommentSummary) => boolean;
    markAnnotationDirty: () => void;
    ocrPopupOpen: Ref<boolean>;
    ocrPopupRef: Ref<IOcrPopupAgentExpose | null>;
    openConvertDialog: () => void;
    originalPath: Ref<TDocumentRef | null>;
    pageLabelRanges: Ref<IPdfPageLabelRange[]>;
    pageLabels: Ref<string[] | null>;
    pageLabelsDirty: Ref<boolean>;
    pageOpsDelete: (pages: number[], totalPages: number) => Promise<unknown>;
    pageOpsExtract: (pages: number[]) => Promise<unknown>;
    pageOpsInsert: (totalPages: number, afterPage: number) => Promise<unknown>;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    selectedThumbnailPages: Ref<number[]>;
    showConvertDialog: Ref<boolean>;
    showSidebar: Ref<boolean>;
    sidebarTab: Ref<TWorkspaceAgentSidebarTab>;
    sortedAnnotationNoteWindows: Ref<IAnnotationNoteWindowState[]>;
    t: TWorkspaceAgentTranslate;
    tabId: string;
    totalPages: Ref<number>;
    updateAnnotationNoteText: (stableKey: string, text: string) => void;
    viewMode: Ref<TPdfViewMode>;
    workingCopyPath: Ref<TDocumentRef | null>;
    zoom: Ref<number>;
}
