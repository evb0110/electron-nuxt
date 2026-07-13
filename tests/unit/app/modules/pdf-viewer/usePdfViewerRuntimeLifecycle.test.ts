import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createRenderer,
    defineComponent,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerRuntimeLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerRuntimeLifecycle';
import type { TPdfSource } from '@app/types/pdfUi';
import {createTestPdfViewportWritePort} from '@tests/helpers/createTestPdfViewportWritePort';

const lifecycleMocks = vi.hoisted(() => ({
    applySearchHighlights: vi.fn(),
    cleanupRenderedPages: vi.fn(),
    cleanupResizeLifecycle: vi.fn(),
    cleanupZoomRerenderQueue: vi.fn(),
    renderVisiblePages: vi.fn(),
    resetRenderStallRecoveryState: vi.fn(),
    resetZoomRerenderQueueState: vi.fn(),
    invalidateDocumentLoad: vi.fn(),
    scheduleLoadFromSource: vi.fn(),
    updateVisibleRange: vi.fn(),
}));

const testRenderer = createRenderer<object, object>({
    patchProp: vi.fn(),
    insert: vi.fn(),
    remove: vi.fn(),
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText: vi.fn(),
    setElementText: vi.fn(),
    parentNode: () => null,
    nextSibling: () => null,
});

vi.mock('@vueuse/core', () => ({
    tryOnScopeDispose: vi.fn(() => true),
    useEventListener: vi.fn(),
    useMutationObserver: vi.fn(() => ({stop: vi.fn()})),
}));

vi.mock('@app/utils/asyncGuard', () => ({runGuardedTask: (run: () => unknown) => run()}));

vi.mock('@app/services/pdfjs/runtimeLib', () => ({PixelsPerInch: {PDF_TO_CSS_UNITS: 96 / 72}}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerCurrentPageSync', () => ({usePdfViewerCurrentPageSync: () => ({
    summarizeViewerMetricsForLog: vi.fn(() => ({})),
    summarizeVisiblePageSnapshotForLog: vi.fn(() => ({})),
    syncCurrentPageFromViewport: vi.fn(),
})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerRenderStallRecovery', () => ({usePdfViewerRenderStallRecovery: () => ({
    resetRenderStallRecoveryState: lifecycleMocks.resetRenderStallRecoveryState,
    invalidatePages: vi.fn(),
    consumePendingInvalidation: vi.fn(),
    handlePageRenderStall: vi.fn(),
})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerResizeLifecycle', () => ({usePdfViewerResizeLifecycle: () => ({
    buildResizeAnchorContext: vi.fn(() => null),
    beginResizeTransition: vi.fn(() => 1),
    scheduleEndResizeTransition: vi.fn(),
    cleanupResizeLifecycle: lifecycleMocks.cleanupResizeLifecycle,
})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerDocumentLifecycle', () => ({usePdfViewerDocumentLifecycle: () => ({
    isLoadFromSourceActive: ref(false),
    invalidateDocumentLoad: lifecycleMocks.invalidateDocumentLoad,
    preserveNextSourceReloadVisibleContent: vi.fn(),
    scheduleRecoverInitialRender: vi.fn(),
    scheduleLoadFromSource: lifecycleMocks.scheduleLoadFromSource,
})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerZoomRerenderQueue', () => ({usePdfViewerZoomRerenderQueue: () => ({
    resetZoomRerenderQueueState: lifecycleMocks.resetZoomRerenderQueueState,
    scheduleResizeAwareRerender: vi.fn(),
    enqueueZoomSync: vi.fn(),
    cleanupZoomRerenderQueue: lifecycleMocks.cleanupZoomRerenderQueue,
})}));

vi.mock('@app/modules/pdf-viewer/runtime/composables/usePdfViewerRerenderCoordinator', () => ({usePdfViewerRerenderCoordinator: () => ({reRenderVisiblePagesAndSyncCurrentPage: vi.fn()})}));

async function flushActivationRendering() {
    await nextTick();
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
}

function createViewerContainerStub(queryResult: Element | null) {
    const container: HTMLElement = Object.create(null);
    container.querySelector = vi.fn(() => queryResult);
    container.getBoundingClientRect = vi.fn(() => ({
        bottom: 600,
        height: 600,
        left: 0,
        right: 800,
        top: 0,
        width: 800,
        x: 0,
        y: 0,
        toJSON: vi.fn(),
    }));
    return container;
}

