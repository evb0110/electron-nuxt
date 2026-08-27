import {
    PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES,
    type IPdfAnnotationIndexChunk,
    type IPdfAnnotationIndexChunkOptions,
    type IPdfAnnotationIndexEntry,
    type IPdfAnnotationIndexObjectRef,
    type IPdfAnnotationIndexOptions,
    type IPdfAnnotationIndexSession,
} from '@contracts/electronApiDocuments';
import {
    decodeArgumentArray,
    decodeSafeIntegerValue,
    documentArgs,
    documentResult,
    type TDocumentMethodArgs,
} from '@contracts/documentsPlatformFeatureSchemas';
import {
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    appendOptionalDocumentArg as appendOptional,
    decodeOptionalDocumentObject as decodeOptionalObject,
    decodePdfRevisionOptions as decodeRevisionOptions,
    decodeRequiredDocumentObject as decodeRequiredObject,
} from '@contracts/documentsPersistenceSchemas';
import {isRecord} from '@contracts/runtimeGuards';

function fail(message: string): never {
    throw new Error(message);
}

const fixtureRevisionToken = requireDocumentRevisionToken('drt1:fixture');
const fixtureRevisionOptions = {expectedDocumentRevisionToken: fixtureRevisionToken};

function decodeStringValue(value: unknown, fieldName: string) {
    if (typeof value !== 'string' || value.length === 0) {
        fail(`${fieldName} must be a non-empty string`);
    }
    return value;
}

function decodeAnnotationIndexOptions(value: unknown): IPdfAnnotationIndexOptions {
    const decoded = decodeRevisionOptions(value);
    if (decoded === undefined) {
        fail('annotation index options must include expectedDocumentRevisionToken');
    }
    return {expectedDocumentRevisionToken: decoded.expectedDocumentRevisionToken};
}

function decodeChunkOptions(value: unknown): IPdfAnnotationIndexChunkOptions | undefined {
    const decoded = decodeOptionalObject<{chunkBytes?: unknown}>(value, 'options');
    if (decoded === undefined) {
        return undefined;
    }
    if (decoded.chunkBytes === undefined) {
        return {};
    }
    const chunkBytes = decodeSafeIntegerValue(decoded.chunkBytes, 'options.chunkBytes', 1);
    if (chunkBytes > PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES) {
        fail(`options.chunkBytes must be at most ${PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES}`);
    }
    return {chunkBytes};
}

const beginPdfAnnotationIndexArgs = documentArgs<'beginPdfAnnotationIndex'>(
    value => {
        const args = decodeArgumentArray(value, 2);
        return [
            decodeStringValue(args[0], 'path'),
            decodeAnnotationIndexOptions(args[1]),
        ];
    },
    () => [
        '/tmp/document.pdf',
        fixtureRevisionOptions,
    ],
);
const readPdfAnnotationIndexChunkArgs = documentArgs<'readPdfAnnotationIndexChunk'>(
    value => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeStringValue(args[0], 'sessionId'),
            decodeSafeIntegerValue(args[1], 'offset'),
        ], decodeChunkOptions(args[2])) as TDocumentMethodArgs<'readPdfAnnotationIndexChunk'>;
    },
    () => [
        'annotation-index-1',
        0,
    ],
);
const releasePdfAnnotationIndexArgs = documentArgs<'releasePdfAnnotationIndex'>(
    value => {
        const args = decodeArgumentArray(value, 1);
        return [decodeStringValue(args[0], 'sessionId')];
    },
    () => ['annotation-index-1'],
);
const cancelPdfAnnotationIndexArgs = documentArgs<'cancelPdfAnnotationIndex'>(
    value => {
        const args = decodeArgumentArray(value, 1);
        return [decodeStringValue(args[0], 'sessionId')];
    },
    () => ['annotation-index-1'],
);

function decodeObjectRef(value: unknown, fieldName: string): IPdfAnnotationIndexObjectRef {
    const decoded = decodeRequiredObject<{
        objectNumber?: unknown;
        generationNumber?: unknown
    }>(value, fieldName);
    return {
        objectNumber: decodeSafeIntegerValue(decoded.objectNumber, `${fieldName}.objectNumber`, 1),
        generationNumber: decodeSafeIntegerValue(decoded.generationNumber, `${fieldName}.generationNumber`),
    };
}

