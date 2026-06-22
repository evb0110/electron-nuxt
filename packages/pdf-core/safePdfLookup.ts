import type {
    PDFContext,
    PDFObject,
    PDFPage,
} from 'pdf-lib';
import {
    PDFArray,
    PDFDict,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFStream,
    UnexpectedObjectTypeError,
} from 'pdf-lib';

const UNEXPECTED_OBJECT_TYPE_MESSAGE_PREFIX = 'Expected instance of ';
const MAX_INHERITABLE_LOOKUP_DEPTH = 64;

export function isPdfUnexpectedObjectTypeError(error: unknown) {
    return error instanceof UnexpectedObjectTypeError
        || (error instanceof Error && error.message.startsWith(UNEXPECTED_OBJECT_TYPE_MESSAGE_PREFIX));
}

function handleOptionalPdfLookupError(error: unknown) {
    if (isPdfUnexpectedObjectTypeError(error)) {
        return null;
    }
    throw error;
}

export function safePdfContextLookupArray(context: PDFContext, value: unknown) {
    try {
        return context.lookupMaybe(value as PDFObject | PDFRef | undefined, PDFArray) ?? null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfContextLookupDict(context: PDFContext, value: unknown) {
    try {
        return context.lookupMaybe(value as PDFObject | PDFRef | undefined, PDFDict) ?? null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfContextLookupStream(context: PDFContext, value: unknown) {
    try {
        return context.lookupMaybe(value as PDFObject | PDFRef | undefined, PDFStream) ?? null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfDictLookupArray(dict: PDFDict, key: PDFName) {
    try {
        return dict.lookupMaybe(key, PDFArray) ?? null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfDictLookupDict(dict: PDFDict, key: PDFName) {
    try {
        return dict.lookupMaybe(key, PDFDict) ?? null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfDictLookupName(dict: PDFDict, key: PDFName) {
    try {
        return dict.lookupMaybe(key, PDFName) ?? null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfDictLookupNumber(dict: PDFDict, key: PDFName) {
    try {
        return dict.lookupMaybe(key, PDFNumber) ?? null;
    } catch (error) {
        return handleOptionalPdfLookupError(error);
    }
}

export function safePdfPageAnnots(page: PDFPage) {
    return safePdfDictLookupArray(page.node, PDFName.of('Annots'));
}

export function safePdfPageInheritableDict(page: PDFPage, key: PDFName) {
    let node: PDFDict | null = page.node;
    const visitedNodes = new Set<PDFDict>();

    for (let depth = 0; node && depth < MAX_INHERITABLE_LOOKUP_DEPTH; depth += 1) {
        if (visitedNodes.has(node)) {
            return null;
        }
        visitedNodes.add(node);

        const value = node.get(key);
        if (value !== undefined) {
            if (value instanceof PDFDict) {
                return value;
            }
            if (value instanceof PDFRef) {
                return safePdfContextLookupDict(page.doc.context, value);
            }
            return null;
        }

        const parentValue = node.get(PDFName.of('Parent'));
        if (parentValue instanceof PDFDict) {
            node = parentValue;
            continue;
        }
        if (parentValue instanceof PDFRef) {
            node = safePdfContextLookupDict(page.doc.context, parentValue);
            continue;
        }
        return null;
    }

    return null;
}
