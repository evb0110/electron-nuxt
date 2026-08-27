import type {
    IAnnotationCommentSummary,
    ILinkAnnotation,
    TAnnotationInventoryOmission,
} from '@app/types/annotations';
import {collectPagePdfSnapshotEntries} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPagePdfSnapshotEntries';
import {
    MAX_BACKGROUND_PDF_ANNOTATION_PAGES,
    MAX_BACKGROUND_PDF_ANNOTATION_RECORDS,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationInventoryCompleteness';
import type {IPdfAnnotationIndexReader} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/createPdfAnnotationIndexAdapter';
import type {
    IPdfCommentSummaryDeps,
    IPdfPageAnnotationBundle,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

export interface IPdfAnnotationPageScanResult {
    omissions: Set<TAnnotationInventoryOmission>;
    visitedPageCount: number;
    failedPageCount: number;
}

export interface IPdfAnnotationFirstPageResult {
    pageNumber: number;
    comments: readonly IAnnotationCommentSummary[];
    links: readonly ILinkAnnotation[];
    failed: boolean;
}

export interface IPdfAnnotationPageScanOptions {
    pageOrder: Iterable<number>;
    nativeIndexReader: IPdfAnnotationIndexReader | null;
    annotationNamesByPage: ReadonlyMap<number, ReadonlyMap<string, string>> | null;
    comments: IAnnotationCommentSummary[];
    links: ILinkAnnotation[];
    summaryDeps: IPdfCommentSummaryDeps;
    loadPage: (
        pageNumber: number,
        annotationNamesById: ReadonlyMap<string, string> | null,
    ) => Promise<IPdfPageAnnotationBundle | null>;
    waitForIdle: () => Promise<void>;
    isCanceled: () => boolean;
    onNativeIndexReadFailure: (error: unknown) => void;
    onFirstPageCollected?: ((result: IPdfAnnotationFirstPageResult) => void) | undefined;
}

export async function scanPdfAnnotationPages(
    options: IPdfAnnotationPageScanOptions,
): Promise<IPdfAnnotationPageScanResult | null> {
    const {
        annotationNamesByPage,
        comments,
        isCanceled,
        links,
        loadPage,
        nativeIndexReader,
        onNativeIndexReadFailure,
        pageOrder,
        summaryDeps,
        waitForIdle,
    } = options;
    const omissions = new Set<TAnnotationInventoryOmission>();
    let visitedPageCount = 0;
    let failedPageCount = 0;
    let pagesSinceYield = 0;
    let recordsSinceYield = 0;
    let orderIndex = 0;
    let nativeIndexAvailable = nativeIndexReader !== null;

    for (const pageNumber of pageOrder) {
        if (isCanceled()) {
            return null;
        }
        orderIndex += 1;

        let pageAnnotationNames = annotationNamesByPage?.get(pageNumber - 1) ?? null;
        let skipPageLoad = false;
        if (nativeIndexReader && nativeIndexAvailable) {
            try {
                // New readers can prove that a page is empty while retaining
                // the name map needed by pages that do contain entries. Keep
                // the old name-only call as a runtime compatibility path for
                // readers created by older tests or bridges.
                if (typeof nativeIndexReader.readPage === 'function') {
                    const pageRead = await nativeIndexReader.readPage(pageNumber - 1);
                    pageAnnotationNames = pageRead.names;
                    skipPageLoad = !pageRead.hasAnnotations;
                } else {
                    pageAnnotationNames = await nativeIndexReader.readPageNames(pageNumber - 1);
                }
            } catch (error: unknown) {
                onNativeIndexReadFailure(error);
                nativeIndexAvailable = false;
            }
            if (isCanceled()) {
                return null;
            }
        }

        // Native presence data makes empty pages metadata-only work. Waiting
        // for an idle callback before every such page turns a sparse scan into
        // thousands of scheduler round trips. Yield before real PDF.js page
        // loads and at the existing aggregate budget below instead.
        if (!skipPageLoad && orderIndex > 1) {
            await waitForIdle();
            if (isCanceled()) {
                return null;
            }
        }

        const recordsBeforePage = comments.length + links.length;
        const commentsBeforePage = comments.length;
        const linksBeforePage = links.length;
        const pageBundle = skipPageLoad
            ? null
            : await loadPage(pageNumber, pageAnnotationNames);
        visitedPageCount += 1;
        pagesSinceYield += 1;
        if (skipPageLoad) {
            // A native empty-page proof is a successful visit. It must not be
            // reported as a page parse failure or trigger an incomplete scan.
        } else if (!pageBundle) {
            failedPageCount += 1;
            omissions.add('page-parse-failure');
        } else {
            collectPagePdfSnapshotEntries(
                pageBundle,
                pageNumber,
                summaryDeps,
                comments,
                links,
            );
        }
        if (visitedPageCount === 1) {
            options.onFirstPageCollected?.({
                pageNumber,
                comments: comments.slice(commentsBeforePage),
                links: links.slice(linksBeforePage),
                failed: !skipPageLoad && pageBundle === null,
            });
        }
        recordsSinceYield += comments.length + links.length - recordsBeforePage;
        // These are scheduling budgets, not admission caps. Once a budget is
        // spent, yield before the next page while keeping every record.
        if (
            pagesSinceYield >= MAX_BACKGROUND_PDF_ANNOTATION_PAGES
            || recordsSinceYield >= MAX_BACKGROUND_PDF_ANNOTATION_RECORDS
        ) {
            pagesSinceYield = 0;
            recordsSinceYield = 0;
            await waitForIdle();
            if (isCanceled()) {
                return null;
            }
        }
    }

    return {
        omissions,
        visitedPageCount,
        failedPageCount,
    };
}
