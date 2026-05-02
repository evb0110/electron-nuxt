import type { Ref } from 'vue';
import type {
    ICropMargins,
    IPageGeometry,
} from '@app/types/crop';
import type { TDocumentRef } from '@contracts/platform-api';
import { screenRectToMargins } from '@app/utils/pdf-crop-coordinates';
import { BrowserLogger } from '@app/utils/browser-logger';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspace-orchestration.types';
import { getPageOpsCapability } from '@app/utils/platform-documents';
import { getErrorMessage } from '@app/utils/error';

interface IUseWorkspaceCropOptions {
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
}

export const useWorkspaceCrop = (options: IUseWorkspaceCropOptions) => {
    const cropDialogOpen = ref(false);
    const cropDialogLoading = ref(false);
    const cropDialogMargins = ref<ICropMargins>({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
    });
    const cropDialogMediaBox = ref({
        x: 0,
        y: 0,
        width: 612,
        height: 792,
    });
    const cropDialogCurrentBox = ref<IPageGeometry['cropBox']>(null);
    const cropDialogPageNumber = ref(1);
    const cropDialogRotation = ref(0);
    let cropRequestToken = 0;

    const isCropSelecting = computed(() => options.pdfViewerRef.value?.isCropSelecting ?? false);

    async function handleCrop() {
        if (!options.pdfViewerRef.value || !options.workingCopyPath.value) {
            return;
        }

        if (isCropSelecting.value) {
            options.pdfViewerRef.value.cancelCropSelection();
            return;
        }

        const result = await options.pdfViewerRef.value.startCropSelection();
        if (!result) {
            return;
        }

        cropRequestToken += 1;
        const requestToken = cropRequestToken;
        cropDialogCurrentBox.value = null;
        cropDialogPageNumber.value = result.pageNumber;
        cropDialogRotation.value = 0;
        cropDialogOpen.value = false;
        cropDialogLoading.value = true;

        let geometry: IPageGeometry | null = null;
        try {
            geometry = await getPageOpsCapability().getPageGeometry(
                options.workingCopyPath.value,
                result.pageNumber,
            );
        } catch (error) {
            BrowserLogger.warn('crop', 'Failed to initialize crop dialog geometry', {
                pageNumber: result.pageNumber,
                path: options.workingCopyPath.value,
                error: getErrorMessage(error),
            });
            if (requestToken === cropRequestToken) {
                cropDialogLoading.value = false;
            }
            return;
        }

        if (!geometry || requestToken !== cropRequestToken) {
            if (requestToken === cropRequestToken) {
                cropDialogLoading.value = false;
            }
            return;
        }

        const effectiveBox = geometry.cropBox ?? geometry.mediaBox;
        const margins = screenRectToMargins(
            result.pageLocalRect,
            {
                left: 0,
                top: 0,
                width: result.pageRect.width,
                height: result.pageRect.height,
            },
            effectiveBox,
            geometry.mediaBox,
            geometry.rotation,
        );

        cropDialogMargins.value = margins;
        cropDialogMediaBox.value = geometry.mediaBox;
        cropDialogCurrentBox.value = geometry.cropBox;
        cropDialogRotation.value = geometry.rotation;
        await nextTick();
        if (requestToken !== cropRequestToken) {
            return;
        }
        cropDialogOpen.value = true;
        cropDialogLoading.value = false;
    }

    watch(cropDialogOpen, (isOpen) => {
        if (isOpen) {
            return;
        }

        cropRequestToken += 1;
        cropDialogLoading.value = false;
    });

    return {
        cropDialogOpen,
        cropDialogLoading,
        cropDialogMargins,
        cropDialogMediaBox,
        cropDialogCurrentBox,
        cropDialogPageNumber,
        cropDialogRotation,
        isCropSelecting,
        handleCrop,
    };
};
