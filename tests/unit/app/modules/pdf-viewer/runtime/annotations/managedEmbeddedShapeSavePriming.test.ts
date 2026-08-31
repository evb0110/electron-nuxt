import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Ref } from 'vue';
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import type { IShapeAnnotation } from '@app/types/annotations';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
// Save priming imports the worker client on demand. Loading it during
// collection keeps its first, cold transform out of a test's own budget.
import '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient';
import { EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeImportLimit';
import {
    type IManagedEmbeddedPdfShapeProjectionPort,
    useManagedEmbeddedPdfShapes,
} from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';
import { invalidateEmbeddedShapeImportCache } from '@app/modules/pdf-viewer/runtime/annotations/embeddedShapeImportCache';
import { createManagedShapeStorePort } from '@tests/unit/app/modules/pdf-viewer/runtime/annotations/createManagedShapeStorePort';
import {
    requireDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';

vi.mock(
    '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations',
    () => ({ importEmbeddedShapeAnnotations: vi.fn() }),
);

afterEach(() => {
    invalidateEmbeddedShapeImportCache();
    vi.unstubAllGlobals();
});

function createEmbeddedSquare(overrides: Partial<IShapeAnnotation> = {}): IShapeAnnotation {
    return {
        id: 'embedded-square-1',
        type: 'rectangle',
        pageIndex: 0,
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.4,
        color: '#336699',
        opacity: 1,
        strokeWidth: 2,
        source: 'embedded',
        annotationId: '21R',
        stableKey: 'evb-shape:embedded-square-1',
        pdfSubtype: 'Square',
        ...overrides,
    };
}

function createShapeStorePort(
    overrides: Partial<IManagedEmbeddedPdfShapeProjectionPort> = {},
): IManagedEmbeddedPdfShapeProjectionPort {
    return createManagedShapeStorePort(overrides);
}

function createManagedShapes(options: {
    shapeComposable: IManagedEmbeddedPdfShapeProjectionPort;
    sourcePdfData?: Ref<Uint8Array | null>;
    workingCopyPath?: Ref<string | null>;
    originalPath?: Ref<string | null>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
    logger?: {
        debug: (scope: string, message: string, payload?: unknown) => void;
        warn: (scope: string, message: string, payload?: unknown) => void;
    };
}) {
    return useManagedEmbeddedPdfShapes({
        viewerContainer: ref(null),
        ...(options.originalPath ? {originalPath: options.originalPath} : {}),
        workingCopyPath: options.workingCopyPath ?? ref<string | null>('browser://documents/save-priming.pdf'),
        sourcePdfData: options.sourcePdfData ?? ref<Uint8Array | null>(new Uint8Array([1])),
        documentRevisionToken: options.documentRevisionToken ?? ref<TDocumentRevisionToken | null>(null),
        visibleRange: ref({
            start: 1,
            end: 1,
        }),
        bufferPages: ref(0),
        shapeComposable: options.shapeComposable,
        deletedEmbeddedAnnotationIds: ref(new Set<string>()),
        logger: options.logger ?? {
            debug: vi.fn(),
            warn: vi.fn(),
        },
        runGuardedTask: task => void Promise.resolve(task()),
        nextTick,
        isPageRendered: () => true,
        invalidatePages: vi.fn(),
        renderVisiblePages: vi.fn(async () => undefined),
        hideManagedAnnotationEditors: vi.fn(),
        currentPage: ref(1),
    });
}

interface IWorkerPost {
    data: Uint8Array;
    transfer: Transferable[] | undefined;
}

function stubShapeImportWorker(reply: {
    ok: boolean;
    shapes?: IShapeAnnotation[];
    error?: string;
}) {
    const posts: IWorkerPost[] = [];
    const terminate = vi.fn();

    class FakeWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;

        postMessage(message: {data: Uint8Array}, transfer?: Transferable[]) {
            posts.push({
                data: message.data,
                transfer,
            });
            queueMicrotask(() => this.onmessage?.({data: reply} as MessageEvent));
        }

        terminate() {
            terminate();
        }
    }

    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', FakeWorker);
    return {
        posts,
        terminate,
    };
}

describe('managed embedded shape save priming', () => {
    it('defers save-shape baseline ownership to canonical document parsing', async () => {
        const worker = stubShapeImportWorker({
            ok: true,
            shapes: [createEmbeddedSquare()],
        });
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const managedShapes = createManagedShapes({shapeComposable: createShapeStorePort()});
        const savedBytes = new TextEncoder().encode('%PDF-1.7\n% saved bytes');

        await expect(managedShapes.preparePersistedManagedShapesForSave(savedBytes))
            .resolves.toBeNull();

        expect(worker.posts).toHaveLength(0);
        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
    });

    it('accepts oversized save bytes without attempting a legacy shape scan', async () => {
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const managedShapes = createManagedShapes({shapeComposable: createShapeStorePort()});

        await expect(managedShapes.preparePersistedManagedShapesForSave(
            new Uint8Array(EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES + 1),
        )).resolves.toBeNull();

        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
    });

    it('does not fall back to the renderer parser when no Worker runtime exists', async () => {
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockResolvedValue([createEmbeddedSquare({annotationId: '33R'})]);
        const managedShapes = createManagedShapes({shapeComposable: createShapeStorePort()});

        await expect(managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% no worker runtime'),
        )).resolves.toBeNull();

        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
    });

    it('does not report a legacy preparation when the canonical store has no frontier adapter', async () => {
        const managedShapes = createManagedShapes({shapeComposable: createShapeStorePort()});

        await expect(managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% retired frontier'),
        )).resolves.toBeNull();
    });

    it('does not start a scan when the working copy changes during save preparation', async () => {
        const workingCopyPath = ref<string | null>('browser://documents/save-priming.pdf');
        const managedShapes = createManagedShapes({
            workingCopyPath,
            shapeComposable: createShapeStorePort(),
        });

        const priming = managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% superseded save'),
        );
        workingCopyPath.value = 'browser://documents/another-document.pdf';

        await expect(priming).resolves.toBeNull();
        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
    });

    it('does not scan again when the same working copy is republished', async () => {
        const documentRevisionToken = ref<TDocumentRevisionToken | null>(
            requireDocumentRevisionToken('revision-before-save'),
        );
        const managedShapes = createManagedShapes({
            documentRevisionToken,
            shapeComposable: createShapeStorePort(),
        });

        const priming = managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% same document'),
        );
        documentRevisionToken.value = requireDocumentRevisionToken('revision-after-save');

        await expect(priming).resolves.toBeNull();
        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
    });

    it('does not retain save work after the composable is disposed', async () => {
        const scope = effectScope();
        const managedShapes = scope.run(() => createManagedShapes({shapeComposable: createShapeStorePort()}))!;

        const priming = managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% closing document'),
        );
        scope.stop();

        await expect(priming).resolves.toBeNull();
        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
    });

    it('keeps save preparation successful when the legacy worker would fail', async () => {
        stubShapeImportWorker({
            ok: false,
            error: 'worker exploded',
        });
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const managedShapes = createManagedShapes({shapeComposable: createShapeStorePort()});

        await expect(managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% failing worker'),
        )).resolves.toBeNull();

        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
    });
});

