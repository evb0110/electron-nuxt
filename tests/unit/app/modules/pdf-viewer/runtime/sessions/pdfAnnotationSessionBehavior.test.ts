// @vitest-environment happy-dom

import {
    computed,
    createApp,
    defineComponent,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TPdfSource } from '@app/types/pdfUi';

const annotationFixture = vi.hoisted(() => ({
    clearHistory: vi.fn(),
    handleSourceChanged: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/runtime/annotations/usePdfAppAnnotationHistory', () => ({usePdfAppAnnotationHistory: vi.fn(() => ({
    clear: annotationFixture.clearHistory,
    redo: vi.fn(),
    undo: vi.fn(),
}))}));
vi.mock('@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntime', () => ({usePdfViewerAnnotationRuntime: vi.fn(() => ({
    activeCommentStableKey: ref(null),
    annotationCommentsCache: ref([]),
    annotations: {
        commentSync: {
            incrementSyncToken: vi.fn(),
            scheduleAnnotationCommentsSync: vi.fn(),
        },
        editor: {
            applyAnnotationSettings: vi.fn(),
            destroyAnnotationEditor: vi.fn(),
            initAnnotationEditor: vi.fn(),
        },
        highlight: {clearSelectionCache: vi.fn()},
        inlineIndicators: {
            attachInlineCommentMarkerObserver: vi.fn(),
            cleanup: vi.fn(),
        },
    },
    attachRenderingPort: vi.fn(),
    clearAnnotationProjection: vi.fn(),
    handleSourceChanged: annotationFixture.handleSourceChanged,
    managedEmbeddedAnnotationIds: ref(new Set<string>()),
    managedEmbeddedPdfShapes: {
        settleViewerLoadSettledWithManagedShapes: vi.fn(),
        syncAfterPageRendered: vi.fn(),
    },
    renderHiddenEmbeddedAnnotationIds: ref(new Set<string>()),
}))}));
vi.mock('@app/modules/pdf-viewer/runtime/annotations/useEditedTextMarkupVisualSync', () => ({useEditedTextMarkupVisualSync: vi.fn(() => ({
    applyEditedTextMarkupColorsForRenderedPage: vi.fn(),
    canvasHiddenAnnotationIds: ref(new Set<string>()),
}))}));
vi.mock('@app/modules/pdf-viewer/runtime/annotations/usePdfViewerAnnotationRuntimeBridge', () => ({usePdfViewerAnnotationRuntimeBridge: vi.fn(() => ({scheduleSetAnnotationTool: vi.fn()}))}));

const {createPdfAnnotationSession} = await import(
    '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession'
);

function source(content: string): TPdfSource {
    return new Blob([content], {type: 'application/pdf'});
}

function createAnnotationFixture() {
    const src = ref<TPdfSource | null>(source('first'));
    const workingCopyPath = ref<string | null>('working-copy-a');
    const isAnySaving = ref(false);
    const clearPendingImagePlacement = vi.fn();
    const documentSession = {
        pdfDocument: shallowRef(null),
        numPages: ref(0),
        subscribe: vi.fn(() => () => undefined),
        registerDisposable: vi.fn(),
    };
    const viewport = {
        currentPage: ref(1),
        visibleRange: ref({
            start: 1,
            end: 1,
        }),
        scale: {effectiveScale: ref(1)},
        scroll: {updateVisibleRange: vi.fn()},
        singlePageScroll: {scrollToPage: vi.fn()},
    };
    const rendering = {
        attachAnnotationProjection: vi.fn(() => () => undefined),
        hideManagedAnnotationEditors: vi.fn(),
        invalidatePages: vi.fn(),
        isPageRendered: vi.fn(),
        renderAnnotationEditorLayerForPage: vi.fn(),
        renderVisiblePages: vi.fn(),
        renderedPageStateVersion: ref(0),
    };
    const root = document.createElement('div');
    const app = createApp(defineComponent({
        name: 'PdfAnnotationSessionBehaviorFixture',
        setup() {
            createPdfAnnotationSession({
                document: documentSession as never,
                viewport: viewport as never,
                rendering: rendering as never,
                viewerContainer: ref(null),
                originalPath: computed(() => null),
                src: computed(() => src.value),
                sourcePdfData: computed(() => null),
                workingCopyPath: computed(() => workingCopyPath.value),
                documentRevisionToken: computed(() => null),
                isAnySaving: computed(() => isAnySaving.value),
                isActive: computed(() => true),
                bufferPages: computed(() => 0),
                annotationTool: computed(() => 'none' as never),
                annotationCursorMode: computed(() => false),
                annotationKeepActive: computed(() => false),
                annotationSettings: computed(() => null),
                authorName: computed(() => null),
                stopDrag: vi.fn(),
                clearPendingImagePlacement,
                emitAnnotationModified: vi.fn(),
                emitAnnotationState: vi.fn(),
                emitAnnotationComments: vi.fn(),
                emitAnnotationOpenNote: vi.fn(),
                emitAnnotationContextMenu: vi.fn(),
                emitAnnotationToolAutoReset: vi.fn(),
                emitAnnotationSetting: vi.fn(),
                emitAnnotationCommentClick: vi.fn(),
                emitAnnotationToolCancel: vi.fn(),
                emitAnnotationNotePlacementChange: vi.fn(),
                emitShapeContextMenu: vi.fn(),
            });
            return () => null;
        },
    }));
    app.mount(root);
    return {
        app,
        clearPendingImagePlacement,
        isAnySaving,
        src,
        workingCopyPath,
    };
}

describe('PdfAnnotationSession source-change history', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('clears commands only for a non-saving logical-document replacement', async () => {
        const fixture = createAnnotationFixture();
        try {
            const sameDocumentSource = source('byte-operation');
            fixture.src.value = sameDocumentSource;
            await nextTick();

            expect(annotationFixture.clearHistory).not.toHaveBeenCalled();
            expect(annotationFixture.handleSourceChanged).toHaveBeenLastCalledWith(
                sameDocumentSource,
                expect.any(Blob),
            );

            const replacementSource = source('other-document');
            fixture.workingCopyPath.value = 'working-copy-b';
            fixture.src.value = replacementSource;
            await nextTick();

            expect(annotationFixture.clearHistory).toHaveBeenCalledOnce();
            expect(annotationFixture.handleSourceChanged).toHaveBeenLastCalledWith(
                replacementSource,
                sameDocumentSource,
            );

            fixture.isAnySaving.value = true;
            fixture.workingCopyPath.value = 'working-copy-c';
            fixture.src.value = source('saved-document');
            await nextTick();

            expect(annotationFixture.clearHistory).toHaveBeenCalledTimes(1);
            expect(fixture.clearPendingImagePlacement).toHaveBeenCalledTimes(3);
        } finally {
            fixture.app.unmount();
        }
    });
});
