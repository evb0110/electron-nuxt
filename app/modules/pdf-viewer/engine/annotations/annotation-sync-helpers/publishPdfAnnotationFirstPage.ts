import type {
    IAnnotationCommentSummary,
    IAnnotationInventoryCompleteness,
} from '@app/types/annotations';
import type {IPdfAnnotationFirstPageResult} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/scanPdfAnnotationPages';

interface IPdfAnnotationPartialIdentity {
    dedupeAnnotationCommentSummaries: (
        comments: IAnnotationCommentSummary[],
    ) => IAnnotationCommentSummary[];
    rememberSummaryText: (comment: IAnnotationCommentSummary) => void;
}

interface IPdfAnnotationPartialStore {
    setAnnotations: (
        comments: IAnnotationCommentSummary[],
        options?: {
            adoptAsSavedBaseline?: boolean;
            reconcileMissingTransient?: boolean;
        },
    ) => IAnnotationCommentSummary[] | undefined;
    setInventoryCompleteness: (completeness: IAnnotationInventoryCompleteness | null) => void;
}

/**
 * Publish the first native page as soon as it is read. The final scan still
 * owns the authoritative links and completeness record, so this path only
 * adds the visible page's comments and marks the inventory as in progress.
 */
export function publishPdfAnnotationFirstPage(options: {
    page: IPdfAnnotationFirstPageResult;
    totalPageCount: number;
    identity: IPdfAnnotationPartialIdentity;
    store: IPdfAnnotationPartialStore;
    mergeComments: (comments: readonly IAnnotationCommentSummary[]) => void;
    getComments: () => IAnnotationCommentSummary[];
    rememberMarkupSubtypeColors: (comments: IAnnotationCommentSummary[]) => void;
    notify: () => void;
    syncInlineCommentIndicators: () => void;
}) {
    const {
        identity,
        mergeComments,
        notify,
        page,
        rememberMarkupSubtypeColors,
        store,
        syncInlineCommentIndicators,
        totalPageCount,
    } = options;
    mergeComments(page.comments);
    const comments = identity.dedupeAnnotationCommentSummaries(
        options.getComments(),
    );
    const appliedComments = store.setAnnotations(comments, {
        adoptAsSavedBaseline: false,
        reconcileMissingTransient: false,
    }) ?? comments;
    appliedComments.forEach(comment => identity.rememberSummaryText(comment));
    rememberMarkupSubtypeColors(appliedComments);
    store.setInventoryCompleteness({
        complete: false,
        omissions: page.failed ? ['page-parse-failure'] : [],
        scannedPageCount: page.failed ? 0 : 1,
        totalPageCount,
        failedPageCount: page.failed ? 1 : 0,
    });
    notify();
    syncInlineCommentIndicators();
}
