import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { requireDocumentRevisionToken } from '@contracts/documentRevision';
import {
    ref,
    shallowRef,
} from 'vue';
import {
    createFileOperationsSaveContext,
    type IFileOperationsSaveContextPorts,
    type IFileOperationsSaveContextRequest,
    type IFileOperationsSaveContextServices,
} from '@app/modules/workspace-shell/composables/file-operations/createFileOperationsSaveContext';

const BASE_REQUEST: IFileOperationsSaveContextRequest = {
    mode: 'save',
    persistOpenNotesAbortMessage: 'Save aborted because annotation note persistence failed',
    shouldPreferWorkingCopy: true,
    canPersistNativeWorkingCopy: false,
    canAttemptNativeMutationSave: true,
};

function createReloadWaiter() {
    return {
        promise: Promise.resolve(),
        cancel: vi.fn(),
    };
}

function createContextPorts(overrides: {
    annotationNoteWindowsCount?: number;
    commitPdfEditorsForSave?: () => Promise<void>;
    hasShapeChanges?: () => boolean;
    pageLabelsDirty?: boolean;
    persistAllAnnotationNotes?: () => Promise<boolean>;
    preparePostSaveReload?: () => ReturnType<typeof createReloadWaiter>;
} = {}): IFileOperationsSaveContextPorts {
    return {
        state: {
            documentIdentity: {
                workingCopyPath: ref('/tmp/work.pdf'),
                originalPath: ref('/tmp/source.pdf'),
                documentRevisionToken: ref(requireDocumentRevisionToken('rev-1')),
            },
            annotations: {
                annotationDirty: ref(false),
                markAnnotationSaved: vi.fn(),
                hasAnnotationChanges: vi.fn(() => false),
                hasLivePdfJsAnnotationChanges: vi.fn(() => false),
                hasPreservedAnnotationSourceChanges: vi.fn(() => false),
                hasSavedPdfJsAnnotationBaselineChanges: vi.fn(() => false),
            },
            metadata: {
                pageLabelsDirty: ref(overrides.pageLabelsDirty ?? false),
                bookmarksDirty: ref(false),
            },
        },
        pdf: {source: {
            pdfDocument: shallowRef(null),
            runSaveTransaction: vi.fn(async () => ({
                source: 'pdfjs-materialize' as const,
                baseBytes: null,
                serializedBytes: new Uint8Array([1]),
                serializedResult: null,
                nativeMutationProjection: null,
                annotationSavePlan: {
                    route: 'source-clean' as const,
                    expectedCost: 'small' as const,
                    reason: 'no-live-pdfjs-annotation-work' as const,
                    unreplayableLiveAnnotationIds: [],
                },
            })),
            saveDocument: vi.fn(async () => new Uint8Array([1])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
            commitPdfEditorsForSave: overrides.commitPdfEditorsForSave ?? vi.fn(async () => undefined),
        }},
        annotationEdits: {
            annotationNoteWindowsCount: ref(overrides.annotationNoteWindowsCount ?? 0),
            persistAllAnnotationNotes: vi.fn(overrides.persistAllAnnotationNotes ?? (async () => true)),
        },
        viewer: {
            markup: {},
            shapes: {
                hasShapeChanges: overrides.hasShapeChanges ?? vi.fn(() => false),
                hasManagedShapes: vi.fn(() => false),
            },
        },
        lifecycle: {preparePostSaveReload: overrides.preparePostSaveReload ?? vi.fn(createReloadWaiter)},
    };
}

function createContextServices(phases: string[] = []): IFileOperationsSaveContextServices {
    return {
        captureSaveStateSnapshot: vi.fn(() => ({
            annotation: 'annotation-token',
            pageLabels: 'page-label-token',
            bookmarks: 'bookmark-token',
        })),
        timedSavePhase: async (phase, operation) => {
            phases.push(phase);
            return operation();
        },
    };
}

describe('createFileOperationsSaveContext', () => {
    it('aborts before editor commit when open annotation notes cannot be persisted', async () => {
        const commitPdfEditorsForSave = vi.fn(async () => undefined);
        const preparePostSaveReload = vi.fn(createReloadWaiter);
        const ports = createContextPorts({
            annotationNoteWindowsCount: 1,
            commitPdfEditorsForSave,
            persistAllAnnotationNotes: async () => false,
            preparePostSaveReload,
        });
        const { prepareSaveContext } = createFileOperationsSaveContext(ports, createContextServices());

        await expect(prepareSaveContext(
            BASE_REQUEST,
            '/tmp/work.pdf',
            '/tmp/source.pdf',
        )).resolves.toBeNull();

        expect(ports.annotationEdits.persistAllAnnotationNotes).toHaveBeenCalledWith(true);
        expect(commitPdfEditorsForSave).not.toHaveBeenCalled();
        expect(preparePostSaveReload).not.toHaveBeenCalled();
    });

    it('assembles the save selection without consuming mutable pending-edit snapshots', async () => {
        const callOrder: string[] = [];
        const phases: string[] = [];
        const commitPdfEditorsForSave = vi.fn(async () => {
            callOrder.push('commit-editors');
        });
        const preparePostSaveReload = vi.fn(createReloadWaiter);
        const ports = createContextPorts({
            commitPdfEditorsForSave,
            hasShapeChanges: vi.fn(() => true),
            pageLabelsDirty: true,
            preparePostSaveReload,
        });
        const { prepareSaveContext } = createFileOperationsSaveContext(ports, createContextServices(phases));

        const context = await prepareSaveContext(
            BASE_REQUEST,
            '/tmp/work.pdf',
            '/tmp/source.pdf',
        );

        expect(context).not.toBeNull();
        expect(phases).toEqual([]);
        expect(callOrder).toEqual([]);
        expect(commitPdfEditorsForSave).not.toHaveBeenCalled();
        expect(context?.dirtyState).toMatchObject({
            pageLabels: true,
            pendingTexts: false,
            shapes: true,
        });
        expect(context?.savePlan.persistenceRoute).toBe('native-mutations-or-serialized');
        expect(context?.saveStateSnapshot).toEqual({
            annotation: 'annotation-token',
            pageLabels: 'page-label-token',
            bookmarks: 'bookmark-token',
        });
        expect(preparePostSaveReload).not.toHaveBeenCalled();
        expect(context?.reloadWaiter.current).not.toBeNull();
        expect(preparePostSaveReload).toHaveBeenCalledOnce();
    });
});
