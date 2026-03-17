import type { TDocumentRef } from '@contracts/platform-api';

export function isBrowserDocumentRef(documentRef: TDocumentRef | null | undefined) {
    return typeof documentRef === 'string' && documentRef.startsWith('browser://');
}

export function getDocumentRefBaseName(documentRef: TDocumentRef | null | undefined) {
    if (!documentRef) {
        return null;
    }

    const segment = documentRef.split(/[\\/]/).pop() ?? null;
    if (!segment) {
        return null;
    }

    try {
        return decodeURIComponent(segment);
    } catch {
        return segment;
    }
}

export function getDocumentRefDisplayLabel(documentRef: TDocumentRef | null | undefined) {
    if (!documentRef) {
        return null;
    }

    if (isBrowserDocumentRef(documentRef)) {
        return getDocumentRefBaseName(documentRef) ?? documentRef;
    }

    return documentRef;
}
