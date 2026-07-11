import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerRenderingRuntime } from '@app/modules/pdf-viewer/runtime/rendering/usePdfViewerRenderingRuntime';
import {createTestPdfViewportWritePort} from '@tests/helpers/createTestPdfViewportWritePort';

const rendererMocks = vi.hoisted(() => ({
    cleanupAllPages: vi.fn(),
    isPageRendered: vi.fn(),
    usePdfPageRenderer: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/runtime/rendering/usePdfPageRenderer', () => ({ usePdfPageRenderer: rendererMocks.usePdfPageRenderer }));

function createRuntime() {
    return usePdfViewerRenderingRuntime({
        viewportWritePort: createTestPdfViewportWritePort().port,
        viewerContainer: ref(null),
        document: {} as never,
        currentPage: ref(1),
        isActive: computed(() => true),
        effectiveScale: computed(() => 1),
        outputScale: ref(1),
        rasterDisplayProfile: computed(() => null),
        bufferPages: computed(() => 2),
        showAnnotations: computed(() => true),
        hiddenAnnotationIds: ref(new Set<string>()),
        managedAnnotationIds: ref(new Set<string>()),
        annotationUiManager: shallowRef(null),
        annotationL10n: shallowRef(null),
        replaceAnnotationUiManager: vi.fn(),
        scrollToPage: vi.fn(),
        suppressSnap: vi.fn(),
        beginSearchNavigation: vi.fn(),
        revealSearchNavigationTarget: vi.fn(),
        endSearchNavigation: vi.fn(),
        searchPageMatches: computed(() => new Map()),
        currentSearchMatch: computed(() => null),
        currentSearchMatchNavigationId: computed(() => 0),
        workingCopyPath: computed(() => null),
        documentRevisionToken: computed(() => null),
        onRenderStall: vi.fn(),
        onPageCanvasMounted: vi.fn(),
        onPageRendered: vi.fn(),
        onRenderedPageStateChanged: vi.fn(),
        renderedPageStateVersion: ref(0),
    });
}

describe('usePdfViewerRenderingRuntime', () => {
    beforeEach(() => {
        rendererMocks.cleanupAllPages.mockReset();
        rendererMocks.isPageRendered.mockReset();
        rendererMocks.usePdfPageRenderer.mockReset();
        rendererMocks.usePdfPageRenderer.mockReturnValue({
            cleanupAllPages: rendererMocks.cleanupAllPages,
            isPageRendered: rendererMocks.isPageRendered,
        });
    });

    it('does not expose the rendered class until the renderer finalizes the page', () => {
        rendererMocks.isPageRendered.mockReturnValue(false);
        const runtime = createRuntime();

        expect(runtime.isPageRenderedForClass(1)).toBe(false);

        rendererMocks.isPageRendered.mockReturnValue(true);

        expect(runtime.isPageRenderedForClass(1)).toBe(true);
        expect(rendererMocks.isPageRendered).toHaveBeenCalledWith(1);
    });
});
