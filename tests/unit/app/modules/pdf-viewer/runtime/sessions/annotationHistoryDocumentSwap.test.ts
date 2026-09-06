// @vitest-environment happy-dom

import { requirePageIndex } from '@contracts/pageNumbers';
import { requireDocumentRef } from '@contracts/documentRef';
import { requireEpochMs } from '@contracts/timestamps';
import {
    afterEach,
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
    nextTick,
    ref,
    shallowRef,
    type ShallowRef,
} from 'vue';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import {asAnnotationId} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {IStickyNoteEntity} from '@app/modules/pdf-viewer/engine/annotations/domain/annotationEntity';
import type {TPdfDocumentSession} from '@app/modules/pdf-viewer/runtime/sessions/pdfDocumentSession';
import type {TPdfViewportSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import type {TPdfRenderingSession} from '@app/modules/pdf-viewer/runtime/sessions/createPdfRenderingSession';
import { createPdfDocumentProxy } from '@tests/helpers/createPdfDocumentProxy';

vi.mock('@app/services/pdfjs/getPdfjsViewerRuntimeProbeFailures', () => ({
    EventBus: vi.fn(),
    GenericL10n: vi.fn(),
}));

const { createPdfAnnotationSession } = await import(
    '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession'
);

const mountedSessions: Array<() => void> = [];

afterEach(() => {
    mountedSessions.splice(0).forEach(unmount => unmount());
});

function stickyNote(id: string): IStickyNoteEntity {
    return {
        kind: 'sticky-note',
        identity: {
            id: asAnnotationId(id),
            pdfjsUid: `${id}-editor`,
        },
        pageIndex: requirePageIndex(0),
        revision: 0,
        persistedRevision: -1,
        deleted: false,
        createdAt: requireEpochMs(1),
        modifiedAt: requireEpochMs(1),
        author: null,
        text: '',
        anchor: {
            left: 0.1,
            top: 0.2,
            width: 0.02,
            height: 0.02,
        },
        color: '#ffff00',
    };
}

/** Enough of a proxy for identity comparisons; the session only swaps on it. */
function createDocumentProxy(fingerprint: string) {
    return createPdfDocumentProxy({
        numPages: 1,
        fingerprints: [fingerprint],
    });
}

function createDocumentSessionFixture(pdfDocument: ShallowRef<PDFDocumentProxy | null>): TPdfDocumentSession {
    const fixture = {
        pdfDocument: computed(() => pdfDocument.value),
        numPages: ref(1),
        registerDisposable: vi.fn(),
        subscribe: vi.fn(() => vi.fn()),
    } satisfies Pick<TPdfDocumentSession, 'pdfDocument' | 'numPages' | 'registerDisposable' | 'subscribe'>;
    // The annotation session only consumes this narrow sibling-session slice.
    return Object.assign(Object.create(null), fixture);
}

function createViewportSessionFixture(): TPdfViewportSession {
    const fixture = {
        currentPage: computed(() => 1),
        visibleRange: computed(() => ({
            start: 1,
            end: 1,
        })),
        scale: {effectiveScale: computed(() => 1)},
        scroll: {updateVisibleRange: vi.fn()},
        singlePageScroll: {scrollToPage: vi.fn()},
    };
    // The annotation session does not inspect the rest of viewport state.
    return Object.assign(Object.create(null), fixture);
}

function createRenderingSessionFixture(): TPdfRenderingSession {
    const fixture = {
        attachAnnotationProjection: vi.fn(() => vi.fn()),
        hideManagedAnnotationEditors: vi.fn(),
        invalidatePages: vi.fn(),
        isPageRendered: vi.fn(() => false),
        renderAnnotationEditorLayerForPage: vi.fn(),
        renderVisiblePages: vi.fn(),
        renderedPageStateVersion: ref(0),
    } satisfies Pick<
        TPdfRenderingSession,
        | 'attachAnnotationProjection'
        | 'hideManagedAnnotationEditors'
        | 'invalidatePages'
        | 'isPageRendered'
        | 'renderAnnotationEditorLayerForPage'
        | 'renderVisiblePages'
        | 'renderedPageStateVersion'
    >;
    // The annotation session only calls the rendering methods listed above.
    return Object.assign(Object.create(null), fixture);
}

function mountAnnotationSession() {
    const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
    let session: ReturnType<typeof createPdfAnnotationSession> | undefined;
    const host = document.createElement('div');
    document.body.append(host);
    const AnnotationSessionHost = defineComponent({ setup() {
        session = createPdfAnnotationSession({
            document: createDocumentSessionFixture(pdfDocument),
            viewport: createViewportSessionFixture(),
            rendering: createRenderingSessionFixture(),
            viewerContainer: ref(null),
            originalPath: computed(() => requireDocumentRef('/documents/original.pdf')),
            src: computed(() => ({
                kind: 'path',
                path: requireDocumentRef('/managed/working.pdf'),
                size: 4,
            })),
            sourcePdfData: computed(() => null),
            workingCopyPath: computed(() => requireDocumentRef('/managed/working.pdf')),
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
        });
        return () => h('div');
    } });
    const app = createApp(AnnotationSessionHost);
    app.mount(host);
    mountedSessions.push(() => {
        app.unmount();
        host.remove();
    });
    if (!session) {
        throw new Error('The annotation session host did not expose a session.');
    }
    const activeSession = session;
    return {
        pdfDocument,
        createNote: (id: string) => {
            activeSession.annotationApplication.value.store.createStickyNote(stickyNote(id));
        },
        canUndo: () => activeSession.appAnnotationHistory.canUndo.value,
        canRedo: () => activeSession.appAnnotationHistory.canRedo.value,
        application: () => activeSession.annotationApplication.value,
        canonicalAnnotationIds: () => activeSession.annotationApplication.value.store
            .list()
            .map(entity => entity.identity.id),
    };
}

describe('annotation history across a document proxy swap', () => {
    it('clears annotation history when a structural page operation reloads the document', async () => {
        const harness = mountAnnotationSession();
        harness.pdfDocument.value = createDocumentProxy('before-page-op');
        await nextTick();

        harness.createNote('page-op-note');
        const applicationBeforeSwap = harness.application();

        expect(harness.canUndo()).toBe(true);
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);

        // A page operation rewrites the working copy in place and reloads it:
        // the proxy is cleared, then a new one is published under the same path.
        harness.pdfDocument.value = null;
        await nextTick();
        harness.pdfDocument.value = createDocumentProxy('after-page-op');
        await nextTick();

        expect(harness.canUndo()).toBe(false);
        expect(harness.canRedo()).toBe(false);
        expect(harness.canonicalAnnotationIds()).toEqual([]);
        expect(harness.application()).not.toBe(applicationBeforeSwap);
    });

    it('keeps history when the first document of the session arrives', async () => {
        const harness = mountAnnotationSession();
        harness.createNote('pre-load-note');

        expect(harness.canUndo()).toBe(true);

        harness.pdfDocument.value = createDocumentProxy('first-load');
        await nextTick();

        expect(harness.canUndo()).toBe(true);
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);
    });

    it('keeps history when a reload republishes the same document proxy', async () => {
        const harness = mountAnnotationSession();
        const loaded = createDocumentProxy('republished');
        harness.pdfDocument.value = loaded;
        await nextTick();
        harness.createNote('republished-note');

        harness.pdfDocument.value = null;
        await nextTick();
        harness.pdfDocument.value = loaded;
        await nextTick();

        expect(harness.canUndo()).toBe(true);
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);
    });
});
