import type {
    IPdfOptimizeOptions,
    IPdfOptimizeProgress,
} from '@contracts/electronApiDocuments';
import { createRequestId } from '@contracts/shared';
import type { TRequestId } from '@contracts/shared';
import type { ComputedRef } from 'vue';
import type { FailurePresentation } from '@app/composables/useFailureToast';

interface IUseDocumentWorkspaceOptimizeDialogOptions {
    canOptimizePdf: ComputedRef<boolean>;
    handleOptimizePdfAsCopy: (options: IPdfOptimizeOptions, requestId: TRequestId) => Promise<boolean>;
    getLastFailurePresentation?: () => FailurePresentation | null;
    onOptimizeSuccess: () => void;
}

export const useDocumentWorkspaceOptimizeDialog = ({
    canOptimizePdf,
    getLastFailurePresentation,
    handleOptimizePdfAsCopy,
    onOptimizeSuccess,
}: IUseDocumentWorkspaceOptimizeDialogOptions) => {
    const optimizeDialogOpen = ref(false);
    const optimizeProgress = ref<IPdfOptimizeProgress | null>(null);
    const optimizeDialogError = ref<FailurePresentation | null>(null);
    const optimizeRequestId = ref<TRequestId | null>(null);
    const isOptimizeDialogRunning = computed(() => optimizeRequestId.value !== null);

    function createOptimizeRequestId() {
        return createRequestId('pdf-optimize');
    }

    function openOptimizePdfForInteractionDialog() {
        if (!canOptimizePdf.value) {
            return false;
        }

        optimizeDialogError.value = null;
        optimizeProgress.value = null;
        optimizeDialogOpen.value = true;
        return true;
    }

    function handleOptimizeDialogOpenChange(value: boolean) {
        if (!value && isOptimizeDialogRunning.value) {
            return;
        }

        optimizeDialogOpen.value = value;
        if (value) {
            optimizeDialogError.value = null;
            optimizeProgress.value = null;
        }
    }

    async function handleOptimizeDialogSubmit(options: IPdfOptimizeOptions) {
        if (isOptimizeDialogRunning.value) {
            return;
        }

        const requestId = createOptimizeRequestId();
        optimizeRequestId.value = requestId;
        optimizeDialogError.value = null;
        optimizeProgress.value = {
            requestId,
            preset: options.preset,
            phase: 'preparing',
            processed: 0,
            total: 1,
            percent: 0,
        };

        const success = await handleOptimizePdfAsCopy(options, requestId);
        if (success) {
            optimizeDialogOpen.value = false;
            onOptimizeSuccess();
        } else {
            optimizeDialogError.value = getLastFailurePresentation?.() ?? null;
            optimizeProgress.value = null;
        }

        optimizeRequestId.value = null;
    }

    function handleOptimizeProgress(progress: IPdfOptimizeProgress) {
        if (progress.requestId === optimizeRequestId.value) {
            optimizeProgress.value = progress;
        }
    }

    return {
        handleOptimizeDialogOpenChange,
        handleOptimizeDialogSubmit,
        handleOptimizeProgress,
        isOptimizeDialogRunning,
        openOptimizePdfForInteractionDialog,
        optimizeDialogError,
        optimizeDialogOpen,
        optimizeProgress,
    };
};
