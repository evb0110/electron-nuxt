import type {
    IPdfOptimizeOptions,
    IPdfOptimizeProgress,
} from '@contracts/electronApiDocuments';
import type { ComputedRef } from 'vue';

interface IUseDocumentWorkspaceOptimizeDialogOptions {
    canOptimizePdf: ComputedRef<boolean>;
    handleOptimizePdfAsCopy: (options: IPdfOptimizeOptions, requestId: string) => Promise<boolean>;
    onOptimizeSuccess: () => void;
}

export const useDocumentWorkspaceOptimizeDialog = ({
    canOptimizePdf,
    handleOptimizePdfAsCopy,
    onOptimizeSuccess,
}: IUseDocumentWorkspaceOptimizeDialogOptions) => {
    const optimizeDialogOpen = ref(false);
    const optimizeProgress = ref<IPdfOptimizeProgress | null>(null);
    const optimizeDialogError = ref<string | null>(null);
    const optimizeRequestId = ref<string | null>(null);
    const isOptimizeDialogRunning = computed(() => optimizeRequestId.value !== null);

    function createOptimizeRequestId() {
        const randomId = globalThis.crypto?.randomUUID?.();
        return randomId
            ? `pdf-optimize-${randomId}`
            : `pdf-optimize-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
