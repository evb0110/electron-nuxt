import type { TPageIndex } from '@contracts/pageNumbers';

import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import {
    getEditorById,
    getEditorsOnPage,
} from '@app/services/pdfjs/annotationEditorAdapter';
import { getAnnotationEditorPageSearchOrder } from '@app/modules/pdf-viewer/engine/annotation-comment-crud-helpers/getAnnotationEditorPageSearchOrder';

interface IFindEditorByAnnotationElementIdOptions {
    annotationPageIndexes?: Iterable<TPageIndex> | null;
    mountedPageIndexes?: Iterable<TPageIndex> | null;
}

export function findEditorByAnnotationElementId(
    uiManager: AnnotationEditorUIManager | null,
    numPages: number,
    pageIndex: TPageIndex,
    annotationId: string,
    options: IFindEditorByAnnotationElementIdOptions = {},
) {
    if (!uiManager || numPages <= 0) {
        return null;
    }

    const byGlobalId = getEditorById(uiManager, annotationId);
    if (byGlobalId?.annotationElementId === annotationId) {
        return byGlobalId;
    }

    for (const candidatePageIndex of getAnnotationEditorPageSearchOrder({
        annotationPageIndexes: options.annotationPageIndexes,
        mountedPageIndexes: options.mountedPageIndexes,
        numPages,
        preferredPageIndex: pageIndex,
    })) {
        for (const normalizedEditor of getEditorsOnPage(uiManager, candidatePageIndex)) {
            if (normalizedEditor.annotationElementId === annotationId) {
                return normalizedEditor;
            }
        }
    }

    return null;
}
