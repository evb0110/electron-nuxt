import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { IBookmarkItem } from '@app/types/pdfOutline';
import type { IScrollToPageOptions } from '@app/modules/pdf-viewer/engine/pdf-outline-navigation/scrollToPageOptions';
import type { IBookmarkDestinationTarget } from '@app/utils/pdfOutlineHelpers';
import {
    resolveBookmarkDestinationTarget,
    resolveImmediateBookmarkDestinationTarget,
    shouldEmitResolvedBookmarkDestinationTarget,
} from '@app/utils/pdfOutlineHelpers';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';

interface INavigateToBookmarkDestinationOptions {
    item: IBookmarkItem;
    pdfDocument: PDFDocumentProxy | null;
    navigationRequestId: number;
    isBookmarkNavigationRequestCurrent: (requestId: number) => boolean;
    emitGoToPage: (page: number, options?: IScrollToPageOptions) => void;
}

function emitBookmarkDestinationTarget(
    target: IBookmarkDestinationTarget,
    emitGoToPage: INavigateToBookmarkDestinationOptions['emitGoToPage'],
) {
    const options = typeof target.pageYRatio === 'number'
        ? { pageYRatio: target.pageYRatio }
        : undefined;
    emitGoToPage(target.page, options);
}

function emitImmediateBookmarkDestinationTarget(options: INavigateToBookmarkDestinationOptions) {
    if (!options.isBookmarkNavigationRequestCurrent(options.navigationRequestId)) {
        return null;
    }

    const target = resolveImmediateBookmarkDestinationTarget(options.item);
    if (!target) {
        return null;
    }

    emitBookmarkDestinationTarget(target, options.emitGoToPage);
    return target;
}

function isKnownBookmarkDestinationIssue(error: unknown) {
    const message = getErrorMessage(error);
    return (
        message.includes('does not point to a /Page dictionary') ||
        message.includes('page must be a reference')
    );
}

/**
 * Starts with the cached page-index jump, then lets slower PDF.js destination
 * resolution refine the target. The request id prevents an older async
 * destination from stealing a later rapid bookmark click.
 */
export async function navigateToBookmarkDestination(options: INavigateToBookmarkDestinationOptions) {
    const immediateTarget = emitImmediateBookmarkDestinationTarget(options);
    const {
        item,
        pdfDocument,
        navigationRequestId,
        isBookmarkNavigationRequestCurrent,
        emitGoToPage,
    } = options;

    if (pdfDocument && item.dest) {
        try {
            const target = await resolveBookmarkDestinationTarget(pdfDocument, item.dest);
            if (
                target !== null
                && isBookmarkNavigationRequestCurrent(navigationRequestId)
            ) {
                if (shouldEmitResolvedBookmarkDestinationTarget(target, immediateTarget)) {
                    emitBookmarkDestinationTarget(target, emitGoToPage);
                }
                return;
            }
        } catch (error) {
            if (!isKnownBookmarkDestinationIssue(error)) {
                BrowserLogger.error('pdfOutline', 'Failed to navigate to bookmark destination', error);
            }
        }
    }

    if (
        immediateTarget === null
        && typeof item.pageIndex === 'number'
        && isBookmarkNavigationRequestCurrent(navigationRequestId)
    ) {
        emitGoToPage(item.pageIndex + 1, { pageYRatio: 0 });
    }
}
