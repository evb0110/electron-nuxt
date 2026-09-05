import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import {createPageMutationAnnotationMaterializer} from '@app/modules/workspace-shell/composables/createPageMutationAnnotationMaterializer';
import type { INativePdfMutationProjection } from '@app/modules/pdf-viewer/public';
import {
    requireDocumentRef,
    type TDocumentRef,
} from '@contracts/documentRef';
import type { ITypedStagedArtifact } from '@contracts/stagedArtifacts';
import {TEST_PDF_SAVE_BYTE_ROUTE_DECISION} from '@tests/unit/app/modules/pdf-viewer/runtime/save/testPdfSaveByteRouteDecision';
import {requireDocumentRevisionToken} from '@contracts';
import {requireLeaseId} from '@contracts/shared';

const nativeMocks = vi.hoisted(() => ({
    createManagedTempFileHandle: vi.fn(),
    releaseManagedTempFileHandle: vi.fn(),
    applyPdfNativeMutationsToWorkingCopy: vi.fn(),
    cloneStagedPdfNativeMutationToWorkingCopy: vi.fn(),
    replaceWorkingCopyFromStagedPdfNativeMutation: vi.fn(),
}));

vi.mock('@app/utils/platformDocuments', () => ({getDocumentFilesCapability: () => nativeMocks}));

const nativeProjection: INativePdfMutationProjection = {
    canonicalAnnotationProgram: [],
    mutations: {updates: []},
    noteTextUpdates: [],
    freeTextNotes: [],
    freeTextEditors: [],
    annotationDeletes: [],
    hasMetadataMutations: false,
    hasShapeMutations: false,
    hasMarkupMutations: false,
    phase: 'test-native-page-mutation',
};

const nativeStagedArtifact: ITypedStagedArtifact = {
    receiptVersion: 1,
    artifactKind: 'pdf',
    path: requireDocumentRef('/tmp/native-staged.pdf'),
    size: 3,
    sha256: 'b'.repeat(64),
    fileIdentity: {
        platform: 'posix',
        deviceId: '1',
        inode: '2',
    },
    validations: {
        qpdfCheck: false,
        tailCheck: true,
        semanticCheck: true,
        semanticScopeSha256: 'c'.repeat(64),
        fsynced: true,
    },
    leaseId: requireLeaseId('staged-lease'),
    revision: requireDocumentRevisionToken('revision-1'),
};

