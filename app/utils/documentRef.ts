import type { TDocumentRef } from '@contracts/platformApi';

function decodeUriComponentRepeatedly(value: string, maxPasses = 3) {
    let decoded = value;

    for (let pass = 0; pass < maxPasses; pass += 1) {
        try {
            const nextDecoded = decodeURIComponent(decoded);
            if (nextDecoded === decoded) {
                break;
            }
            decoded = nextDecoded;
        } catch {
            break;
        }
    }

    return decoded;
}

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
        return decodeUriComponentRepeatedly(segment);
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

export function decodeDocumentRefSegment(segment: string) {
    return decodeUriComponentRepeatedly(segment);
}
