import type { ComputedRef } from 'vue';
import type { TPdfSource } from '@app/types/pdfUi';

interface IUsePdfViewerSourceChangeLifecycleOptions {
    src: ComputedRef<TPdfSource | null>;
    documentKey: ComputedRef<string | null>;
    isAnySaving: ComputedRef<boolean>;
    clearAnnotationHistory: () => void;
    clearPendingImagePlacement: () => void;
    handleAnnotationSourceChanged: (
        next: TPdfSource | null,
        previous: TPdfSource | null,
    ) => void;
}

export const usePdfViewerSourceChangeLifecycle = (options: IUsePdfViewerSourceChangeLifecycleOptions) => {
    watch(() => [
        options.src.value,
        options.documentKey.value,
    ] as const, ([
        next,
        nextDocumentKey,
    ], [
        previous,
        previousDocumentKey,
    ]) => {
        if (next === previous) {
            return;
        }
        // Byte operations replace the source object while retaining the same
        // logical working copy. Keep the app command stack in that case so
        // commands beneath the checkpoint remain available after reload.
        if (!options.isAnySaving.value && nextDocumentKey !== previousDocumentKey) {
            options.clearAnnotationHistory();
        }
        options.clearPendingImagePlacement();
        options.handleAnnotationSourceChanged(next, previous);
    });
};