describe('createPageMutationAnnotationMaterializer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nativeMocks.createManagedTempFileHandle.mockResolvedValue({
            path: '/tmp/document.pdf',
            size: 2,
            sha256: 'a'.repeat(64),
            leaseId: 'base-lease',
            revision: requireDocumentRevisionToken('revision-1'),
        });
        nativeMocks.releaseManagedTempFileHandle.mockResolvedValue(true);
        nativeMocks.applyPdfNativeMutationsToWorkingCopy.mockResolvedValue({
            applied: true,
            validation: {
                isValid: true,
                tool: 'native',
                errors: [],
                warnings: [],
            },
            stagedOutput: nativeStagedArtifact,
        });
        nativeMocks.replaceWorkingCopyFromStagedPdfNativeMutation.mockResolvedValue(true);
    });

    it('commits the captured annotation frontier while conserving sidebar and annotation selection state', async () => {
        const selectedAnnotationStableKey = ref<string | null>('ann:page-id:note-a');
        const sidebarTab = ref<'annotations' | 'thumbnails'>('annotations');
        const callOrder: string[] = [];
        const bytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        const runSaveTransaction = vi.fn(async () => ({
            source: 'pdfjs-materialize' as const,
            baseBytes: bytes,
            serializedBytes: null,
            serializedResult: null,
            nativeMutationProjection: null,
            fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
            annotationSavePlan: {
                route: 'pdfjs-materialize' as const,
                expectedCost: 'full-document' as const,
                reason: 'live-pdfjs-annotation-storage' as const,
                unreplayableLiveAnnotationIds: [],
            },
            verifyAnnotationSave: async () => { callOrder.push('verify'); },
            commitAnnotationSave: () => callOrder.push('commit-frontier'),
        }));
        const workingCopyPath = ref<TDocumentRef | null>(requireDocumentRef('browser://documents/document.pdf'));
        const documentRevisionToken = ref(requireDocumentRevisionToken('revision-1'));
        const materialize = createPageMutationAnnotationMaterializer({
            annotationDirty: ref(true),
            hasAnnotationChanges: () => true,
            hasLivePdfJsAnnotationChanges: () => true,
            hasSavedPdfJsAnnotationBaselineChanges: () => false,
            pendingEmbeddedAnnotationDeleteCount: ref(0),
            preservedAnnotationSourceDirty: ref(false),
            workingCopyPath,
            documentRevisionToken,
            pdfViewerRef: ref({runSaveTransaction}),
            currentPage: ref(2),
            waitForPdfReload: async () => { callOrder.push('reload'); },
            loadPdfFromData: async () => { callOrder.push('persist'); },
        });

        await expect(materialize()).resolves.toBe(true);

        expect(callOrder).toEqual([
            'verify',
            'reload',
            'persist',
            'commit-frontier',
        ]);
        expect(selectedAnnotationStableKey.value).toBe('ann:page-id:note-a');
        expect(sidebarTab.value).toBe('annotations');
    });

    it('rejects stale bytes and acknowledgement when the same path receives another revision', async () => {
        const bytes = new Uint8Array([1]);
        const workingCopyPath = ref<TDocumentRef | null>(requireDocumentRef('browser://documents/document.pdf'));
        const documentRevisionToken = ref(requireDocumentRevisionToken('revision-1'));
        const verifyAnnotationSave = vi.fn(async () => undefined);
        const assertAnnotationSaveCurrent = vi.fn(async () => undefined);
        const commitAnnotationSave = vi.fn();
        const loadPdfFromData = vi.fn(async () => undefined);
        const viewer = {runSaveTransaction: vi.fn(async () => {
            documentRevisionToken.value = requireDocumentRevisionToken('revision-2');
            return {
                source: 'pdfjs-materialize' as const,
                baseBytes: bytes,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection: null,
                fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
                annotationSavePlan: TEST_PDF_SAVE_BYTE_ROUTE_DECISION.annotationPlan,
                verifyAnnotationSave,
                assertAnnotationSaveCurrent,
                commitAnnotationSave,
            };
        })};
        const materialize = createPageMutationAnnotationMaterializer({
            annotationDirty: ref(true),
            hasAnnotationChanges: () => true,
            hasLivePdfJsAnnotationChanges: () => false,
            hasSavedPdfJsAnnotationBaselineChanges: () => false,
            pendingEmbeddedAnnotationDeleteCount: ref(0),
            preservedAnnotationSourceDirty: ref(false),
            workingCopyPath,
            documentRevisionToken,
            pdfViewerRef: ref(viewer),
            currentPage: ref(1),
            waitForPdfReload: vi.fn(async () => undefined),
            loadPdfFromData,
        });

        await expect(materialize()).resolves.toBe(false);

        expect(assertAnnotationSaveCurrent).not.toHaveBeenCalled();
        expect(verifyAnnotationSave).not.toHaveBeenCalled();
        expect(loadPdfFromData).not.toHaveBeenCalled();
        expect(commitAnnotationSave).not.toHaveBeenCalled();
    });

    it('replaces only a native working copy from a staged mutation without reading bytes', async () => {
        const callOrder: string[] = [];
        const workingCopyPath = ref<TDocumentRef | null>(requireDocumentRef('/tmp/document.pdf'));
        const documentRevisionToken = ref(requireDocumentRevisionToken('revision-1'));
        const loadPdfFromData = vi.fn(async () => {
            throw new Error('native page mutation must not load PDF bytes');
        });
        const loadPdfFromPath = vi.fn(async () => {
            callOrder.push('persist');
            documentRevisionToken.value = requireDocumentRevisionToken('revision-2');
        });
        const assertAnnotationSaveCurrent = vi.fn(async () => {
            callOrder.push('assert');
        });
        const commitAnnotationSave = vi.fn(() => callOrder.push('commit-frontier'));
        const runSaveTransaction = vi.fn(async (request) => {
            expect(request).toMatchObject({
                mode: 'embedded-mutation',
                saveFlowMode: 'save',
                forcePdfjsMaterialize: false,
                workingPath: '/tmp/document.pdf',
            });
            return {
                source: 'native-mutation-projection' as const,
                baseBytes: null,
                serializedBytes: null,
                serializedResult: null,
                nativeMutationProjection: nativeProjection,
                fallbackDecision: TEST_PDF_SAVE_BYTE_ROUTE_DECISION,
                annotationSavePlan: TEST_PDF_SAVE_BYTE_ROUTE_DECISION.annotationPlan,
                verifyAnnotationSavePath: async () => {
                    callOrder.push('verify-path');
                },
                assertAnnotationSaveCurrent,
                commitAnnotationSave,
            };
        });
        const materialize = createPageMutationAnnotationMaterializer({
            annotationDirty: ref(true),
            hasAnnotationChanges: () => true,
            hasLivePdfJsAnnotationChanges: () => true,
            hasSavedPdfJsAnnotationBaselineChanges: () => false,
            pendingEmbeddedAnnotationDeleteCount: ref(0),
            preservedAnnotationSourceDirty: ref(false),
            workingCopyPath,
            documentRevisionToken,
            pdfViewerRef: ref({runSaveTransaction}),
            currentPage: ref(2),
            waitForPdfReload: async () => { callOrder.push('reload'); },
            loadPdfFromData,
            loadPdfFromPath,
            getNativeSaveTransactionOptions: () => ({
                nativeCapabilities: {
                    hasNativePdfMutationCapability: true,
                    canPersistNativeMetadataMutations: true,
                },
                dirtyState: {
                    annotationDirty: true,
                    hasAnnotationChanges: true,
                    hasLivePdfJsAnnotationChanges: true,
                    savedPdfjsAnnotationBaselineDirty: false,
                    shapeStateDirty: false,
                },
                documentStructure: {
                    pageLabelsDirty: false,
                    pageLabelRanges: [],
                    bookmarksDirty: false,
                    bookmarkItems: [],
                    untitledBookmarkLabel: 'Untitled',
                    totalPages: 5,
                },
            }),
        });

        await expect(materialize()).resolves.toBe(true);

        expect(callOrder).toEqual([
            'assert',
            'verify-path',
            'assert',
            'reload',
            'persist',
            'commit-frontier',
        ]);
        expect(nativeMocks.createManagedTempFileHandle).not.toHaveBeenCalled();
        expect(nativeMocks.applyPdfNativeMutationsToWorkingCopy).toHaveBeenCalledWith(
            '/tmp/document.pdf',
            nativeProjection.mutations,
            expect.any(String),
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-1')},
        );
        expect(nativeMocks.replaceWorkingCopyFromStagedPdfNativeMutation).toHaveBeenCalledWith(
            '/tmp/document.pdf',
            nativeStagedArtifact,
            {expectedDocumentRevisionToken: requireDocumentRevisionToken('revision-1')},
        );
        expect(nativeMocks.releaseManagedTempFileHandle).not.toHaveBeenCalledWith('base-lease');
        expect(loadPdfFromData).not.toHaveBeenCalled();
    });
});