function mountCore(options?: {
    isActive?: boolean;
    src?: TPdfSource | null;
    hasDocument?: boolean;
    pdfDocument?: unknown;
    isAnySaving?: boolean;
    currentPage?: number;
    numPages?: number;
    visibleRange?: {
        start: number;
        end: number;
    };
    viewerContainer?: HTMLElement | null;
    isPageRendered?: (page: number) => boolean;
    renderVisiblePages?: typeof lifecycleMocks.renderVisiblePages;
}) {
    const host = {};

    const isActive = ref(options?.isActive ?? true);
    const src = ref<TPdfSource | null>(options?.src ?? {
        kind: 'path',
        path: 'fixture.pdf',
        size: 100,
    });
    const pdfDocument = shallowRef<unknown | null>(options?.hasDocument ? {} : null);
    if (options?.pdfDocument) {
        pdfDocument.value = options.pdfDocument;
    }
    const isAnySaving = ref(options?.isAnySaving ?? false);
    const visibleRange = ref(options?.visibleRange ?? {
        start: 2,
        end: 3,
    });
    const currentPage = ref(options?.currentPage ?? 1);
    const numPages = ref(options?.numPages ?? 5);
    const viewerContainer = ref<HTMLElement | null>(options?.viewerContainer ?? null);
    const renderVisiblePages = options?.renderVisiblePages ?? lifecycleMocks.renderVisiblePages;
    const isPageRendered = vi.fn(options?.isPageRendered ?? (() => false));
    const scrollToPage = vi.fn();
    const annotationCommentsCache = ref([]);
    const activeCommentStableKey = ref<string | null>(null);
    const highlight = {
        cacheCurrentTextSelection: vi.fn(),
        handleDocumentPointerUp: vi.fn(),
        clearSelectionCache: vi.fn(),
        cancelCommentPlacement: vi.fn(),
    };
    const editor = {
        setAnnotationTool: vi.fn(),
        applyAnnotationSettings: vi.fn(),
        destroyAnnotationEditor: vi.fn(),
    };
    const cleanupDocument = vi.fn();

    const app = testRenderer.createApp(defineComponent({setup() {
        usePdfViewerRuntimeLifecycle({
            viewportWritePort: createTestPdfViewportWritePort().port,
            submitResizeIntent: vi.fn(),
            viewerContainer,
            src: computed(() => src.value),
            isAnySaving: computed(() => isAnySaving.value),
            zoom: computed(() => 1),
            zoomMode: computed(() => 'fit-width'),
            fitMode: computed(() => 'width'),
            viewMode: computed(() => 'single'),
            isActive: computed(() => isActive.value),
            isResizing: computed(() => false),
            continuousScroll: computed(() => true),
            annotationTool: computed(() => 'none'),
            annotationCursorMode: computed(() => false),
            annotationSettings: computed(() => null),
            annotationUiManager: shallowRef(null),
            annotationCommentsCache,
            activeCommentStableKey,
            pdfDocumentResult: {
                pdfDocument,
                numPages,
                isLoading: ref(false),
                getRenderVersion: vi.fn(() => 1),
                loadPdf: vi.fn(),
                ensurePageMetricsInRange: vi.fn(),
                getPage: vi.fn(),
                cleanup: cleanupDocument,
            } as never,
            annotations: {
                editor,
                commentSync: {},
                inlineIndicators: {
                    attachInlineCommentMarkerObserver: vi.fn(),
                    cleanup: vi.fn(),
                },
                highlight,
            } as never,
            currentPage,
            visibleRange,
            effectiveScale: ref(1),
            basePageWidth: ref(100),
            basePageHeight: ref(100),
            computeFitWidthScale: vi.fn(),
            invalidateScaleCache: vi.fn(),
            resetScale: vi.fn(),
            computeSkeletonInsets: vi.fn(),
            resetInsets: vi.fn(),
            setupPagePlaceholders: vi.fn(),
            renderVisiblePages,
            reRenderAllVisiblePages: vi.fn(),
            cleanupRenderedPages: lifecycleMocks.cleanupRenderedPages,
            invalidateRenderedPages: vi.fn(),
            applySearchHighlights: lifecycleMocks.applySearchHighlights,
            isPageRendered,
            getMostVisiblePage: vi.fn(() => 1),
            updateCurrentPage: vi.fn(() => 1),
            updateVisibleRange: lifecycleMocks.updateVisibleRange,
            scrollToPage,
            resetContinuousScrollState: vi.fn(),
            startDrag: vi.fn(),
            onDrag: vi.fn(),
            stopDrag: vi.fn(),
            pinCurrentPageDuringRecovery: vi.fn(),
            beginVisualReloadTransition: vi.fn(() => 1),
            endVisualReloadTransition: vi.fn(),
            emit: vi.fn(),
        });
        return () => null;
    }}));

    app.mount(host);

    return {
        activeCommentStableKey,
        annotationCommentsCache,
        app,
        currentPage,
        editor,
        cleanupDocument,
        highlight,
        host,
        isAnySaving,
        isActive,
        isPageRendered,
        pdfDocument,
        renderVisiblePages,
        scrollToPage,
        src,
        viewerContainer,
        visibleRange,
    };
}

