import { usePdfRegionSnip } from '@app/composables/pdf/usePdfRegionSnip';

export function usePdfRegionSnipTool(options: Parameters<typeof usePdfRegionSnip>[0]) {
    return usePdfRegionSnip(options);
}
