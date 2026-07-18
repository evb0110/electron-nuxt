import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {
    IDocumentOcrAvailability,
    IDocumentTextCatalogPage,
} from '@contracts/documentTextCatalog';
import { getOcrCapability } from '@app/utils/getOcrCapability';
import { BrowserLogger } from '@app/utils/browserLogger';

const MAX_AVAILABILITY_SNAPSHOTS = 8;
const MAX_PAGE_SNAPSHOTS = 64;
const availabilitySnapshots = new Map<string, Promise<IDocumentOcrAvailability | null>>();
const pageSnapshots = new Map<string, Promise<IDocumentTextCatalogPage | null>>();

function cacheKey(workingCopyPath: TDocumentRef, documentRevisionToken: TDocumentRevisionToken) {
    return `${workingCopyPath}\0${documentRevisionToken}`;
}

function touchEntry<T>(cache: Map<string, T>, key: string, value: T) {
    cache.delete(key);
    cache.set(key, value);
}

function trimCache<T>(cache: Map<string, T>, maximumSize: number) {
    while (cache.size > maximumSize) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }
        cache.delete(oldestKey);
    }
}

export function loadSharedDocumentOcrAvailability(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: TDocumentRevisionToken,
) {
    const key = cacheKey(workingCopyPath, documentRevisionToken);
    const cached = availabilitySnapshots.get(key);
    if (cached) {
        touchEntry(availabilitySnapshots, key, cached);
        return cached;
    }

    const capability = getOcrCapability();
    if (typeof capability.resolveDocumentOcrAvailability !== 'function') {
        return Promise.resolve(null);
    }
    const pending = capability.resolveDocumentOcrAvailability(
        workingCopyPath,
        documentRevisionToken,
    ).catch((error) => {
        BrowserLogger.warn('ocr', 'Failed to resolve OCR availability for PDF viewer', error);
        return null;
    });
    availabilitySnapshots.set(key, pending);
    trimCache(availabilitySnapshots, MAX_AVAILABILITY_SNAPSHOTS);
    return pending;
}

export function loadSharedDocumentOcrPage(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: TDocumentRevisionToken,
    pageNumber: number,
) {
    const key = `${cacheKey(workingCopyPath, documentRevisionToken)}\0${pageNumber}`;
    const cached = pageSnapshots.get(key);
    if (cached) {
        touchEntry(pageSnapshots, key, cached);
        return cached;
    }

    const capability = getOcrCapability();
    if (typeof capability.resolveDocumentOcrPage !== 'function') {
        return Promise.resolve(null);
    }
    const pending = capability.resolveDocumentOcrPage(
        workingCopyPath,
        documentRevisionToken,
        pageNumber,
    ).then(snapshot => snapshot.page).catch((error) => {
        BrowserLogger.warn('ocr', `Failed to resolve OCR page ${pageNumber} for PDF viewer`, error);
        return null;
    });
    pageSnapshots.set(key, pending);
    trimCache(pageSnapshots, MAX_PAGE_SNAPSHOTS);
    return pending;
}

export function clearSharedDocumentTextCatalog(workingCopyPath?: TDocumentRef) {
    if (workingCopyPath === undefined) {
        availabilitySnapshots.clear();
        pageSnapshots.clear();
        return;
    }
    for (const cache of [
        availabilitySnapshots,
        pageSnapshots,
    ]) {
        for (const key of cache.keys()) {
            if (key.startsWith(`${workingCopyPath}\0`)) {
                cache.delete(key);
            }
        }
    }
}
