import type { IPdfViewerExpose } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerExpose.types';
import type { Ref } from 'vue';
import type { Merge } from 'type-fest';

type TPdfViewerPublicApiRefBackedKeys =
    | 'annotationHistoryMutationVersion'
    | 'annotationHistoryResetVersion'
    | 'hasShapes'
    | 'isCapturingRegion'
    | 'isCropSelecting'
    | 'selectedShapeId';

type TPdfViewerRefBackedSource = {
    [TKey in TPdfViewerPublicApiRefBackedKeys]-?: Readonly<Ref<Exclude<IPdfViewerExpose[TKey], undefined>>>;
};

export type TPdfViewerPublicApiSource = Merge<
    Omit<IPdfViewerExpose, TPdfViewerPublicApiRefBackedKeys>,
    TPdfViewerRefBackedSource
>;

export function createPdfViewerPublicApi(api: TPdfViewerPublicApiSource): TPdfViewerPublicApiSource {
    return api;
}
