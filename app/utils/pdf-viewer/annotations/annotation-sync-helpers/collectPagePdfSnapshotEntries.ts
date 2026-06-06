import type {
    IAnnotationCommentSummary,
    ILinkAnnotation,
} from '@app/types/annotations';
import {
    isLinkSubtype,
    isPopupSubtype,
} from '@app/services/pdf/annotationSubtype';
import { isImportedEmbeddedShapeSubtype } from '@app/utils/pdf-viewer/pdf-embedded-shape-annotations/isImportedEmbeddedShapeSubtype';
import type {
    IPdfCommentSummaryDeps,
    IPdfPageAnnotationBundle,
} from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';
import { buildPdfAnnotationCommentSummary } from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/buildPdfAnnotationCommentSummary';
import { buildPopupIndex } from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/buildPopupIndex';
import { tryExtractPdfLinkAnnotation } from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/tryExtractPdfLinkAnnotation';

export function collectPagePdfSnapshotEntries(
    pageBundle: IPdfPageAnnotationBundle,
    pageNumber: number,
    summaryDeps: IPdfCommentSummaryDeps,
    comments: IAnnotationCommentSummary[],
    links: ILinkAnnotation[],
) {
    const {
        annotations,
        pageView,
        pageRotation,
        textItems,
        textViewport,
    } = pageBundle;
    const popupById = buildPopupIndex(annotations);

    annotations.forEach((annotation, annotationIndex) => {
        if (isPopupSubtype(annotation.subtype)) {
            return;
        }

        if (isLinkSubtype(annotation.subtype)) {
            const link = tryExtractPdfLinkAnnotation(
                annotation,
                pageNumber,
                annotationIndex,
                pageView,
                pageRotation,
            );
            if (link) {
                links.push(link);
            }
            return;
        }

        if (isImportedEmbeddedShapeSubtype(annotation.subtype)) {
            return;
        }

        const popupAnnotation = annotation.popupRef
            ? (popupById.get(annotation.popupRef) ?? null)
            : null;

        comments.push(buildPdfAnnotationCommentSummary(
            annotation,
            popupAnnotation,
            pageNumber,
            annotationIndex,
            pageView,
            pageRotation,
            summaryDeps,
            textItems,
            textViewport,
        ));
    });
}
