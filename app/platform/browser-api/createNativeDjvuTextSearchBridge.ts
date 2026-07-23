import type { IDjvuCapability } from '@contracts/djvuPlatformFeature';
import type { TDocumentRef } from '@contracts/documentRef';
import { isBrowserDocumentRef } from '@app/platform/browserDocumentStore';
import { getValidatedElectronPlatformApi } from '@app/utils/electronPlatformBridge';
import type { IPagePreviewSource } from '@app/utils/document-viewer/pagePreviewSource';

type TNativeDjvuSearchCapability = Pick<
    IDjvuCapability,
    'cancelTextSearch' | 'onTextSearchProgress' | 'searchText'
>;
type TDocumentSearchRequest = Parameters<NonNullable<IPagePreviewSource['searchText']>>[0];

function getNativeDjvuSearchCapability(documentRef: TDocumentRef) {
    if (isBrowserDocumentRef(documentRef)) {
        return null;
    }
    const djvu = getValidatedElectronPlatformApi()?.djvu;
    if (
        typeof djvu?.searchText !== 'function'
        || typeof djvu.cancelTextSearch !== 'function'
        || typeof djvu.onTextSearchProgress !== 'function'
    ) {
        return null;
    }
    return djvu satisfies TNativeDjvuSearchCapability;
}

/**
 * Text search is a document capability, independent from the selected raster
 * renderer. Desktop DjVu keeps native streaming search even when a small file
 * is rendered by DjVu.js.
 */
export function createNativeDjvuTextSearchBridge(documentRef: TDocumentRef) {
    const nativeDjvu = getNativeDjvuSearchCapability(documentRef);
    if (!nativeDjvu) {
        return null;
    }
    const searchCapability: TNativeDjvuSearchCapability = nativeDjvu;
    const activeRequestIds = new Set<string>();

    async function searchText(request: TDocumentSearchRequest) {
        request.signal.throwIfAborted();
        activeRequestIds.add(request.requestId);
        const unsubscribe = searchCapability.onTextSearchProgress((progress) => {
            if (progress.requestId === request.requestId) {
                request.onProgress?.(progress);
            }
        });
        const cancel = () => {
            void searchCapability.cancelTextSearch(request.requestId).catch(() => undefined);
        };
        request.signal.addEventListener('abort', cancel, {once: true});
        try {
            const response = await searchCapability.searchText(documentRef, request.query, {
                requestId: request.requestId,
                pageCount: request.pageCount,
                ...request.matchOptions,
            });
            request.signal.throwIfAborted();
            return response;
        } finally {
            activeRequestIds.delete(request.requestId);
            request.signal.removeEventListener('abort', cancel);
            unsubscribe();
        }
    }

    function dispose() {
        for (const requestId of activeRequestIds) {
            void searchCapability.cancelTextSearch(requestId).catch(() => undefined);
        }
        activeRequestIds.clear();
    }

    return {
        dispose,
        searchText,
    };
}
