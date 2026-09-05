import { createBrowserDocumentContentToken } from '@app/platform/browser/browserDocumentChunkStorage';
import type { IBrowserDocumentEntry } from '@app/platform/browser/browserDocumentTypes';
import {
    requireDocumentRevisionToken,
    type IDocumentRevisionInfo,
} from '@contracts/documentRevision';
import { createEpochMs } from '@contracts/timestamps';

export function getBrowserDocumentEntryContentRevision(entry: IBrowserDocumentEntry) {
    return typeof entry.contentRevision === 'number'
        && Number.isSafeInteger(entry.contentRevision)
        && entry.contentRevision >= 1
        ? entry.contentRevision
        : 1;
}

export function createBrowserDocumentRevisionInfo(
    entry: IBrowserDocumentEntry,
    documentRef = entry.ref,
): IDocumentRevisionInfo {
    return {
        version: 1,
        documentRef,
        authority: 'browser-document-store',
        token: requireDocumentRevisionToken(`drt1:browser:${entry.contentToken ?? 'legacy'}`),
        contentRevision: getBrowserDocumentEntryContentRevision(entry),
        mintedAt: createEpochMs(entry.updatedAt),
    };
}

export function updateBrowserDocumentEntryContentToken(entry: IBrowserDocumentEntry) {
    const previousToken = createBrowserDocumentRevisionInfo(entry).token;
    entry.contentToken = createBrowserDocumentContentToken();
    entry.contentRevision = getBrowserDocumentEntryContentRevision(entry) + 1;
    return previousToken;
}

export { createBrowserDocumentContentToken };
