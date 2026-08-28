// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createApp,
    defineComponent,
    h,
    ref,
    shallowRef,
} from 'vue';
import type { useAnnotationEditorBridge as TUseAnnotationEditorBridge } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationEditorBridge';

vi.mock('@app/services/pdfjs/getPdfjsViewerRuntimeProbeFailures', () => ({
    EventBus: vi.fn(),
    GenericL10n: vi.fn(),
}));

const editorLifecycle = vi.hoisted(() => ({
    destroy: vi.fn(),
    initialize: vi.fn(),
}));

vi.mock(
    '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationEditorBridge',
    async (importOriginal) => {
        const actual = await importOriginal<{useAnnotationEditorBridge: typeof TUseAnnotationEditorBridge}>();
        return {
            ...actual,
            useAnnotationEditorBridge: (
                ...args: Parameters<typeof actual.useAnnotationEditorBridge>
            ) => ({
                ...actual.useAnnotationEditorBridge(...args),
                initAnnotationEditor: editorLifecycle.initialize,
                destroyAnnotationEditor: editorLifecycle.destroy,
            }),
        };
    },
);

const { createPdfAnnotationSession } = await import(
    '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession'
);

const mountedSessions: Array<() => void> = [];

afterEach(() => {
    mountedSessions.splice(0).forEach(unmount => unmount());
    editorLifecycle.destroy.mockReset();
    editorLifecycle.initialize.mockReset();
});

function mountHarness(initial: {
    document?: object | null;
    container?: HTMLElement | null;
} = {}) {
    const pdfDocument = shallowRef<object | null>(initial.document ?? null);
    const viewerContainer = shallowRef<HTMLElement | null>(initial.container ?? null);
    const host = document.createElement('div');
    document.body.append(host);
    const AnnotationSessionHost = defineComponent({ setup() {
        createPdfAnnotationSession({
            document: {
                pdfDocument,
                numPages: ref(0),
                registerDisposable: vi.fn(),
                subscribe: vi.fn(() => vi.fn()),
            },
            viewport: {
                currentPage: ref(1),
                visibleRange: computed(() => ({
                    start: 1,
                    end: 1,
                })),
                scale: {effectiveScale: computed(() => 1)},
                scroll: {updateVisibleRange: vi.fn()},
                singlePageScroll: {scrollToPage: vi.fn()},
            },
            rendering: {
                attachAnnotationProjection: vi.fn(() => vi.fn()),
                hideManagedAnnotationEditors: vi.fn(),
                invalidatePages: vi.fn(),
                isPageRendered: vi.fn(() => false),
                renderAnnotationEditorLayerForPage: vi.fn(),
                renderVisiblePages: vi.fn(),
                renderedPageStateVersion: ref(0),
            },
            viewerContainer,
            originalPath: computed(() => null),
            src: computed(() => null),
            sourcePdfData: computed(() => null),
            workingCopyPath: computed(() => null),
            documentRevisionToken: computed(() => null),
            isAnySaving: computed(() => false),
            isActive: computed(() => true),
            bufferPages: computed(() => 1),
            annotationTool: computed(() => 'none'),
            annotationCursorMode: computed(() => false),
            annotationKeepActive: computed(() => false),
            annotationSettings: computed(() => null),
            authorName: computed(() => null),
            stopDrag: vi.fn(),
            clearPendingImagePlacement: vi.fn(),
            emitAnnotationModified: vi.fn(),
            emitAnnotationState: vi.fn(),
            emitAnnotationComments: vi.fn(),
            emitAnnotationEnrichmentState: vi.fn(),
            emitAnnotationInventory: vi.fn(),
            emitAnnotationOpenNote: vi.fn(),
            emitAnnotationContextMenu: vi.fn(),
            emitAnnotationToolAutoReset: vi.fn(),
            emitAnnotationSetting: vi.fn(),
            emitAnnotationCommentClick: vi.fn(),
            emitAnnotationToolCancel: vi.fn(),
            emitAnnotationNotePlacementChange: vi.fn(),
            emitShapeContextMenu: vi.fn(),
        } as never);
        return () => h('div');
    } });
    const app = createApp(AnnotationSessionHost);
    app.mount(host);
    mountedSessions.push(() => {
        app.unmount();
        host.remove();
    });
    return {
        pdfDocument,
        viewerContainer,
    };
}

describe('PDF annotation editor lifecycle', () => {
    beforeEach(() => {
        // The production initializer owns teardown before it creates the next
        // PDF.js manager. Model that contract so an extra lifecycle destroy is
        // visible as a doubled call here.
        editorLifecycle.initialize.mockImplementation(() => editorLifecycle.destroy());
    });

    it('initializes when a restored document arrives before its viewer element', () => {
        const harness = mountHarness({document: {}});

        expect(editorLifecycle.initialize).not.toHaveBeenCalled();

        harness.viewerContainer.value = document.createElement('div');

        expect(editorLifecycle.initialize).toHaveBeenCalledOnce();
        expect(editorLifecycle.destroy).toHaveBeenCalledOnce();
    });

    it('initializes immediately when both owners already exist', () => {
        mountHarness({
            document: {},
            container: document.createElement('div'),
        });

        expect(editorLifecycle.initialize).toHaveBeenCalledOnce();
        expect(editorLifecycle.destroy).toHaveBeenCalledOnce();
    });

    it('destroys and reinitializes when either owner changes', () => {
        const firstContainer = document.createElement('div');
        const harness = mountHarness({
            document: {},
            container: firstContainer,
        });

        harness.viewerContainer.value = null;
        expect(editorLifecycle.destroy).toHaveBeenCalledTimes(2);

        harness.viewerContainer.value = document.createElement('div');
        expect(editorLifecycle.initialize).toHaveBeenCalledTimes(2);
        expect(editorLifecycle.destroy).toHaveBeenCalledTimes(3);

        harness.pdfDocument.value = {};
        expect(editorLifecycle.destroy).toHaveBeenCalledTimes(4);
        expect(editorLifecycle.initialize).toHaveBeenCalledTimes(3);
    });
});
