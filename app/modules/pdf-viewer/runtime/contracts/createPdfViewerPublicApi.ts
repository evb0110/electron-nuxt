import type { IPdfViewerExpose } from '@app/modules/workspace-shell/public';
import type { Ref } from 'vue';

type TPdfViewerPublicApiRefBackedKeys = 'isCapturingRegion' | 'isCropSelecting' | 'selectedShapeId';

export type TPdfViewerPublicApiSource = Omit<IPdfViewerExpose, TPdfViewerPublicApiRefBackedKeys> & {
    isCapturingRegion: boolean | Ref<boolean>;
    isCropSelecting: boolean | Ref<boolean>;
    selectedShapeId: string | null | Ref<string | null>;
};

export function createPdfViewerPublicApi(api: TPdfViewerPublicApiSource): TPdfViewerPublicApiSource {
    return api;
}
