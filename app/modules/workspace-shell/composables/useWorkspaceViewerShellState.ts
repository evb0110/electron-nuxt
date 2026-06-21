import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import { useDropdownManager } from '@app/modules/workspace-shell/composables/useDropdownManager';
import type {
    IDocumentViewerExpose,
    IPdfViewerExpose,
    TPdfSidebarTab,
} from '@app/modules/pdf-viewer/public';

export const useWorkspaceViewerShellState = (initialState?: ITabViewSessionState | null) => {
    const pdfViewerRef = ref<IPdfViewerExpose | null>(null);
    const djvuViewerRef = ref<IDocumentViewerExpose | null>(null);
    const documentViewerRef = computed<IDocumentViewerExpose | null>(() => (
        pdfViewerRef.value ?? djvuViewerRef.value
    ));
    const zoomDropdownOpen = ref(false);
    const pageDropdownOpen = ref(false);
    const ocrPopupOpen = ref(false);
    const overflowMenuOpen = ref(false);
    const appMenuOpen = ref(false);

    const selectedThumbnailPages = ref<number[]>([]);
    const thumbnailInvalidationRequest = ref<{
        id: number;
        pages: number[];
    } | null>(null);
    let thumbnailInvalidationRequestId = 0;

    function setSelectedThumbnailPages(pages: number[]) {
        selectedThumbnailPages.value = [...pages];
    }

    function requestThumbnailInvalidation(pages: number[]) {
        thumbnailInvalidationRequestId += 1;
        thumbnailInvalidationRequest.value = {
            id: thumbnailInvalidationRequestId,
            pages: [...pages],
        };
    }

    function handleSelectedThumbnailPagesUpdate(pages: number[]) {
        setSelectedThumbnailPages(pages);
    }

    const {
        closeAllDropdowns,
        closeOtherDropdowns,
        handleDropdownOpenChange,
        openDropdown,
    } = useDropdownManager({
        zoomOpen: zoomDropdownOpen,
        pageOpen: pageDropdownOpen,
        ocrOpen: ocrPopupOpen,
        overflowOpen: overflowMenuOpen,
        appMenuOpen,
    });

    const zoom = ref(initialState?.zoom ?? 1);
    const effectiveZoom = ref(initialState?.effectiveZoom ?? 1);
    const zoomMode = ref<TZoomMode>(initialState?.zoomMode ?? 'fit-width');
    const fitMode = ref<TFitMode>(initialState?.fitMode ?? 'width');
    const viewMode = ref<TPdfViewMode>(initialState?.viewMode ?? 'single');
    const currentPage = ref(1);
    const totalPages = ref(0);
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);

    const isLoading = ref(false);
    // Default to text selection so reopened annotations remain immediately
    // discoverable and interactable without an extra mode switch.
    const dragMode = ref(false);
    const continuousScroll = ref(initialState?.continuousScroll ?? true);
    const showSidebar = ref(initialState?.showSidebar ?? false);
    const showSettings = ref(false);
    const sidebarTab = ref<TPdfSidebarTab>('thumbnails');

    return {
        pdfViewerRef,
        djvuViewerRef,
        documentViewerRef,
        zoomDropdownOpen,
        pageDropdownOpen,
        ocrPopupOpen,
        overflowMenuOpen,
        appMenuOpen,
        closeAllDropdowns,
        closeOtherDropdowns,
        handleDropdownOpenChange,
        openDropdown,
        selectedThumbnailPages,
        thumbnailInvalidationRequest,
        setSelectedThumbnailPages,
        requestThumbnailInvalidation,
        handleSelectedThumbnailPagesUpdate,
        zoom,
        effectiveZoom,
        zoomMode,
        fitMode,
        viewMode,
        currentPage,
        totalPages,
        pdfDocument,
        isLoading,
        dragMode,
        continuousScroll,
        showSidebar,
        showSettings,
        sidebarTab,
    };
};
