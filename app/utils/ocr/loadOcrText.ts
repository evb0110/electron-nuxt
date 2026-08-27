import type { TDocumentRef } from '@contracts/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IDocumentTextCatalogPage,
    IDocumentTextCatalogWindow,
} from '@contracts/documentTextCatalog';
import { getOcrCapability } from '@app/utils/getOcrCapability';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';

/**
 * Reads the revision-keyed DocumentTextCatalog used by viewer and search.
 * Export deliberately has no search-index or legacy fallback: a stale or
 * malformed catalog is absence, never text for the current document.
 */
export async function loadOcrText(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: string,
) {
    const pages = await loadDocumentTextCatalogPages(workingCopyPath, documentRevisionToken);
    if (!pages) {
        return null;
    }
    const merged = pages.map(page => page.text.trim()).filter(Boolean).join('\n\n');
    return merged.length > 0 ? merged : null;
}

export async function loadDocumentTextCatalogPages(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: string,
    pageCount?: number,
): Promise<IDocumentTextCatalogPage[] | null> {
    try {
        const revision = parseDocumentRevisionToken(documentRevisionToken);
        if (revision === null) {
            return null;
        }
        const snapshot = pageCount === undefined
            ? await getOcrCapability().resolveDocumentTextCatalog(workingCopyPath, revision)
            : await getOcrCapability().resolveDocumentTextCatalog(workingCopyPath, revision, pageCount);
        return snapshot.pages;
    } catch (error) {
        BrowserLogger.warn('ocr', 'Failed to load DocumentTextCatalog for DOCX export', error);
        return null;
    }
}

const DOCUMENT_TEXT_CATALOG_PAGE_WINDOW = 64;

/**
 * Streams canonical text windows from the desktop main process. The caller
 * receives one page at a time while each IPC response stays bounded.
 */
export async function* iterateDocumentTextCatalogPages(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: string,
    pageCount: number,
): AsyncGenerator<IDocumentTextCatalogPage> {
    const revision = parseDocumentRevisionToken(documentRevisionToken);
    if (revision === null) {
        return;
    }
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        return;
    }
    const capability = getOcrCapability();
    for (
        let firstPage = 1;
        firstPage <= pageCount;
        firstPage += DOCUMENT_TEXT_CATALOG_PAGE_WINDOW
    ) {
        const lastPage = Math.min(pageCount, firstPage + DOCUMENT_TEXT_CATALOG_PAGE_WINDOW - 1);
        const window: IDocumentTextCatalogWindow = await capability.resolveDocumentTextCatalogWindow(
            workingCopyPath,
            revision,
            firstPage,
            lastPage,
            pageCount,
        );
        for (const page of window.pages) {
            yield page;
        }
    }
}

/**
 * Prepares a replayable text-page stream after checking for at least one
 * non-empty page. Only the current IPC window is retained while the stream
 * advances through the remaining windows.
 */
export async function prepareDocumentTextCatalogTextPages(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: string,
    pageCount: number,
): Promise<AsyncIterable<string> | null> {
    const revision = parseDocumentRevisionToken(documentRevisionToken);
    if (revision === null || !Number.isSafeInteger(pageCount) || pageCount < 1) {
        return null;
    }
    const capability = getOcrCapability();
    const loadWindow = (firstPage: number, lastPage: number) => capability.resolveDocumentTextCatalogWindow(
        workingCopyPath,
        revision,
        firstPage,
        lastPage,
        pageCount,
    );
    let bufferedWindow: IDocumentTextCatalogWindow | null = null;
    let bufferedFirstPage = 1;
    for (; bufferedFirstPage <= pageCount; bufferedFirstPage += DOCUMENT_TEXT_CATALOG_PAGE_WINDOW) {
        const lastPage = Math.min(pageCount, bufferedFirstPage + DOCUMENT_TEXT_CATALOG_PAGE_WINDOW - 1);
        const candidate = await loadWindow(bufferedFirstPage, lastPage);
        if (candidate.pages.some(page => page.text.trim().length > 0)) {
            bufferedWindow = candidate;
            break;
        }
    }
    if (!bufferedWindow) {
        return null;
    }
    const firstWindow = bufferedWindow;

    return (async function* () {
        const emitWindow = function* (window: IDocumentTextCatalogWindow) {
            for (const page of window.pages) {
                const text = page.text.trim();
                if (text) {
                    yield text;
                }
            }
        };
        yield* emitWindow(firstWindow);
        for (
            let firstPage = bufferedFirstPage + DOCUMENT_TEXT_CATALOG_PAGE_WINDOW;
            firstPage <= pageCount;
            firstPage += DOCUMENT_TEXT_CATALOG_PAGE_WINDOW
        ) {
            const lastPage = Math.min(pageCount, firstPage + DOCUMENT_TEXT_CATALOG_PAGE_WINDOW - 1);
            yield* emitWindow(await loadWindow(firstPage, lastPage));
        }
    })();
}
