import { decodeDocumentRefSegment } from '@app/utils/documentRef';
import { createBrowserSafeId } from '@app/utils/browserSafe';

const BROWSER_REF_PREFIX = 'browser://documents/';

function getDocumentFileName(ref: string) {
    const trimmed = ref.startsWith(BROWSER_REF_PREFIX)
        ? ref.slice(BROWSER_REF_PREFIX.length)
        : ref;

    return decodeDocumentRefSegment(trimmed.split('/').at(-1) ?? 'document');
}

export function createBrowserDocumentRef(fileName: string) {
    return `${BROWSER_REF_PREFIX}${createBrowserSafeId()}/${encodeURIComponent(fileName)}`;
}

export function isBrowserDocumentRef(path: string) {
    return path.startsWith(BROWSER_REF_PREFIX);
}

export function getBrowserDocumentFileName(path: string) {
    return getDocumentFileName(path);
}
