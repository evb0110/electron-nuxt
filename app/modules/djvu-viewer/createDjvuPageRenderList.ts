import {
    createAnchorFirstPageOrder,
    normalizeDocumentViewerPageRange,
    type TDocumentViewerPageDirection,
} from '@app/utils/document-viewer/virtualization/pageVirtualization';

export type TDjvuScrollDirection = TDocumentViewerPageDirection;

export interface ICreateDjvuPageRenderListOptions {
    anchorPage: number;
    direction?: TDjvuScrollDirection;
    endPage: number;
    prefetchPages: number;
    startPage: number;
    totalPages: number;
}

export function createDjvuPageRenderList(options: ICreateDjvuPageRenderListOptions) {
    const range = normalizeDocumentViewerPageRange({
        startPage: options.startPage,
        endPage: options.endPage,
        totalPages: options.totalPages,
        paddingPages: options.prefetchPages,
    });

    return createAnchorFirstPageOrder({
        range,
        anchorPage: options.anchorPage,
        ...(options.direction === undefined ? {} : { direction: options.direction }),
    });
}
