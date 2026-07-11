import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {ref} from 'vue';
import {createPageMutationAnnotationMaterializer} from '@app/modules/workspace-shell/composables/createPageMutationAnnotationMaterializer';

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
        const materialize = createPageMutationAnnotationMaterializer({
            annotationDirty: ref(true),
            hasAnnotationChanges: () => true,
            hasLivePdfJsAnnotationChanges: () => true,
            hasSavedPdfJsAnnotationBaselineChanges: () => false,
            pendingEmbeddedAnnotationDeleteCount: ref(0),
            preservedAnnotationSourceDirty: ref(false),
            workingCopyPath,
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
});
