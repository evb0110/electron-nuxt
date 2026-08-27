import type {PDFDocumentProxy} from '@app/types/pdfContracts';
import {BrowserLogger} from '@app/utils/browserLogger';
import {isNativeDocumentRef} from '@app/utils/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import {
    createPdfAnnotationIndexAdapter,
    type IPdfAnnotationIndexReader,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/createPdfAnnotationIndexAdapter';
import {
    evaluateAnnotationEnrichmentEligibility,
    type IAnnotationEnrichmentEligibility,
    type IAnnotationEnrichmentRequest,
    type TAnnotationEnrichmentSkipReason,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/annotationEnrichmentPolicy';
import type {TPdfAnnotationNameReadResult} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/pdfAnnotationSnapshotCache';

export interface IPdfAnnotationNameReadPreparation {
    nativeIndexReader: IPdfAnnotationIndexReader | null;
    annotationNamesByPage: Map<number, Map<string, string>> | null;
    annotationNameReadResult: TPdfAnnotationNameReadResult;
    annotationNameSkipReason: TAnnotationEnrichmentSkipReason | null;
}

function isNativePdfAnnotationSource(path: string | null | undefined) {
    return isNativeDocumentRef(path);
}

export function resolvePdfAnnotationInteractiveEligibility(
    sourcePath: string | null | undefined,
    pageCount: number,
    resolveRequest: () => IAnnotationEnrichmentRequest,
): IAnnotationEnrichmentEligibility {
    // Native annotation indexing is a pull-based structural read. Its
    // thresholds are scheduling budgets, not reasons to decline a read.
    if (isNativePdfAnnotationSource(sourcePath)) {
        return {
            allowed: true,
            reason: null,
        };
    }
    return evaluateAnnotationEnrichmentEligibility(resolveRequest());
}

export async function preparePdfAnnotationNameRead(options: {
    doc: PDFDocumentProxy;
    sourcePath: string | null;
    revision: TDocumentRevisionToken | null;
    resolveRequest: () => IAnnotationEnrichmentRequest;
}): Promise<IPdfAnnotationNameReadPreparation> {
    const {
        doc,
        resolveRequest,
        revision,
        sourcePath,
    } = options;
    const nativePdfSource = isNativePdfAnnotationSource(sourcePath);
    const nativeIndexAdapter = createPdfAnnotationIndexAdapter(sourcePath);
    if (nativeIndexAdapter) {
        try {
            return {
                nativeIndexReader: await nativeIndexAdapter.begin(revision),
                annotationNamesByPage: null,
                annotationNameReadResult: 'reconciled',
                annotationNameSkipReason: null,
            };
        } catch (error: unknown) {
            BrowserLogger.debug(
                'annotations',
                'Failed to begin native PDF annotation index',
                error,
            );
            return {
                nativeIndexReader: null,
                annotationNamesByPage: null,
                annotationNameReadResult: 'failed',
                annotationNameSkipReason: null,
            };
        }
    }

    if (nativePdfSource) {
        // A native path must never fall through to the renderer's whole
        // document `getData`/pdf-lib helper. If the host has not exposed the
        // index yet, report a source-access omission instead.
        return {
            nativeIndexReader: null,
            annotationNamesByPage: null,
            annotationNameReadResult: 'skipped',
            annotationNameSkipReason: 'unreadable-source',
        };
    }

    const {collectPdfAnnotationNamesByPage} = await import(
        '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/collectPdfAnnotationNamesByPage'
    );
    const eligibility = evaluateAnnotationEnrichmentEligibility(resolveRequest());
    const allowFullRead = eligibility.allowed;
    let annotationNameReadResult: TPdfAnnotationNameReadResult = allowFullRead
        ? 'reconciled'
        : 'skipped';
    const annotationNamesByPage = allowFullRead
        ? await collectPdfAnnotationNamesByPage(doc, {allowFullRead: true}).catch((error: unknown) => {
            BrowserLogger.debug(
                'annotations',
                'Failed to collect PDF annotation names',
                error,
            );
            annotationNameReadResult = 'failed';
            return null;
        })
        : null;

    return {
        nativeIndexReader: null,
        annotationNamesByPage,
        annotationNameReadResult,
        annotationNameSkipReason: eligibility.reason,
    };
}
