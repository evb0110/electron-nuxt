import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import {
    clamp,
    range,
} from 'es-toolkit/math';
import { getEditorsOnPage } from '@app/services/pdfjs/annotationEditorAdapter';

function getPreferredPageScanOrder(pageIndex: number, numPages: number) {
    const preferredPage = clamp(pageIndex, 0, Math.max(0, numPages - 1));
    return [
        preferredPage,
        ...range(numPages).filter(index => index !== preferredPage),
    ];
}

export function findEditorByAnnotationElementId(
    uiManager: AnnotationEditorUIManager | null,
    numPages: number,
    pageIndex: number,
    annotationId: string,
) {
    if (!uiManager || numPages <= 0) {
        return null;
    }

    for (const candidatePageIndex of getPreferredPageScanOrder(pageIndex, numPages)) {
        for (const normalizedEditor of getEditorsOnPage(uiManager, candidatePageIndex)) {
            if (normalizedEditor.annotationElementId === annotationId) {
                return normalizedEditor;
            }
        }
    }

    return null;
}
