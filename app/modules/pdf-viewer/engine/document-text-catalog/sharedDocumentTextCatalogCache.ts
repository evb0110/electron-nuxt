import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type { IDocumentTextSnapshot } from '@contracts/documentTextCatalog';
import { getOcrCapability } from '@app/utils/getOcrCapability';
import { BrowserLogger } from '@app/utils/browserLogger';

const MAX_SNAPSHOTS = 8;
const snapshots = new Map<string, Promise<IDocumentTextSnapshot | null>>();

function cacheKey(workingCopyPath: TDocumentRef, documentRevisionToken: TDocumentRevisionToken) {
    return `${workingCopyPath}\0${documentRevisionToken}`;
}

export function loadSharedDocumentTextCatalog(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: TDocumentRevisionToken,
) {
    const key = cacheKey(workingCopyPath, documentRevisionToken);
    const cached = snapshots.get(key);
    if (cached) {
        snapshots.delete(key);
        snapshots.set(key, cached);
        return cached;
    }

    const pending = getOcrCapability().resolveDocumentTextCatalog(
        workingCopyPath,
        documentRevisionToken,
    ).catch((error) => {
        BrowserLogger.warn('ocr', 'Failed to resolve DocumentTextCatalog for PDF viewer', error);
        return null;
    });
    snapshots.set(key, pending);
    while (snapshots.size > MAX_SNAPSHOTS) {
        const oldestKey = snapshots.keys().next().value;
        if (oldestKey === undefined) {
            break;
        }
        snapshots.delete(oldestKey);
    }
    return pending;
}

export function clearSharedDocumentTextCatalog(workingCopyPath?: TDocumentRef) {
    if (workingCopyPath === undefined) {
        snapshots.clear();
        return;
    }
    for (const key of snapshots.keys()) {
        if (key.startsWith(`${workingCopyPath}\0`)) {
            snapshots.delete(key);
        }
    }
}
