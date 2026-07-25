import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import {createPageMutationAnnotationMaterializer} from '@app/modules/workspace-shell/composables/createPageMutationAnnotationMaterializer';
import {TEST_PDF_SAVE_BYTE_ROUTE_DECISION} from '@tests/unit/app/modules/pdf-viewer/runtime/save/testPdfSaveByteRouteDecision';
import {requireDocumentRevisionToken} from '@contracts';

describe('createPageMutationAnnotationMaterializer', () => {
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
        const workingCopyPath = ref('/tmp/document.pdf');
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
        const workingCopyPath = ref('/tmp/document.pdf');
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
});
