import { usePdfCropSelection } from '@app/composables/pdf/usePdfCropSelection';

export function usePdfCropTool(options: Parameters<typeof usePdfCropSelection>[0]) {
    return usePdfCropSelection(options);
}
