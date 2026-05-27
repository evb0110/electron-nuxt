import { usePdfImagePlacement } from '@app/composables/pdf/usePdfImagePlacement';

export function usePdfImagePlacementTool(options: Parameters<typeof usePdfImagePlacement>[0]) {
    return usePdfImagePlacement(options);
}
