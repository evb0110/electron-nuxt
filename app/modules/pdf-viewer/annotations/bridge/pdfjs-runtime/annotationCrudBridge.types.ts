import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationCommentSummary,
    TAnnotationStableKey,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import type { IAnnotationContextMenuPayload } from '@app/modules/pdf-viewer/engine/annotationContextMenuPayload';
import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IPageRange } from '@app/types/pdfUi';
import type { ITextMarkupPresentationController } from '@app/modules/pdf-viewer/runtime/annotations/useTextMarkupPresentationController';

export interface ICrudIdentity {
    resolveCommentFromCache: (comment: IAnnotationCommentSummary) => IAnnotationCommentSummary | null;
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
    hydrateSummaryFromMemory: (summary: IAnnotationCommentSummary) => IAnnotationCommentSummary;
    computeSummaryStableKey: (params: {
        id: string;
        pageIndex: number;
        source: IAnnotationCommentSummary['source'];
        uid?: string | null;
        annotationId?: string | null;
    }) => TAnnotationStableKey;
    rememberSummaryText: (summary: IAnnotationCommentSummary) => void;
    forgetSummaryText: (summary: IAnnotationCommentSummary) => void;
    commentMergePriority: (comment: IAnnotationCommentSummary) => number;
}

export interface ICrudSync {
    trackedCreatedEditors: WeakSet<object>;
    syncAnnotationComments: () => Promise<void>;
    scheduleAnnotationCommentsSync: (immediate?: boolean) => void;
    toEditorSummary: (editor: IPdfjsEditor, pageIndex: number, text?: string, sortIndex?: number | null) => IAnnotationCommentSummary;
    setActiveCommentStableKey: (key: string | null) => void;
    clearSyncState: () => void;
}

export interface ICrudFreeTextResize {ensureFreeTextEditorCanResize: (editor: IPdfjsEditor) => void;}

export interface ICrudToolManager {updateModeWithRetry: (
    uiManager: AnnotationEditorUIManager,
    mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
    pageNumber?: number,
) => Promise<unknown>;}

export interface ICrudInlineIndicators {
    debouncedSyncInlineCommentIndicators: () => void;
    syncInlineCommentIndicators: () => void;
    pulseCommentIndicator: (stableKey: string) => void;
    resolveCommentFromIndicatorElement: (element: HTMLElement) => IAnnotationCommentSummary | null;
    findCommentFromInlineTarget: (target: HTMLElement) => IAnnotationCommentSummary | null;
}

export interface ICrudHighlight {
    isPlacingComment: Ref<boolean>;
    placeCommentAtClientPoint: (
        clientX: number,
        clientY: number,
        targetElement?: HTMLElement | null,
        diagnosticsContext?: {
            attemptId?: string;
            source?: string;
            clickCapturedAtMs?: number;
            clickMeta?: Record<string, unknown>;
        },
    ) => Promise<boolean>;
    findPageContainerFromClientPoint: (clientX: number, clientY: number) => HTMLElement | null;
    buildAnnotationContextMenuPayload: (
        summary: IAnnotationCommentSummary | null,
        clientX: number,
        clientY: number,
    ) => IAnnotationContextMenuPayload;
}

export interface IUseAnnotationCrudOptions {
    viewerContainer: Ref<HTMLElement | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    numPages: Ref<number>;
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    annotationCommentsCache: Ref<IAnnotationCommentSummary[]>;
    getIdentity: () => ICrudIdentity;
    getSync: () => ICrudSync;
    getFreeTextResize: () => ICrudFreeTextResize;
    getToolManager: () => ICrudToolManager;
    getInlineIndicators: () => ICrudInlineIndicators;
    getHighlight: () => ICrudHighlight;
    textMarkupPresentation: ITextMarkupPresentationController;
    scrollToPage: (
        pageNumber: number,
        options?: {
            markerRect?: IAnnotationCommentSummary['markerRect'];
            preferExactDom?: boolean;
        },
    ) => void;
    renderVisiblePages: (
        range: IPageRange,
        options?: Pick<
            IRenderVisiblePagesOptions,
            'preserveRenderedPages' | 'forceRerender' | 'bufferOverride'
        >,
    ) => Promise<void>;
    updateVisibleRange: (container: HTMLElement | null, numPages: number) => void;
    emitAnnotationModified: () => void;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationCommentClick: (comment: IAnnotationCommentSummary) => void;
    emitAnnotationContextMenu: (payload: IAnnotationContextMenuPayload) => void;
    emitAnnotationToolCancel: () => void;
}