describe('usePdfViewerRuntimeLifecycle inactive lifecycle', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('defers initial source loading while inactive and loads on activation', async () => {
        const harness = mountCore({
            isActive: false,
            src: {
                kind: 'path',
                path: 'inactive.pdf',
                size: 100,
            },
            hasDocument: false,
        });

        expect(lifecycleMocks.scheduleLoadFromSource).not.toHaveBeenCalled();

        harness.isActive.value = true;
        await flushActivationRendering();

        expect(lifecycleMocks.scheduleLoadFromSource).toHaveBeenCalledTimes(1);

        harness.app.unmount();
    });

    it('does not load source changes while inactive', async () => {
        const harness = mountCore({
            isActive: false,
            src: {
                kind: 'path',
                path: 'first.pdf',
                size: 100,
            },
            hasDocument: false,
        });

        harness.src.value = {
            kind: 'path',
            path: 'second.pdf',
            size: 100,
        };
        await nextTick();

        expect(lifecycleMocks.scheduleLoadFromSource).not.toHaveBeenCalled();
        expect(lifecycleMocks.invalidateDocumentLoad).toHaveBeenCalledTimes(1);

        harness.app.unmount();
    });

    it('cleans transient PDF work on deactivation', async () => {
        const harness = mountCore({
            isActive: true,
            hasDocument: true,
        });
        vi.clearAllMocks();

        harness.isActive.value = false;
        await nextTick();

        expect(lifecycleMocks.cleanupRenderedPages).toHaveBeenCalledTimes(1);
        expect(lifecycleMocks.invalidateDocumentLoad).toHaveBeenCalledTimes(1);
        expect(lifecycleMocks.resetZoomRerenderQueueState).toHaveBeenCalledWith('inactive-tab');
        expect(lifecycleMocks.cleanupResizeLifecycle).toHaveBeenCalledTimes(1);
        expect(harness.highlight.clearSelectionCache).toHaveBeenCalledTimes(1);

        harness.app.unmount();
    });

    it('cleans inactive PDF document caches after rendered pages are released', async () => {
        const cleanupOrder: string[] = [];
        lifecycleMocks.cleanupRenderedPages.mockImplementationOnce(() => {
            cleanupOrder.push('rendered-pages');
        });
        const cleanupPdfCaches = vi.fn(async () => {
            cleanupOrder.push('document-caches');
        });
        const harness = mountCore({
            isActive: true,
            hasDocument: true,
            pdfDocument: { cleanup: cleanupPdfCaches },
        });
        vi.clearAllMocks();

        harness.isActive.value = false;
        await nextTick();
        await Promise.resolve();

        expect(lifecycleMocks.cleanupRenderedPages).toHaveBeenCalledTimes(1);
        expect(cleanupPdfCaches).toHaveBeenCalledTimes(1);
        expect(cleanupOrder).toEqual([
            'rendered-pages',
            'document-caches',
        ]);

        harness.app.unmount();
    });

    it('skips inactive PDF document cache cleanup while saving', async () => {
        const cleanupPdfCaches = vi.fn(async () => undefined);
        const harness = mountCore({
            isActive: true,
            hasDocument: true,
            pdfDocument: { cleanup: cleanupPdfCaches },
            isAnySaving: true,
        });
        vi.clearAllMocks();

        harness.isActive.value = false;
        await nextTick();
        await Promise.resolve();

        expect(lifecycleMocks.cleanupRenderedPages).toHaveBeenCalledTimes(1);
        expect(cleanupPdfCaches).not.toHaveBeenCalled();

        harness.app.unmount();
    });

    it('fully clears the active document when source becomes null', async () => {
        const harness = mountCore({
            isActive: true,
            hasDocument: true,
        });
        vi.clearAllMocks();

        harness.src.value = null;
        await nextTick();

        expect(lifecycleMocks.invalidateDocumentLoad).toHaveBeenCalledTimes(1);
        expect(lifecycleMocks.cleanupRenderedPages).toHaveBeenCalledTimes(1);
        expect(harness.editor.destroyAnnotationEditor).toHaveBeenCalledTimes(1);
        expect(harness.cleanupDocument).toHaveBeenCalledTimes(1);
        expect(lifecycleMocks.scheduleLoadFromSource).not.toHaveBeenCalled();

        harness.app.unmount();
    });

    it('resumes rendering an existing document on activation', async () => {
        const harness = mountCore({
            isActive: false,
            hasDocument: true,
            viewerContainer: createViewerContainerStub(null),
        });
        vi.clearAllMocks();

        harness.isActive.value = true;
        await flushActivationRendering();
        await vi.waitFor(() => {
            expect(lifecycleMocks.renderVisiblePages).toHaveBeenCalled();
        });

        expect(harness.editor.setAnnotationTool).toHaveBeenCalledWith('none');
        expect(harness.editor.applyAnnotationSettings).toHaveBeenCalledWith(null);
        expect(lifecycleMocks.updateVisibleRange).toHaveBeenCalledWith(harness.viewerContainer.value, 5);
        expect(lifecycleMocks.renderVisiblePages).toHaveBeenCalledWith({
            start: 1,
            end: 1,
        }, { preserveRenderedPages: true });
        expect(lifecycleMocks.applySearchHighlights).toHaveBeenCalledTimes(1);

        harness.app.unmount();
    });

    it('waits for a measurable viewer container before restoring an activated document', async () => {
        const renderVisiblePages = vi.fn().mockResolvedValue(undefined);
        const harness = mountCore({
            isActive: false,
            hasDocument: true,
            viewerContainer: null,
            renderVisiblePages,
        });
        vi.clearAllMocks();

        harness.isActive.value = true;
        await nextTick();
        expect(renderVisiblePages).not.toHaveBeenCalled();

        harness.viewerContainer.value = createViewerContainerStub(null);
        await vi.waitFor(() => {
            expect(renderVisiblePages).toHaveBeenCalled();
        });

        expect(renderVisiblePages).toHaveBeenCalledWith({
            start: 1,
            end: 1,
        }, { preserveRenderedPages: true });

        harness.app.unmount();
    });

    it('restores the viewport-authority page once after activation', async () => {
        const renderVisiblePages = vi.fn().mockResolvedValue(undefined);
        const viewerContainer = createViewerContainerStub(null);
        const harness = mountCore({
            isActive: false,
            hasDocument: true,
            currentPage: 2,
            visibleRange: {
                start: 2,
                end: 2,
            },
            viewerContainer,
            renderVisiblePages,
        });

        harness.isActive.value = true;
        await flushActivationRendering();

        expect(renderVisiblePages).toHaveBeenNthCalledWith(1, {
            start: 2,
            end: 2,
        }, { preserveRenderedPages: true });
        expect(renderVisiblePages).toHaveBeenCalledTimes(1);

        harness.app.unmount();
    });

    it('does not force a second activation render when the current page already has a canvas', async () => {
        const renderVisiblePages = vi.fn().mockResolvedValue(undefined);
        const mountedCanvas: Element = Object.create(null);
        const viewerContainer = createViewerContainerStub(mountedCanvas);
        const harness = mountCore({
            isActive: false,
            hasDocument: true,
            currentPage: 2,
            visibleRange: {
                start: 2,
                end: 2,
            },
            viewerContainer,
            renderVisiblePages,
        });

        harness.isActive.value = true;
        await flushActivationRendering();

        expect(renderVisiblePages).toHaveBeenCalledTimes(1);
        expect(renderVisiblePages).toHaveBeenCalledWith({
            start: 2,
            end: 2,
        }, { preserveRenderedPages: true });

        harness.app.unmount();
    });
});
