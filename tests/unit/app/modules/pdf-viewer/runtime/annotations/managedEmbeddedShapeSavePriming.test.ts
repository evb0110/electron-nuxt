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
    return createManagedShapeStorePort({
        // Revision fencing, not baseline churn, is what these tests exercise.
        preservesShapeImportBaseline: () => true,
        ...overrides,
    }, {skipRerender: true});
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
        workingCopyPath: options.workingCopyPath ?? ref<string | null>('/tmp/save-priming.pdf'),
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

/**
 * A worker that answers only when the test says so, which is what makes an
 * in-flight priming observable.
 */
function stubSilentShapeImportWorker() {
    const terminated: number[] = [];
    const workers: FakeSilentWorker[] = [];

    class FakeSilentWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        readonly index: number;

        constructor() {
            this.index = workers.length;
            workers.push(this);
        }

        postMessage() {}

        terminate() {
            terminated.push(this.index);
        }
    }

    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', FakeSilentWorker);
    return {
        terminated,
        workers,
    };
}

describe('managed embedded shape save priming', () => {
    it('primes saved shapes through the worker client instead of the renderer parser', async () => {
        const workerShapes = [createEmbeddedSquare()];
        const worker = stubShapeImportWorker({
            ok: true,
            shapes: workerShapes,
        });
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const primePersistedShapes = vi.fn(() => true);
        const managedShapes = createManagedShapes({shapeComposable: createShapeStorePort({beginShapeSave: () => ({
            primePersistedShapes,
            rollback: vi.fn(() => true),
            markSaved: vi.fn(() => true),
        })})});
        const savedBytes = new TextEncoder().encode('%PDF-1.7\n% saved bytes');
        const savedByteLength = savedBytes.byteLength;

        await expect(managedShapes.preparePersistedManagedShapesForSave(savedBytes))
            .resolves.toMatchObject({rollback: expect.any(Function)});

        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
        expect(primePersistedShapes).toHaveBeenCalledWith(workerShapes);
        expect(worker.posts).toHaveLength(1);
        expect(worker.posts[0]!.data).toEqual(savedBytes);
        // Persistence still owns the bytes it is about to write: the worker gets
        // a copy, and the caller's view is never detached.
        expect(worker.posts[0]!.data).not.toBe(savedBytes);
        expect(worker.posts[0]!.transfer).toEqual([worker.posts[0]!.data.buffer]);
        expect(savedBytes.byteLength).toBe(savedByteLength);
        expect(new TextDecoder().decode(savedBytes)).toContain('%PDF-1.7');
    });

    it('refuses to prime an oversized document and leaves the save additive', async () => {
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const rollback = vi.fn(() => true);
        const primePersistedShapes = vi.fn(() => true);
        const warn = vi.fn();
        const managedShapes = createManagedShapes({
            shapeComposable: createShapeStorePort({beginShapeSave: () => ({
                primePersistedShapes,
                rollback,
                markSaved: vi.fn(() => true),
            })}),
            logger: {
                debug: vi.fn(),
                warn,
            },
        });

        await expect(managedShapes.preparePersistedManagedShapesForSave(
            new Uint8Array(EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES + 1),
        )).resolves.toBeNull();

        // The guard runs before any parse, on the renderer thread or elsewhere.
        expect(importEmbeddedShapeAnnotations).not.toHaveBeenCalled();
        expect(primePersistedShapes).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(
            'pdf-shapes',
            expect.stringContaining('too large to scan'),
            expect.any(RangeError),
        );
    });

    it('keeps the renderer parser as the fallback when no Worker runtime exists', async () => {
        const fallbackShapes = [createEmbeddedSquare({annotationId: '33R'})];
        vi.mocked(importEmbeddedShapeAnnotations).mockReset().mockResolvedValue(fallbackShapes);
        const primePersistedShapes = vi.fn(() => true);
        const managedShapes = createManagedShapes({shapeComposable: createShapeStorePort({beginShapeSave: () => ({
            primePersistedShapes,
            rollback: vi.fn(() => true),
            markSaved: vi.fn(() => true),
        })})});
        const savedBytes = new TextEncoder().encode('%PDF-1.7\n% no worker runtime');

        await expect(managedShapes.preparePersistedManagedShapesForSave(savedBytes))
            .resolves.toMatchObject({rollback: expect.any(Function)});

        expect(importEmbeddedShapeAnnotations).toHaveBeenCalledWith(savedBytes);
        expect(primePersistedShapes).toHaveBeenCalledWith(fallbackShapes);
    });

    it('refuses to report a preparation the store rejected', async () => {
        stubShapeImportWorker({
            ok: true,
            shapes: [createEmbeddedSquare()],
        });
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const rollback = vi.fn(() => true);
        // A replacement store, or a frontier it never issued, refuses priming.
        const primePersistedShapes = vi.fn(() => false);
        const managedShapes = createManagedShapes({shapeComposable: createShapeStorePort({beginShapeSave: () => ({
            primePersistedShapes,
            rollback,
            markSaved: vi.fn(() => true),
        })})});

        await expect(managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% retired frontier'),
        )).resolves.toBeNull();

        expect(primePersistedShapes).toHaveBeenCalledOnce();
        expect(rollback).toHaveBeenCalledOnce();
    });

    it('cancels an in-flight priming when the viewer adopts a different working copy', async () => {
        const worker = stubSilentShapeImportWorker();
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const rollback = vi.fn(() => true);
        const primePersistedShapes = vi.fn(() => true);
        const workingCopyPath = ref<string | null>('/tmp/save-priming.pdf');
        const managedShapes = createManagedShapes({
            workingCopyPath,
            shapeComposable: createShapeStorePort({beginShapeSave: () => ({
                primePersistedShapes,
                rollback,
                markSaved: vi.fn(() => true),
            })}),
        });

        const priming = managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% superseded save'),
        );
        await vi.waitFor(() => expect(worker.workers).toHaveLength(1));

        // Adopting another document retires the save this priming belongs to.
        workingCopyPath.value = '/tmp/another-document.pdf';
        void managedShapes.ensureManagedShapeBaselineReady().catch(() => undefined);

        await expect(priming).resolves.toBeNull();
        expect(worker.terminated).toContain(0);
        expect(primePersistedShapes).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalledOnce();
    });

    it('keeps an in-flight priming alive while the same working copy is republished', async () => {
        const worker = stubSilentShapeImportWorker();
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const rollback = vi.fn(() => true);
        const documentRevisionToken = ref<TDocumentRevisionToken | null>(
            requireDocumentRevisionToken('revision-before-save'),
        );
        const managedShapes = createManagedShapes({
            documentRevisionToken,
            shapeComposable: createShapeStorePort({beginShapeSave: () => ({
                primePersistedShapes: vi.fn(() => true),
                rollback,
                markSaved: vi.fn(() => true),
            })}),
        });

        const priming = managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% same document'),
        );
        await vi.waitFor(() => expect(worker.workers).toHaveLength(1));

        // A successful save republishes the same working copy under a new
        // revision. The priming that produced those bytes must survive it.
        documentRevisionToken.value = requireDocumentRevisionToken('revision-after-save');
        void managedShapes.ensureManagedShapeBaselineReady().catch(() => undefined);
        await nextTick();

        expect(worker.terminated).not.toContain(0);
        expect(rollback).not.toHaveBeenCalled();

        worker.workers[0]!.onmessage?.({data: {
            ok: true,
            shapes: [],
        }} as MessageEvent);
        await expect(priming).resolves.toMatchObject({rollback: expect.any(Function)});
    });

    it('refuses a completed priming once the viewer holds a different document', async () => {
        const worker = stubSilentShapeImportWorker();
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const rollback = vi.fn(() => true);
        const primePersistedShapes = vi.fn(() => true);
        // Save As keeps the working copy path and moves the document identity,
        // so the path alone cannot tell these two documents apart.
        const originalPath = ref<string | null>('/library/scan.pdf');
        const managedShapes = createManagedShapes({
            originalPath,
            shapeComposable: createShapeStorePort({beginShapeSave: () => ({
                primePersistedShapes,
                rollback,
                markSaved: vi.fn(() => true),
            })}),
        });

        const priming = managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% replaced document'),
        );
        await vi.waitFor(() => expect(worker.workers).toHaveLength(1));

        originalPath.value = '/library/another-scan.pdf';
        worker.workers[0]!.onmessage?.({data: {
            ok: true,
            shapes: [createEmbeddedSquare()],
        }} as MessageEvent);

        await expect(priming).resolves.toBeNull();
        expect(primePersistedShapes).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalledOnce();
    });

    it('cancels an in-flight priming when the composable is disposed', async () => {
        const worker = stubSilentShapeImportWorker();
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const rollback = vi.fn(() => true);
        const primePersistedShapes = vi.fn(() => true);
        const scope = effectScope();
        const managedShapes = scope.run(() => createManagedShapes({shapeComposable: createShapeStorePort({beginShapeSave: () => ({
            primePersistedShapes,
            rollback,
            markSaved: vi.fn(() => true),
        })})}))!;

        const priming = managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% closing document'),
        );
        await vi.waitFor(() => expect(worker.workers).toHaveLength(1));

        // Closing the tab must not leave a whole-document parse running.
        scope.stop();

        await expect(priming).resolves.toBeNull();
        expect(worker.terminated).toContain(0);
        expect(primePersistedShapes).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalledOnce();
    });

    it('rolls the save frontier back when worker priming fails', async () => {
        stubShapeImportWorker({
            ok: false,
            error: 'worker exploded',
        });
        vi.mocked(importEmbeddedShapeAnnotations).mockReset();
        const rollback = vi.fn(() => true);
        const primePersistedShapes = vi.fn(() => true);
        const managedShapes = createManagedShapes({shapeComposable: createShapeStorePort({beginShapeSave: () => ({
            primePersistedShapes,
            rollback,
            markSaved: vi.fn(() => true),
        })})});

        await expect(managedShapes.preparePersistedManagedShapesForSave(
            new TextEncoder().encode('%PDF-1.7\n% failing worker'),
        )).resolves.toBeNull();

        expect(primePersistedShapes).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalledOnce();
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
        expect(shapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();
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
        expect(shapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();
    });
});