describe('embedded shape import revision fencing', () => {
    it('never applies an in-flight import after the document revision changes', async () => {
        const imported = Promise.withResolvers<IShapeAnnotation[]>();
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockReturnValueOnce(imported.promise);
        const shapeComposable = createShapeStorePort();
        const documentRevisionToken = ref<TDocumentRevisionToken | null>(
            requireDocumentRevisionToken('revision-before'),
        );
        const managedShapes = createManagedShapes({
            shapeComposable,
            documentRevisionToken,
        });

        const baseline = managedShapes.ensureManagedShapeBaselineReady();
        await vi.waitFor(() => expect(importEmbeddedShapeAnnotations).toHaveBeenCalledOnce());

        documentRevisionToken.value = requireDocumentRevisionToken('revision-after');
        await nextTick();
        imported.resolve([createEmbeddedSquare()]);

        await expect(baseline).rejects.toThrow('PDF source changed while establishing embedded shape baseline');
        expect(shapeComposable.getAllShapes()).toEqual([]);
    });

    it('never applies an in-flight import after the source bytes are replaced', async () => {
        const imported = Promise.withResolvers<IShapeAnnotation[]>();
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockReturnValueOnce(imported.promise);
        const shapeComposable = createShapeStorePort();
        const sourcePdfData = ref<Uint8Array | null>(new Uint8Array([1]));
        const documentRevisionToken = ref<TDocumentRevisionToken | null>(
            requireDocumentRevisionToken('revision-before'),
        );
        const managedShapes = createManagedShapes({
            shapeComposable,
            sourcePdfData,
            documentRevisionToken,
        });

        const baseline = managedShapes.ensureManagedShapeBaselineReady();
        await vi.waitFor(() => expect(importEmbeddedShapeAnnotations).toHaveBeenCalledOnce());

        // Adopting a new working copy publishes new bytes with a new revision.
        sourcePdfData.value = new Uint8Array([2]);
        documentRevisionToken.value = requireDocumentRevisionToken('revision-after');
        await nextTick();
        imported.resolve([createEmbeddedSquare()]);

        await expect(baseline).rejects.toThrow('PDF source changed while establishing embedded shape baseline');
        expect(shapeComposable.getAllShapes()).toEqual([]);
    });
});
