import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { TPdfSource } from '@app/types/pdfUi';
import type {
    IDocumentViewerExpose,
    IPdfViewerExpose,
} from '@app/modules/pdf-viewer/public';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';
import type { IWorkspaceViewerAdapter } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';

type TReadableRef<T> = ComputedRef<T> | Ref<T>;

interface IWorkspaceViewerAdapterBindingOptions {
    activeViewerAdapter: ComputedRef<IWorkspaceViewerAdapter | null>;
    annotationCursorMode: Ref<unknown> | ComputedRef<unknown>;
    annotationKeepActive: Ref<unknown> | ComputedRef<unknown>;
    annotationSettings: Ref<unknown> | ComputedRef<unknown>;
    annotationTool: Ref<unknown>;
    authorName: Ref<string> | ComputedRef<string>;
    continuousScroll: Ref<boolean>;
    currentResultNavigationId: Ref<number>;
    currentSearchMatch: Ref<unknown> | ComputedRef<unknown>;
    currentPage: Ref<number>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    dragMode: Ref<boolean>;
    fitMode: Ref<unknown>;
    isAnySaving: Ref<boolean>;
    isRenderActive: TReadableRef<boolean>;
    isResizingSidebar: Ref<boolean>;
    nativePdfSourcePath: Ref<TDocumentRef | null> | ComputedRef<TDocumentRef | null>;
    pageMatches: Ref<unknown> | ComputedRef<unknown>;
    pdfRasterDisplayProfile: Ref<TPdfRasterDisplayProfile | null> | ComputedRef<TPdfRasterDisplayProfile | null>;
    pdfReloadSrc: Ref<TPdfSource | null>;
    pdfSrc: Ref<TPdfSource | null>;
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    nativePdfViewerRef: Ref<IDocumentViewerExpose | null>;
    djvuViewerRef: Ref<IDocumentViewerExpose | null>;
    documentRevisionToken: Ref<TDocumentRevisionToken | null>;
    sourcePdfData: Ref<Uint8Array | null> | ComputedRef<Uint8Array | null>;
    viewMode: Ref<unknown>;
    workingCopyPath: Ref<TDocumentRef | null>;
    zoom: Ref<number>;
    zoomMode: Ref<unknown>;
    onAnnotationCommentClick: unknown;
    onAnnotationComments: unknown;
    onAnnotationContextMenu: unknown;
    onAnnotationModified: unknown;
    onAnnotationNotePlacementChange: (value: boolean) => void;
    onAnnotationOpenNote: unknown;
    onAnnotationSetting: unknown;
    onAnnotationState: unknown;
    onAnnotationToolAutoReset: () => void;
    onAnnotationToolCancel: () => void;
    onCurrentPageUpdate: (value: number) => void;
    onDocumentUpdate: (value: unknown) => void;
    onEffectiveZoomUpdate: (value: number) => void;
    onFitModeUpdate: (value: unknown) => void;
    onImagePlacementFinalize: unknown;
    onInitialVisualPending: () => void;
    onInitialVisualReady: () => void;
    onLoadError: (error: unknown) => void;
    onLoading: (value: boolean) => void;
    onNavigationFeedbackPageUpdate: (value: number | null) => void;
    onShapeContextMenu: unknown;
    onTotalPagesUpdate: (value: number) => void;
    onZoomModeUpdate: (value: unknown) => void;
    onZoomUpdate: (value: number) => void;
}

