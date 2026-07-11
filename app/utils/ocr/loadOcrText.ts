import type { TDocumentRef } from '@contracts/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import type { IDocumentTextCatalogPage } from '@contracts/documentTextCatalog';
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
