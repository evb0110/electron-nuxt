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
    const pdfRasterDisplayProfile = ref<TPdfRasterDisplayProfile | null>(null);
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
        currentPage: ref(1),
        djvuSourcePath: ref('/tmp/source.djvu'),
        dragMode: ref(false),
        fitMode: ref('width'),
        isAnySaving: ref(false),
        isRenderActive,
        isResizingSidebar: ref(false),
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
        onTotalPagesUpdate: vi.fn(),
        onZoomModeUpdate: vi.fn(),
        onZoomUpdate: vi.fn(),
    });

    return {
        binding,
        isRenderActive,
        pdfRasterDisplayProfile,
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
});