export const useWorkspaceViewerAdapterBinding = (options: IWorkspaceViewerAdapterBindingOptions) => {
    function setViewerRef<T>(target: Ref<T | null>, value: T | null) {
        if (target.value !== value) {
            target.value = value;
        }
    }

    function createNativeViewerProps(source: TDocumentRef | null) {
        return {
            src: source,
            zoom: options.zoom.value,
            zoomMode: options.zoomMode.value,
            fitMode: options.fitMode.value,
            viewMode: options.viewMode.value,
            continuousScroll: options.continuousScroll.value,
            dragMode: options.dragMode.value,
            isActive: options.isRenderActive.value,
        };
    }

    const activeViewerProps = computed<Record<string, unknown>>(() => {
        if (options.activeViewerAdapter.value?.id === 'pdf' && options.pdfSrc.value) {
            return {
                src: options.pdfSrc.value,
                reloadSrc: options.pdfReloadSrc.value,
                rasterDisplayProfile: options.pdfRasterDisplayProfile.value,
                sourcePdfData: options.sourcePdfData.value,
                isAnySaving: options.isAnySaving.value,
                zoom: options.zoom.value,
                zoomMode: options.zoomMode.value,
                fitMode: options.fitMode.value,
                viewMode: options.viewMode.value,
                currentPage: options.currentPage.value,
                dragMode: options.dragMode.value,
                continuousScroll: options.continuousScroll.value,
                isResizing: options.isResizingSidebar.value,
                isActive: options.isRenderActive.value,
                annotationTool: options.annotationTool.value,
                annotationCursorMode: options.annotationCursorMode.value,
                annotationKeepActive: options.annotationKeepActive.value,
                annotationSettings: options.annotationSettings.value,
                searchPageMatches: options.pageMatches.value,
                currentSearchMatch: options.currentSearchMatch.value,
                currentSearchMatchNavigationId: options.currentResultNavigationId.value,
                workingCopyPath: options.workingCopyPath.value,
                documentRevisionToken: options.documentRevisionToken.value,
                authorName: options.authorName.value,
            };
        }

        if (options.activeViewerAdapter.value?.id === 'native-pdf') {
            return createNativeViewerProps(options.nativePdfSourcePath.value);
        }

        if (options.activeViewerAdapter.value?.id === 'djvu') {
            return createNativeViewerProps(options.djvuSourcePath.value);
        }

        return {};
    });

    const activeViewerComponent = computed(() => options.activeViewerAdapter.value?.component ?? null);

    const nativeViewerListeners = {
        'update:effectiveZoom': options.onEffectiveZoomUpdate,
        'update:currentPage': options.onCurrentPageUpdate,
        'update:totalPages': options.onTotalPagesUpdate,
        'update:document': options.onDocumentUpdate,
        loading: options.onLoading,
        initialVisualPending: options.onInitialVisualPending,
        initialVisualReady: options.onInitialVisualReady,
    };

    const activeViewerListeners = computed<Record<string, unknown>>(() => {
        if (options.activeViewerAdapter.value?.id !== 'pdf') {
            return nativeViewerListeners;
        }

        return {
            ...nativeViewerListeners,
            'update:zoom': options.onZoomUpdate,
            'update:zoomMode': options.onZoomModeUpdate,
            'update:fitMode': options.onFitModeUpdate,
            'update:navigationFeedbackPage': options.onNavigationFeedbackPageUpdate,
            loadError: options.onLoadError,
            annotationState: options.onAnnotationState,
            annotationModified: options.onAnnotationModified,
            annotationComments: options.onAnnotationComments,
            annotationOpenNote: options.onAnnotationOpenNote,
            annotationCommentClick: options.onAnnotationCommentClick,
            annotationContextMenu: options.onAnnotationContextMenu,
            annotationToolAutoReset: options.onAnnotationToolAutoReset,
            annotationToolCancel: options.onAnnotationToolCancel,
            annotationSetting: options.onAnnotationSetting,
            annotationNotePlacementChange: options.onAnnotationNotePlacementChange,
            shapeContextMenu: options.onShapeContextMenu,
            imagePlacementFinalize: options.onImagePlacementFinalize,
        };
    });

    function bindActiveViewerRef(instance: unknown) {
        const adapterId = options.activeViewerAdapter.value?.id ?? null;
        setViewerRef(
            options.pdfViewerRef,
            adapterId === 'pdf' && instance
                ? instance as IPdfViewerExpose
                : null,
        );
        setViewerRef(
            options.nativePdfViewerRef,
            adapterId === 'native-pdf' && instance
                ? instance as IDocumentViewerExpose
                : null,
        );
        setViewerRef(
            options.djvuViewerRef,
            adapterId === 'djvu' && instance
                ? instance as IDocumentViewerExpose
                : null,
        );
    }

    return {
        activeViewerComponent,
        activeViewerProps,
        activeViewerListeners,
        bindActiveViewerRef,
    };
};
