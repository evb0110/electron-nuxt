// @vitest-environment happy-dom

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
} from 'vue';
import type { Ref } from 'vue';
import type {
    IAnnotationCommentSummary,
    TAnnotationStableKey,
} from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';

vi.mock('@app/services/pdfjs/getPdfjsViewerRuntimeProbeFailures', () => ({
    EventBus: vi.fn(),
    GenericL10n: vi.fn(),
}));

// The session hands its snapshot identity to the annotation sync bridge and
// keeps no other handle on it. Delegating to the real bridge keeps the session
// behaviour intact while exposing the identity the session actually wired.
const { snapshotDocumentIdentity } = vi.hoisted(() => (
    {snapshotDocumentIdentity: {ref: null as Ref<string> | null}}
));

vi.mock('@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/useAnnotationSync', async (importOriginal) => {
    const actual = await importOriginal<{useAnnotationSync: (options: {documentIdentity: Ref<string>}) => unknown}>();
    return {
        ...actual,
        useAnnotationSync: (options: {documentIdentity: Ref<string>}) => {
            snapshotDocumentIdentity.ref = options.documentIdentity;
            return actual.useAnnotationSync(options);
        },
    };
});

const { createPdfAnnotationSession } = await import(
    '@app/modules/pdf-viewer/runtime/sessions/createPdfAnnotationSession'
);

const lastModified = 1_735_689_600_000;

function createPick(bytes: Uint8Array<ArrayBuffer>) {
    return new File([bytes], 'shared-name.pdf', {lastModified});
}

function createComment(id: string): IAnnotationCommentSummary {
    return {
        source: 'editor',
        id,
        stableKey: `uid:0:${id}` as TAnnotationStableKey,
        pageIndex: 0,
        pageNumber: 1,
        text: 'note',
        subtype: 'Highlight',
        author: null,
        createdAt: null,
        modifiedAt: null,
        color: '#ffff00',
        uid: id,
        annotationId: null,
        annotationName: null,
        hasNote: false,
        markerRect: {
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.04,
        },
    };
}

const mountedSessions: Array<() => void> = [];

afterEach(() => {
    mountedSessions.splice(0).forEach(unmount => unmount());
    snapshotDocumentIdentity.ref = null;
});

function mountAnnotationSession(initial: {
    originalPath?: string | null;
    workingCopyPath?: string | null;
    src?: TPdfSource | null;
} = {}) {
    const originalPath = ref<string | null>(initial.originalPath ?? null);
    const workingCopyPath = ref<string | null>(initial.workingCopyPath ?? null);
    const src = shallowRef<TPdfSource | null>(initial.src ?? null);
    const emitAnnotationComments = vi.fn();
    let session: ReturnType<typeof createPdfAnnotationSession> | undefined;
    const host = document.createElement('div');
    document.body.append(host);
    const AnnotationSessionHost = defineComponent({ setup() {
        session = createPdfAnnotationSession({
            document: {
                pdfDocument: shallowRef(null),
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
            viewerContainer: ref(null),
            originalPath: computed(() => originalPath.value),
            src: computed(() => src.value),
            sourcePdfData: computed(() => null),
            workingCopyPath: computed(() => workingCopyPath.value),
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
            emitAnnotationComments,
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
    if (!session) {
        throw new Error('The annotation session host did not expose a session.');
    }
    const activeSession = session;
    return {
        originalPath,
        workingCopyPath,
        src,
        emitAnnotationComments,
        storeDocumentKey: () => activeSession.annotationApplication.value.documentKey,
        snapshotDocumentKey: () => snapshotDocumentIdentity.ref!.value,
        canonicalAnnotationIds: () => activeSession.annotationApplication.value.store
            .list()
            .map(entity => entity.identity.id),
        ingest: (id: string) => activeSession.annotationApplication.value
            .ingestLegacySummaries([createComment(id)]),
    };
}

describe('annotation document identity', () => {
    it('keys the canonical store on the working copy while the snapshot keeps the original path', () => {
        const harness = mountAnnotationSession({
            originalPath: '/documents/original.pdf',
            workingCopyPath: '/managed/working.pdf',
            src: {
                kind: 'path',
                path: '/managed/working.pdf',
                size: 4,
            },
        });

        expect(harness.storeDocumentKey()).toBe('path:/managed/working.pdf');
        expect(harness.snapshotDocumentKey()).toBe('source:/documents/original.pdf');
    });

    it('rebuilds the canonical store for a new working copy and keeps it across an original-path change', async () => {
        const harness = mountAnnotationSession({
            originalPath: '/documents/original.pdf',
            workingCopyPath: '/managed/working.pdf',
            src: {
                kind: 'path',
                path: '/managed/working.pdf',
                size: 4,
            },
        });
        harness.ingest('editor-highlight');

        expect(harness.canonicalAnnotationIds()).toHaveLength(1);

        harness.originalPath.value = '/documents/renamed.pdf';
        await nextTick();

        // The snapshot cache follows the document the user opened; the
        // canonical store follows the bytes PDF.js currently holds.
        expect(harness.snapshotDocumentKey()).toBe('source:/documents/renamed.pdf');
        expect(harness.storeDocumentKey()).toBe('path:/managed/working.pdf');
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);

        harness.emitAnnotationComments.mockClear();
        harness.workingCopyPath.value = '/managed/other-working.pdf';
        await nextTick();

        expect(harness.storeDocumentKey()).toBe('path:/managed/other-working.pdf');
        expect(harness.canonicalAnnotationIds()).toHaveLength(0);
        expect(harness.emitAnnotationComments).toHaveBeenCalledWith([]);
    });

    it('separates picks that share a name, a size and a timestamp', async () => {
        const first = createPick(Uint8Array.of(1, 2, 3, 4));
        const second = createPick(Uint8Array.of(5, 6, 7, 8));
        const harness = mountAnnotationSession({src: first});

        expect(second).toMatchObject({
            name: first.name,
            size: first.size,
            lastModified: first.lastModified,
        });

        const firstKey = harness.storeDocumentKey();
        harness.ingest('editor-highlight');

        expect(firstKey).not.toContain(first.name);
        expect(harness.canonicalAnnotationIds()).toHaveLength(1);

        harness.src.value = second;
        await nextTick();

        expect(harness.storeDocumentKey()).not.toBe(firstKey);
        expect(harness.canonicalAnnotationIds()).toHaveLength(0);

        harness.src.value = first;
        await nextTick();

        expect(harness.storeDocumentKey()).toBe(firstKey);
    });
});
