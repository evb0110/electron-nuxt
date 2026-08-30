import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    nextTick,
    ref,
} from 'vue';
import type {IShapeAnnotation} from '@app/types/annotations';
import {
    type IManagedEmbeddedPdfShapeProjectionPort,
    useManagedEmbeddedPdfShapes,
} from '@app/modules/pdf-viewer/runtime/annotations/useManagedEmbeddedPdfShapes';
import {createManagedShapeStorePort} from '@tests/unit/app/modules/pdf-viewer/runtime/annotations/createManagedShapeStorePort';
import {requireDocumentRevisionToken} from '@contracts/documentRevision';

const mocks = vi.hoisted(() => ({
    importNative: vi.fn(),
    importWorker: vi.fn(),
    importPath: vi.fn(),
}));

vi.mock('@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeAnnotationsWorkerClient', () => ({
    isNativeEmbeddedShapeImportSource: () => true,
    importEmbeddedShapeAnnotationsFromNativePath: mocks.importNative,
    importEmbeddedShapeAnnotationsUsingWorker: mocks.importWorker,
    importEmbeddedShapeAnnotationsFromPathInWorker: mocks.importPath,
}));

const nativePath = '/tmp/native-reconciliation.pdf';
const revision = requireDocumentRevisionToken('drt1:native-reconciliation');

function createNativeShape(): IShapeAnnotation {
    return {
        id: 'embedded-shape:0:evb-shape:native',
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
        annotationId: '42R',
        stableKey: 'evb-shape:native',
        pdfSubtype: 'Square',
    };
}

function createManagedShapes(shapeComposable: IManagedEmbeddedPdfShapeProjectionPort) {
    return useManagedEmbeddedPdfShapes({
        viewerContainer: ref(null),
        originalPath: ref('/library/native-reconciliation.pdf'),
        workingCopyPath: ref(nativePath),
        // This buffer is intentionally unrelated to the native reconciliation.
        // A trusted path source must not make the save path parse it.
        sourcePdfData: ref(new Uint8Array([
            1,
            2,
            3,
        ])),
        documentRevisionToken: ref(revision),
        visibleRange: ref({
            start: 1,
            end: 1,
        }),
        bufferPages: ref(0),
        shapeComposable,
        deletedEmbeddedAnnotationIds: ref(new Set<string>()),
        logger: {
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

beforeEach(() => {
    mocks.importNative.mockReset();
    mocks.importWorker.mockReset();
    mocks.importPath.mockReset();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('managed embedded shape native save reconciliation', () => {
    it('primes persisted identity from the native index and ignores saved bytes', async () => {
        const importedShapes = [createNativeShape()];
        mocks.importNative.mockResolvedValue(importedShapes);
        const primePersistedShapes = vi.fn(() => true);
        const rollback = vi.fn(() => true);
        const shapeComposable = createManagedShapeStorePort({beginShapeSave: () => ({
            primePersistedShapes,
            rollback,
            markSaved: vi.fn(() => true),
        })});
        const managedShapes = createManagedShapes(shapeComposable);
        const savedBytes = new Uint8Array(3 * 1024 * 1024);

        await expect(managedShapes.preparePersistedManagedShapesForSave(savedBytes))
            .resolves.toMatchObject({rollback: expect.any(Function)});

        expect(mocks.importNative).toHaveBeenCalledWith(nativePath, {
            signal: expect.any(AbortSignal),
            expectedDocumentRevisionToken: revision,
        });
        expect(mocks.importWorker).not.toHaveBeenCalled();
        expect(mocks.importPath).not.toHaveBeenCalled();
        expect(primePersistedShapes).toHaveBeenCalledWith(importedShapes);
        expect(rollback).not.toHaveBeenCalled();
    });

    it('leaves the shape frontier unprimed when the native index is unavailable', async () => {
        const rollback = vi.fn(() => true);
        mocks.importNative.mockRejectedValue(new Error('native index unavailable'));
        const shapeComposable = createManagedShapeStorePort({beginShapeSave: () => ({
            primePersistedShapes: vi.fn(() => true),
            rollback,
            markSaved: vi.fn(() => true),
        })});
        const managedShapes = createManagedShapes(shapeComposable);

        await expect(managedShapes.preparePersistedManagedShapesForSave(new Uint8Array([9])))
            .resolves.toBeNull();

        expect(mocks.importWorker).not.toHaveBeenCalled();
        expect(mocks.importPath).not.toHaveBeenCalled();
        expect(rollback).toHaveBeenCalledOnce();
    });

    it('keeps an open path baseline incomplete instead of falling back to bytes', async () => {
        const error = Object.assign(new Error('native index capability is unavailable'), {
            name: 'EmbeddedShapeImportCapabilityError',
            reason: 'native-index-capability-unavailable',
        });
        mocks.importNative.mockRejectedValue(error);
        const shapeComposable = createManagedShapeStorePort();
        const managedShapes = createManagedShapes(shapeComposable);

        await expect(managedShapes.ensureManagedShapeBaselineReady()).resolves.toBe(false);

        expect(mocks.importNative).toHaveBeenCalledOnce();
        expect(mocks.importWorker).not.toHaveBeenCalled();
        expect(mocks.importPath).not.toHaveBeenCalled();
        expect(shapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();
    });

    it('does not apply a revision-triggered native import across an active save preparation', async () => {
        const backgroundImport = Promise.withResolvers<IShapeAnnotation[]>();
        const savedShapeIndex = Promise.withResolvers<IShapeAnnotation[]>();
        mocks.importNative
            .mockResolvedValue([])
            .mockReturnValueOnce(backgroundImport.promise)
            .mockReturnValueOnce(savedShapeIndex.promise);
        const markSaved = vi.fn(() => true);
        const shapeComposable = createManagedShapeStorePort({
            isShapeImportBaselineReady: () => true,
            beginShapeSave: () => ({
                primePersistedShapes: vi.fn(() => true),
                rollback: vi.fn(() => true),
                markSaved,
            }),
        });
        const managedShapes = createManagedShapes(shapeComposable);

        const revisionImport = managedShapes.ensureManagedShapeBaselineReady();
        await vi.waitFor(() => expect(mocks.importNative).toHaveBeenCalledOnce());
        const preparationPromise = managedShapes.preparePersistedManagedShapesForSave();
        await vi.waitFor(() => expect(mocks.importNative).toHaveBeenCalledTimes(2));

        backgroundImport.resolve([]);
        await expect(Promise.race([
            revisionImport.then(() => 'settled'),
            new Promise(resolve => setTimeout(() => resolve('pending'), 20)),
        ])).resolves.toBe('pending');
        expect(shapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();

        savedShapeIndex.resolve([]);
        const preparation = await preparationPromise;
        expect(preparation).not.toBeNull();
        expect(shapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();

        preparation!.markSaved();
        await expect(revisionImport).resolves.toBe(true);
        expect(markSaved).toHaveBeenCalledOnce();
        expect(shapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();

        await expect(managedShapes.ensureManagedShapeBaselineReady()).resolves.toBe(true);
        expect(mocks.importNative).toHaveBeenCalledTimes(2);
        expect(shapeComposable.importEmbeddedShapes).not.toHaveBeenCalled();
    });
});
