import type { Ref } from 'vue';
import type {
    ICropMargins,
    IPageGeometry,
} from '@app/types/crop';
import type { TDocumentRef } from '@contracts/platform-api';
import { screenRectToMargins } from '@app/utils/pdf-crop-coordinates';
import { getElectronAPI } from '@app/utils/platform';
import type { IPdfViewerExpose } from '@app/modules/workspace-shell/composables/workspace-orchestration.types';

interface IUseWorkspaceCropOptions {
    pdfViewerRef: Ref<IPdfViewerExpose | null>;
    workingCopyPath: Ref<TDocumentRef | null>;
}

export function useWorkspaceCrop(options: IUseWorkspaceCropOptions) {
    const cropDialogOpen = ref(false);
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

        let geometry: IPageGeometry | null = null;
        const api = getElectronAPI();
        try {
            geometry = await api.documents.pageOps.getPageGeometry(
                options.workingCopyPath.value,
                result.pageNumber,
            );
        } catch {
            return;
        }

        if (!geometry) {
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
        cropDialogOpen.value = true;
    }

    return {
        cropDialogOpen,
        cropDialogMargins,
        cropDialogMediaBox,
        cropDialogCurrentBox,
        isCropSelecting,
        handleCrop,
    };
}
