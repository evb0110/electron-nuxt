import type { Ref } from 'vue';

interface IViewerCapabilities {
    conversionBanner?: boolean;
    conversionDialog?: boolean;
}

interface IConversionState {isConverting: boolean;}

interface IUseDocumentWorkspaceViewerPresentationOptions {
    activeViewerAdapter: Readonly<Ref<unknown | null>>;
    activeViewerCapabilities: Readonly<Ref<IViewerCapabilities | null>>;
    canUseDjvu: boolean;
    conversionState: Readonly<Ref<IConversionState>>;
    djvuError: Readonly<Ref<unknown>>;
    djvuOpeningPath: Readonly<Ref<unknown>>;
    djvuSourcePath: Readonly<Ref<unknown>>;
    documentViewerRef: Readonly<Ref<unknown | null>>;
    initialDocumentVisualReady: Readonly<Ref<boolean>>;
    isDjvuMode: Readonly<Ref<boolean>>;
    isDocumentOpenPlaceholderVisible: Readonly<Ref<boolean>>;
    nativePdfSourcePath: Readonly<Ref<unknown>>;
    pdfError: Readonly<Ref<unknown>>;
    pdfSrc: Readonly<Ref<unknown>>;
    pendingDjvuDocumentOpen: Readonly<Ref<boolean>>;
    showDocumentTransitionSkeleton: Readonly<Ref<boolean>>;
    showDjvuSource: Readonly<Ref<boolean>>;
    showNativePdfViewer: Readonly<Ref<boolean>>;
    showStandardPdfViewer: Readonly<Ref<boolean>>;
}

export const useDocumentWorkspaceViewerPresentation = (
    options: IUseDocumentWorkspaceViewerPresentationOptions,
) => {
    const showWorkspaceViewerDocument = computed(() => (
        options.showStandardPdfViewer.value
        || options.showNativePdfViewer.value
        || options.showDjvuSource.value
    ));
    const hasPendingViewerSource = computed(() => (
        Boolean(options.pdfSrc.value)
        || Boolean(options.nativePdfSourcePath.value)
        || Boolean(options.djvuSourcePath.value)
    ));
    const showPendingViewerMountSkeleton = computed(() => (
        Boolean(options.activeViewerAdapter.value)
        && hasPendingViewerSource.value
        && !options.documentViewerRef.value
    ));
    const showPendingDocumentOpenSkeleton = computed(() => (
        (
            options.isDocumentOpenPlaceholderVisible.value
            || showPendingViewerMountSkeleton.value
        )
        && !showWorkspaceViewerDocument.value
        && !options.pdfError.value
        && !options.djvuError.value
    ));
    const showWorkspaceTransitionSkeleton = computed(() => (
        options.showDocumentTransitionSkeleton.value
        || showPendingViewerMountSkeleton.value
        || showPendingDocumentOpenSkeleton.value
    ));
    const hasDjvuBannerOpeningContext = computed(() => (
        options.pendingDjvuDocumentOpen.value
        || Boolean(options.djvuOpeningPath.value)
        || options.isDjvuMode.value
        || options.showDjvuSource.value
    ));
    const djvuBannerOpening = computed(() => (
        hasDjvuBannerOpeningContext.value
        && !options.djvuError.value
        && (
            options.pendingDjvuDocumentOpen.value
            || Boolean(options.djvuOpeningPath.value)
            || showWorkspaceTransitionSkeleton.value
            || options.showDjvuSource.value && !options.initialDocumentVisualReady.value
        )
    ));
    const showDjvuConversionUi = computed(() => (
        options.canUseDjvu
        && (
            options.activeViewerCapabilities.value?.conversionBanner === true
            || options.activeViewerCapabilities.value?.conversionDialog === true
            || options.pendingDjvuDocumentOpen.value
            || Boolean(options.djvuOpeningPath.value)
            || options.conversionState.value.isConverting
        )
    ));

    return {
        djvuBannerOpening,
        showDjvuConversionUi,
        showWorkspaceTransitionSkeleton,
        showWorkspaceViewerDocument,
    };
};
