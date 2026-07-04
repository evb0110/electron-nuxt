import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
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
import type { IAnnotationCommentSummary } from '@app/types/annotations';

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
    consumePendingEmbeddedAnnotationDeletes?: () => IAnnotationCommentSummary[] | null;
    consumePendingEmbeddedTextUpdates?: () => Map<string, string> | null;
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
                documentRevisionToken: ref('rev-1'),
            },
            annotations: {
                annotationDirty: ref(false),
                annotationComments: ref([]),
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
                nativeMutationPlan: null,
                annotationSavePlan: {
                    route: 'source-clean' as const,
                    expectedCost: 'small' as const,
                    reason: 'no-live-pdfjs-annotation-work' as const,
                    unreplayableLiveAnnotationIds: [],
                },
                annotationCommentsSnapshot: [],
                pendingEmbeddedTextUpdates: new Map(),
                pendingEmbeddedAnnotationDeletes: [],
                restoreConsumedPendingEmbeddedMutations: vi.fn(),
                commitConsumedPendingEmbeddedMutations: vi.fn(),
            })),
            saveDocument: vi.fn(async () => new Uint8Array([1])),
            getSourcePdfData: vi.fn(async () => new Uint8Array([1])),
            commitPdfEditorsForSave: overrides.commitPdfEditorsForSave ?? vi.fn(async () => undefined),
        }},
        annotationEdits: {
            annotationNoteWindowsCount: ref(overrides.annotationNoteWindowsCount ?? 0),
            consumePendingEmbeddedAnnotationDeletes: overrides.consumePendingEmbeddedAnnotationDeletes ?? vi.fn(() => null),
            consumePendingEmbeddedTextUpdates: overrides.consumePendingEmbeddedTextUpdates ?? vi.fn(() => null),
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
        const consumePendingEmbeddedTextUpdates = vi.fn(() => null);
        const preparePostSaveReload = vi.fn(createReloadWaiter);
        const ports = createContextPorts({
            annotationNoteWindowsCount: 1,
            commitPdfEditorsForSave,
            consumePendingEmbeddedTextUpdates,
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
        expect(consumePendingEmbeddedTextUpdates).not.toHaveBeenCalled();
        expect(preparePostSaveReload).not.toHaveBeenCalled();
    });

    it('consumes pending edits and assembles the save plan context without owning PDF.js commit', async () => {
        const callOrder: string[] = [];
        const phases: string[] = [];
        const pendingTexts = new Map([[
            'ann:0:3856R',
            'Updated note',
        ]]);
        const commitPdfEditorsForSave = vi.fn(async () => {
            callOrder.push('commit-editors');
        });
        const consumePendingEmbeddedTextUpdates = vi.fn(() => {
            callOrder.push('consume-texts');
            return pendingTexts;
        });
        const consumePendingEmbeddedAnnotationDeletes = vi.fn(() => {
            callOrder.push('consume-deletes');
            return null;
        });
        const preparePostSaveReload = vi.fn(createReloadWaiter);
        const ports = createContextPorts({
            commitPdfEditorsForSave,
            consumePendingEmbeddedAnnotationDeletes,
            consumePendingEmbeddedTextUpdates,
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
        expect(callOrder).toEqual([
            'consume-texts',
            'consume-deletes',
        ]);
        expect(commitPdfEditorsForSave).not.toHaveBeenCalled();
        expect(context?.dirtyState).toMatchObject({
            pageLabels: true,
            pendingTexts: true,
            shapes: true,
        });
        expect(context?.pendingTexts).toBe(pendingTexts);
        expect(context?.savePlan.persistenceRoute).toBe('native-mutations-or-serialized');
        expect(context?.saveStateSnapshot).toEqual({
            annotation: 'annotation-token',
            pageLabels: 'page-label-token',
            bookmarks: 'bookmark-token',
        });
        expect(preparePostSaveReload).toHaveBeenCalledOnce();
        expect(context?.reloadWaiter.current).not.toBeNull();
    });
});
