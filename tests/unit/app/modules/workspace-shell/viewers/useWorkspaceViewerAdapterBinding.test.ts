import {
    computed,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { getWorkspaceViewerAdapter } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import { useWorkspaceViewerAdapterBinding } from '@app/modules/workspace-shell/viewers/useWorkspaceViewerAdapterBinding';
import type { TPdfRasterDisplayProfile } from '@app/types/pdfRasterDisplayProfile';

function createBindingHarness() {
    const activeViewerAdapter = ref(getWorkspaceViewerAdapter('pdf'));
    const isRenderActive = ref(false);
    const isWorkspaceLayoutResizing = ref(false);
    const pdfRasterDisplayProfile = ref<TPdfRasterDisplayProfile | null>(null);
    const onSourceCapabilitiesUpdate = vi.fn();
    const onPageSourceUpdate = vi.fn();
    const binding = useWorkspaceViewerAdapterBinding({
        activeViewerAdapter: computed(() => activeViewerAdapter.value),
        annotationCursorMode: ref(null),
        annotationKeepActive: ref(false),
        annotationSettings: ref(null),
        annotationTool: ref(null),
        authorName: ref('Reader'),
        continuousScroll: ref(true),
        currentResultNavigationId: ref(0),
        currentSearchMatch: ref(null),
        documentSourceCurrentResultIndex: ref(1),
        documentSourceSearchResults: ref([{
            pageIndex: 0,
            matchIndex: 0,
            startOffset: 0,
            endOffset: 4,
        }]),
        currentPage: ref(1),
        djvuSourcePath: ref('/tmp/source.djvu'),
        dragMode: ref(false),
        fitMode: ref('width'),
        isAnySaving: ref(false),
        isRenderActive,
        isWorkspaceLayoutResizing,
        nativePdfSourcePath: ref(null),
        pageMatches: ref(new Map()),
        pdfRasterDisplayProfile,
        pdfReloadSrc: ref(null),
        pdfSrc: ref({
            kind: 'path' as const,
            path: '/tmp/source.pdf',
            size: 1,
        }),
        pdfViewerRef: ref(null),
        nativePdfViewerRef: ref(null),
        djvuViewerRef: ref(null),
        sourcePdfData: ref(null),
        viewMode: ref('single'),
        workingCopyPath: ref(null),
        originalPath: ref('/tmp/source.pdf'),
        documentRevisionToken: ref(null),
        zoom: ref(1),
        zoomMode: ref('fit-width'),
        onAnnotationCommentClick: vi.fn(),
        onAnnotationComments: vi.fn(),
        onAnnotationContextMenu: vi.fn(),
        onAnnotationModified: vi.fn(),
        onAnnotationNotePlacementChange: vi.fn(),
        onAnnotationOpenNote: vi.fn(),
        onAnnotationSetting: vi.fn(),
        onAnnotationState: vi.fn(),
        onAnnotationToolAutoReset: vi.fn(),
        onAnnotationToolCancel: vi.fn(),
        onCurrentPageUpdate: vi.fn(),
        onDocumentUpdate: vi.fn(),
        onEffectiveZoomUpdate: vi.fn(),
        onFitModeUpdate: vi.fn(),
        onImagePlacementFinalize: vi.fn(),
        onInitialVisualPending: vi.fn(),
        onInitialVisualReady: vi.fn(),
        onLoadError: vi.fn(),
        onLoading: vi.fn(),
        onNavigationFeedbackPageUpdate: vi.fn(),
        onShapeContextMenu: vi.fn(),
        onSourceCapabilitiesUpdate,
        onPageSourceUpdate,
        onTotalPagesUpdate: vi.fn(),
        onZoomModeUpdate: vi.fn(),
        onZoomUpdate: vi.fn(),
    });

    return {
        activeViewerAdapter,
        binding,
        isRenderActive,
        isWorkspaceLayoutResizing,
        pdfRasterDisplayProfile,
        onSourceCapabilitiesUpdate,
        onPageSourceUpdate,
    };
}

describe('useWorkspaceViewerAdapterBinding', () => {
    it('keeps PDF viewer active state reactive across tab activation changes', () => {
        const {
            binding,
            isRenderActive,
        } = createBindingHarness();

        expect(binding.activeViewerProps.value.isActive).toBe(false);

        isRenderActive.value = true;

        expect(binding.activeViewerProps.value.isActive).toBe(true);
    });

    it('passes raster display profiles only to the standard PDF viewer', () => {
        const {
            binding,
            pdfRasterDisplayProfile,
        } = createBindingHarness();
        const profile = {
            kind: 'trusted-raster-djvu' as const,
            sourcePagePixels: [{
                width: 1293,
                height: 1966,
            }],
        };

        pdfRasterDisplayProfile.value = profile;

        expect(binding.activeViewerProps.value.rasterDisplayProfile).toStrictEqual(profile);
    });

    it('passes workspace layout resize state to the PDF and DjVu viewers', () => {
        const {
            activeViewerAdapter,
            binding,
            isWorkspaceLayoutResizing,
        } = createBindingHarness();

        expect(binding.activeViewerProps.value.isResizing).toBe(false);

        isWorkspaceLayoutResizing.value = true;

        expect(binding.activeViewerProps.value.isResizing).toBe(true);

        activeViewerAdapter.value = getWorkspaceViewerAdapter('native-pdf');

        expect(binding.activeViewerProps.value).not.toHaveProperty('isResizing');

        activeViewerAdapter.value = getWorkspaceViewerAdapter('djvu');

        expect(binding.activeViewerProps.value.isResizing).toBe(true);
    });

    it('passes workspace-owned source search presentation only to the DjVu page source', () => {
        const {
            activeViewerAdapter,
            binding,
        } = createBindingHarness();

        expect(binding.activeViewerProps.value).not.toHaveProperty('searchResults');

        activeViewerAdapter.value = getWorkspaceViewerAdapter('djvu');

        expect(binding.activeViewerProps.value.searchResults).toEqual([expect.objectContaining({
            pageIndex: 0,
            matchIndex: 0,
        })]);
        expect(binding.activeViewerProps.value.currentSearchResultIndex).toBe(1);
    });

    it('publishes the active page source to the workspace-owned sidebar', () => {
        const {
            binding,
            onPageSourceUpdate,
        } = createBindingHarness();
        const pageSource = {pageCount: 3};
        const listener = binding.activeViewerListeners.value['update:pageSource'];

        expect(listener).toBe(onPageSourceUpdate);
        (listener as (value: typeof pageSource) => void)(pageSource);

        expect(onPageSourceUpdate).toHaveBeenCalledWith(pageSource);
    });

    it('forwards source capability updates from the active source viewer', () => {
        const {
            binding,
            onSourceCapabilitiesUpdate,
        } = createBindingHarness();
        const capabilities = {
            annotations: false,
            directImageExport: true,
            outline: true,
            pageEdits: false,
            search: true,
            text: true,
        };

        const listener = binding.activeViewerListeners.value['update:sourceCapabilities'];
        expect(listener).toBe(onSourceCapabilitiesUpdate);
        (listener as (value: typeof capabilities) => void)(capabilities);

        expect(onSourceCapabilitiesUpdate).toHaveBeenCalledWith(capabilities);
    });
});
