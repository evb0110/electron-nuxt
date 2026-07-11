import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    nextTick,
    ref,
    shallowRef,
} from 'vue';
import { usePdfViewerLoadingState } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerLoadingState';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';

describe('usePdfViewerLoadingState', () => {
    let triggerObservedMutation: (() => void) | null = null;

    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.stubGlobal('MutationObserver', class {
            constructor(callback: () => void) {
                triggerObservedMutation = callback;
            }

            observe() {}
            disconnect() {}
        });
        vi.stubGlobal('document', { createElement: () => ({ querySelector: () => null }) });
    });

    it('hides the loading overlay after a failed load leaves no document to render', async () => {
        const scope = effectScope();
        try {
            const state = scope.run(() => {
                const src = computed(() =>
                    new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
                );
                const isLoading = ref(false);
                const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
                const viewerContainer = ref<HTMLElement | null>(document.createElement('div'));

                return usePdfViewerLoadingState({
                    src,
                    isLoading,
                    pdfDocument,
                    viewerContainer,
                });
            });

            expect(state).toBeTruthy();
            await nextTick();

            expect(state?.isViewerLoadingOverlayVisible.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('keeps the loading overlay visible until the loaded document paints its first canvas', async () => {
        const scope = effectScope();
        try {
            const state = scope.run(() => {
                const src = computed(() =>
                    new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
                );
                const isLoading = ref(false);
                const pdfDocument = shallowRef<PDFDocumentProxy | null>({} as PDFDocumentProxy);
                const viewerContainer = ref<HTMLElement | null>(document.createElement('div'));

                return usePdfViewerLoadingState({
                    src,
                    isLoading,
                    pdfDocument,
                    viewerContainer,
                });
            });

            expect(state).toBeTruthy();
            await nextTick();

            expect(state?.isViewerLoadingOverlayVisible.value).toBe(true);
        } finally {
            scope.stop();
        }
    });

    it('hides the loading overlay after the first rendered canvas appears', async () => {
        const scope = effectScope();
        try {
            let hasRenderedCanvas = false;
            const container = document.createElement('div');
            const querySelector = vi
                .spyOn(container, 'querySelector')
                .mockImplementation(() => (hasRenderedCanvas ? document.createElement('canvas') : null));

            const state = scope.run(() => {
                const src = computed(() =>
                    new Blob([new Uint8Array([1])], { type: 'application/pdf' }),
                );
                const isLoading = ref(false);
                const pdfDocument = shallowRef<PDFDocumentProxy | null>({} as PDFDocumentProxy);
                const viewerContainer = ref<HTMLElement | null>(container);

                return usePdfViewerLoadingState({
                    src,
                    isLoading,
                    pdfDocument,
                    viewerContainer,
                });
            });

            expect(state).toBeTruthy();
            await nextTick();
            expect(state?.isViewerLoadingOverlayVisible.value).toBe(true);

            hasRenderedCanvas = true;
            triggerObservedMutation?.();
            await nextTick();

            expect(querySelector).toHaveBeenCalledWith('.page_container--rendered .page_canvas canvas');
            expect(state?.isViewerLoadingOverlayVisible.value).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('restores the loading overlay for a direct source replacement until the new document paints', async () => {
        const scope = effectScope();
        try {
            let hasRenderedCanvas = true;
            const container = document.createElement('div');
            vi.spyOn(container, 'querySelector')
                .mockImplementation(() => (hasRenderedCanvas ? document.createElement('canvas') : null));
            const sourceA = new Blob([new Uint8Array([1])], {type: 'application/pdf'});
            const sourceB = new Blob([new Uint8Array([2])], {type: 'application/pdf'});
            const documentA = {} as PDFDocumentProxy;
            const documentB = {} as PDFDocumentProxy;
            const src = shallowRef(sourceA);
            const pdfDocument = shallowRef<PDFDocumentProxy | null>(documentA);

            const state = scope.run(() => usePdfViewerLoadingState({
                src: computed(() => src.value),
                isLoading: ref(false),
                pdfDocument,
                viewerContainer: ref<HTMLElement | null>(container),
            }));

            await nextTick();
            expect(state?.isViewerLoadingOverlayVisible.value).toBe(false);

            src.value = sourceB;
            await nextTick();
            expect(state?.isViewerLoadingOverlayVisible.value).toBe(true);

            hasRenderedCanvas = false;
            pdfDocument.value = documentB;
            await nextTick();
            expect(state?.isViewerLoadingOverlayVisible.value).toBe(true);

            hasRenderedCanvas = true;
            triggerObservedMutation?.();
            await nextTick();
            expect(state?.isViewerLoadingOverlayVisible.value).toBe(false);
        } finally {
            scope.stop();
        }
    });
});