function decodeEntry(value: unknown): IPdfAnnotationIndexEntry {
    const decoded = decodeRequiredObject<{
        pageIndex?: unknown;
        objectNumber?: unknown;
        generationNumber?: unknown;
        subtype?: unknown;
        name?: unknown;
        popupRef?: unknown;
        parentRef?: unknown;
    }>(value, 'annotation index entry');
    if (
        typeof decoded.subtype !== 'string'
        || decoded.subtype.length === 0
        || decoded.name !== null
        && typeof decoded.name !== 'string'
    ) {
        fail('invalid annotation index entry text fields');
    }
    return {
        pageIndex: decodeSafeIntegerValue(decoded.pageIndex, 'annotation index entry pageIndex') as IPdfAnnotationIndexEntry['pageIndex'],
        objectNumber: decodeSafeIntegerValue(decoded.objectNumber, 'annotation index entry objectNumber'),
        generationNumber: decodeSafeIntegerValue(decoded.generationNumber, 'annotation index entry generationNumber'),
        subtype: decoded.subtype,
        name: decoded.name,
        popupRef: decoded.popupRef === undefined || decoded.popupRef === null
            ? null
            : decodeObjectRef(decoded.popupRef, 'annotation index entry popupRef'),
        parentRef: decoded.parentRef === undefined || decoded.parentRef === null
            ? null
            : decodeObjectRef(decoded.parentRef, 'annotation index entry parentRef'),
    };
}

const pdfAnnotationIndexSessionResult = documentResult<'beginPdfAnnotationIndex'>(
    value => {
        const decoded = decodeRequiredObject<{
            sessionId?: unknown;
            documentRef?: unknown;
            documentRevisionToken?: unknown;
            pageCount?: unknown;
            entryCount?: unknown;
            totalBytes?: unknown;
        }>(value, 'annotation index session');
        if (
            typeof decoded.sessionId !== 'string'
            || decoded.sessionId.length === 0
            || typeof decoded.documentRef !== 'string'
            || decoded.documentRef.length === 0
        ) {
            fail('invalid annotation index session identifiers');
        }
        const documentRevisionToken = typeof decoded.documentRevisionToken === 'string'
            ? parseDocumentRevisionToken(decoded.documentRevisionToken)
            : null;
        if (documentRevisionToken === null) {
            fail('annotation index documentRevisionToken is invalid');
        }
        return {
            sessionId: decoded.sessionId,
            documentRef: decoded.documentRef,
            documentRevisionToken,
            pageCount: decodeSafeIntegerValue(decoded.pageCount, 'annotation index pageCount'),
            entryCount: decodeSafeIntegerValue(decoded.entryCount, 'annotation index entryCount'),
            totalBytes: decodeSafeIntegerValue(decoded.totalBytes, 'annotation index totalBytes'),
        } satisfies IPdfAnnotationIndexSession;
    },
    () => ({
        sessionId: 'annotation-index-1',
        documentRef: '/tmp/document.pdf',
        documentRevisionToken: fixtureRevisionToken,
        pageCount: 1,
        entryCount: 0,
        totalBytes: 1,
    }),
);
const pdfAnnotationIndexChunkResult = documentResult<'readPdfAnnotationIndexChunk'>(
    value => {
        const decoded = decodeRequiredObject<{
            offset?: unknown;
            nextOffset?: unknown;
            byteLength?: unknown;
            done?: unknown;
            entries?: unknown;
        }>(value, 'annotation index chunk');
        const nextOffset = decoded.nextOffset === null || decoded.nextOffset === undefined
            ? null
            : decodeSafeIntegerValue(decoded.nextOffset, 'annotation index chunk nextOffset');
        if (typeof decoded.done !== 'boolean' || !Array.isArray(decoded.entries)) {
            fail('invalid annotation index chunk');
        }
        const byteLength = decodeSafeIntegerValue(decoded.byteLength, 'annotation index chunk byteLength');
        if (byteLength > PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES) {
            fail(`annotation index chunk exceeds ${PDF_ANNOTATION_INDEX_MAX_CHUNK_BYTES} bytes`);
        }
        return {
            offset: decodeSafeIntegerValue(decoded.offset, 'annotation index chunk offset'),
            nextOffset,
            byteLength,
            done: decoded.done,
            entries: decoded.entries.map(decodeEntry),
        } satisfies IPdfAnnotationIndexChunk;
    },
    () => ({
        offset: 0,
        nextOffset: null,
        byteLength: 0,
        done: true,
        entries: [],
    }),
);
const pdfAnnotationIndexCancelResult = documentResult<'cancelPdfAnnotationIndex'>(
    value => {
        if (!isRecord(value) || typeof value.canceled !== 'boolean') {
            fail('invalid annotation index cancellation result');
        }
        return {canceled: value.canceled};
    },
    () => ({canceled: false}),
);

export {
    beginPdfAnnotationIndexArgs,
    cancelPdfAnnotationIndexArgs,
    pdfAnnotationIndexCancelResult,
    pdfAnnotationIndexChunkResult,
    pdfAnnotationIndexSessionResult,
    readPdfAnnotationIndexChunkArgs,
    releasePdfAnnotationIndexArgs,
};
