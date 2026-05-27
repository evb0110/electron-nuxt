import {
    usePdfPageRenderer,
    type IPageRenderStallPayload,
} from '@app/composables/pdf/usePdfPageRenderer';

export type { IPageRenderStallPayload };

export function usePdfPageRenderingController(options: Parameters<typeof usePdfPageRenderer>[0]) {
    return usePdfPageRenderer(options);
}
