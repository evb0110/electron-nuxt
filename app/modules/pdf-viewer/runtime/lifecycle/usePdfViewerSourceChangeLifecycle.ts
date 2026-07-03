import type { ComputedRef } from 'vue';
import type { TPdfSource } from '@app/types/pdfUi';

interface IUsePdfViewerSourceChangeLifecycleOptions {
    src: ComputedRef<TPdfSource | null>;
    isAnySaving: ComputedRef<boolean>;
    clearAnnotationHistory: () => void;
    clearPendingImagePlacement: () => void;
    handleAnnotationSourceChanged: (
        next: TPdfSource | null,
        previous: TPdfSource | null,
    ) => void;
}

export const usePdfViewerSourceChangeLifecycle = (options: IUsePdfViewerSourceChangeLifecycleOptions) => {
    watch(() => options.src.value, (next, previous) => {
        if (next === previous) {
            return;
        }
        if (!options.isAnySaving.value) {
            options.clearAnnotationHistory();
        }
        options.clearPendingImagePlacement();
        options.handleAnnotationSourceChanged(next, previous);
    });
};
