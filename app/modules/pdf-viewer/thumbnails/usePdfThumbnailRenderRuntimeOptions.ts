import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import type { IWorkspaceSurfaceBudgetController } from '@app/utils/document-viewer/workspaceSurfaceBudget';

interface IPdfThumbnailRenderRuntimeSource {
    currentPage: ComputedRef<number>;
    invalidationRequest: ComputedRef<{
        id: number;
        pages: number[];
    } | null | undefined>;
    isActive: ComputedRef<boolean>;
    pdfDocument: ComputedRef<PDFDocumentProxy | null>;
    totalPages: ComputedRef<number>;
}

interface IPdfThumbnailRenderRuntimeVisuals {
    annotationSettings: ComputedRef<IAnnotationSettings | null | undefined>;
    editedTextMarkupComments: ComputedRef<IAnnotationCommentSummary[]>;
    editedTextMarkupVisualSignature: ComputedRef<string>;
    hiddenAnnotationIdSet: ComputedRef<Set<string>>;
    hiddenAnnotationIdsSignature: ComputedRef<string>;
}

interface IPdfThumbnailRenderRuntimeLayout {
    clearThumbnailAspectRatios: () => void;
    shouldPreferVisibleAnchorOverCurrentPage: () => boolean;
    resolveViewportAnchorPage: () => number | null;
    thumbnailAspectRatios: Ref<Array<number | null>>;
    thumbnailRenderWidth: Ref<number>;
    viewportPages: ComputedRef<number[]>;
    virtualPages: ComputedRef<number[]>;
    updateThumbnailAspectRatio: (page: number, aspectRatio: number | null) => void;
}

interface IPdfThumbnailRenderRuntimeDom {
    getCanvas: (page: number) => HTMLCanvasElement | null;
    resolveVisibleContainer: (reason: string) => HTMLElement | null;
}

interface IPdfThumbnailRenderRuntimeEffects {
    cancelActivePaneRefresh: () => void;
    measureThumbnailHeight: () => void | Promise<void>;
    onSourceCycleStarted: () => void;
    refreshVisibleThumbnailPane: (reason: string) => void | Promise<void>;
    resetMeasurementState: () => void;
    scheduleActivePaneRefresh: (reason: string) => void;
}

export interface IUsePdfThumbnailRenderRuntimeOptions {
    dom: IPdfThumbnailRenderRuntimeDom;
    effects: IPdfThumbnailRenderRuntimeEffects;
    layout: IPdfThumbnailRenderRuntimeLayout;
    source: IPdfThumbnailRenderRuntimeSource;
    surfaceBudget?: IWorkspaceSurfaceBudgetController;
    visuals: IPdfThumbnailRenderRuntimeVisuals;
}
