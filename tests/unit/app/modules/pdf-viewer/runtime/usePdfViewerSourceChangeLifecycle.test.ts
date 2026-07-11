import {
    computed,
    effectScope,
    nextTick,
    ref,
} from 'vue';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TPdfSource } from '@app/types/pdfUi';
import { usePdfViewerSourceChangeLifecycle } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfViewerSourceChangeLifecycle';

function createSource(content: string): TPdfSource {
    return new Blob([content], { type: 'application/pdf' });
}

describe('usePdfViewerSourceChangeLifecycle', () => {
    it('keeps saving source changes from clearing history while still forwarding source cleanup', async () => {
        const src = ref<TPdfSource | null>(createSource('first'));
        const documentKey = ref<string | null>('working-copy-a');
        const isAnySaving = ref(false);
        const clearAnnotationHistory = vi.fn();
        const clearPendingImagePlacement = vi.fn();
        const handleAnnotationSourceChanged = vi.fn();
        const scope = effectScope();

        try {
            scope.run(() => usePdfViewerSourceChangeLifecycle({
                src: computed(() => src.value),
                documentKey: computed(() => documentKey.value),
                isAnySaving: computed(() => isAnySaving.value),
                clearAnnotationHistory,
                clearPendingImagePlacement,
                handleAnnotationSourceChanged,
            }));

            const secondSource = createSource('second');
            src.value = secondSource;
            await nextTick();

            expect(clearAnnotationHistory).not.toHaveBeenCalled();
            expect(clearPendingImagePlacement).toHaveBeenCalledOnce();
            expect(handleAnnotationSourceChanged).toHaveBeenCalledWith(
                secondSource,
                expect.any(Blob),
            );

            clearAnnotationHistory.mockClear();
            const thirdSource = createSource('third');
            documentKey.value = 'working-copy-b';
            isAnySaving.value = true;
            src.value = thirdSource;
            await nextTick();

            expect(clearAnnotationHistory).not.toHaveBeenCalled();
            expect(clearPendingImagePlacement).toHaveBeenCalledTimes(2);
            expect(handleAnnotationSourceChanged).toHaveBeenLastCalledWith(
                thirdSource,
                secondSource,
            );
        } finally {
            scope.stop();
        }
    });

    it('clears annotation commands only when the logical document changes', async () => {
        const src = ref<TPdfSource | null>(createSource('first'));
        const documentKey = ref<string | null>('working-copy-a');
        const clearAnnotationHistory = vi.fn();
        const scope = effectScope();

        try {
            scope.run(() => usePdfViewerSourceChangeLifecycle({
                src: computed(() => src.value),
                documentKey: computed(() => documentKey.value),
                isAnySaving: computed(() => false),
                clearAnnotationHistory,
                clearPendingImagePlacement: vi.fn(),
                handleAnnotationSourceChanged: vi.fn(),
            }));

            documentKey.value = 'working-copy-b';
            src.value = createSource('second-document');
            await nextTick();

            expect(clearAnnotationHistory).toHaveBeenCalledOnce();
        } finally {
            scope.stop();
        }
    });
});
