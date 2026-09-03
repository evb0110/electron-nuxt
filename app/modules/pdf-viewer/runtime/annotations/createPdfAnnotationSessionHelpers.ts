import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {IAnnotationCommentSummary} from '@app/types/annotations';
import type {AnnotationApplication} from '@app/modules/pdf-viewer/annotations/annotationApplication';
import { reportAnnotationCreationFailure } from '@app/modules/pdf-viewer/annotations/bridge/pdfjs-runtime/reportAnnotationCreationFailure';
import type {
    IAnnotationCreationFailureReport,
    TAnnotationCreationOutcome,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationCreationOutcome.types';

export function findCanonicalAnnotationComment(
    application: AnnotationApplication,
    annotationId: string,
) {
    const comment = application.listCommentSummaries().find(candidate => (
        candidate.appAnnotationId === annotationId
    ));
    if (!comment) {
        throw new Error(`Canonical annotation ${annotationId} has no comment projection`);
    }
    return comment;
}

export function emitCanonicalAnnotationOpenNote(options: {
    annotationApplication: ShallowRef<AnnotationApplication>;
    annotationProjection: Ref<IAnnotationCommentSummary[]>;
    comment: IAnnotationCommentSummary;
    emitAnnotationOpenNote: (comment: IAnnotationCommentSummary) => void;
}) {
    const canonicalAnnotationId = options.annotationApplication.value.annotationIdForSummary(options.comment);
    const canonicalNoteComment = canonicalAnnotationId
        ? options.annotationProjection.value.find(candidate => candidate.appAnnotationId === canonicalAnnotationId)
        : null;
    options.emitAnnotationOpenNote(canonicalNoteComment ?? options.comment);
}

export function createAnnotationCreationFailureReporter(
    reportAnnotationFailure: ((failure: IAnnotationCreationFailureReport) => void) | undefined,
) {
    let annotationCreationAttempts = 0;
    return (
        reason: 'viewer-not-ready' | 'page-not-rendered',
        pageNumber: number,
    ): TAnnotationCreationOutcome => {
        annotationCreationAttempts += 1;
        reportAnnotationCreationFailure(reportAnnotationFailure, {
            operationId: `annotation-create-${annotationCreationAttempts}`,
            reason,
            pageNumber,
        });
        return {
            status: 'failed',
            reason,
        };
    };
}

export function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
    if (left.size !== right.size) {
        return false;
    }
    for (const value of left) {
        if (!right.has(value)) {
            return false;
        }
    }
    return true;
}
