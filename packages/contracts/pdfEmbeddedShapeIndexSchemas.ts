import {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
import {
    PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES,
    type IPdfEmbeddedShapeIndexChunk,
    type IPdfEmbeddedShapeIndexChunkOptions,
    type IPdfEmbeddedShapeIndexEntry,
    type IPdfEmbeddedShapeIndexOptions,
    type IPdfEmbeddedShapeIndexPoint,
    type IPdfEmbeddedShapeIndexSession,
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
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

function fail(message: string): never {
    throw new Error(message);
}

const fixtureRevisionToken = requireDocumentRevisionToken('drt1:embedded-shape-index-fixture');
const fixtureRevisionOptions = {expectedDocumentRevisionToken: fixtureRevisionToken};

function decodeStringValue(value: unknown, fieldName: string) {
    if (typeof value !== 'string' || value.length === 0) {
        fail(`${fieldName} must be a non-empty string`);
    }
    return value;
}

function decodeFiniteNumber(value: unknown, fieldName: string, min?: number) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (min !== undefined && value < min)) {
        fail(`${fieldName} must be a finite number${min === undefined ? '' : ` >= ${min}`}`);
    }
    return value;
}

function decodeOptionalFiniteNumber(value: unknown, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    return decodeFiniteNumber(value, fieldName);
}

function decodeOptionalString(value: unknown, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    return decodeStringValue(value, fieldName);
}

function decodeOptionalTimestamp(value: unknown, fieldName: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        fail(`${fieldName} must be a safe integer timestamp or null`);
    }
    return value;
}

function decodeEmbeddedShapeIndexOptions(value: unknown): IPdfEmbeddedShapeIndexOptions {
    const decoded = decodeRevisionOptions(value);
    if (decoded === undefined) {
        fail('embedded shape index options must include expectedDocumentRevisionToken');
    }
    return {expectedDocumentRevisionToken: decoded.expectedDocumentRevisionToken};
}

function decodeChunkOptions(value: unknown): IPdfEmbeddedShapeIndexChunkOptions | undefined {
    const decoded = decodeOptionalObject<{chunkBytes?: unknown}>(value, 'options');
    if (decoded === undefined) {
        return undefined;
    }
    if (decoded.chunkBytes === undefined) {
        return {};
    }
    const chunkBytes = decodeSafeIntegerValue(decoded.chunkBytes, 'options.chunkBytes', 1);
    if (chunkBytes > PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES) {
        fail(`options.chunkBytes must be at most ${PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES}`);
    }
    return {chunkBytes};
}

const beginPdfEmbeddedShapeIndexArgs = documentArgs<'beginPdfEmbeddedShapeIndex'>(
    value => {
        const args = decodeArgumentArray(value, 2);
        return [
            decodeStringValue(args[0], 'path'),
            decodeEmbeddedShapeIndexOptions(args[1]),
        ];
    },
    () => [
        '/tmp/document.pdf',
        fixtureRevisionOptions,
    ],
);
const readPdfEmbeddedShapeIndexChunkArgs = documentArgs<'readPdfEmbeddedShapeIndexChunk'>(
    value => {
        const args = decodeArgumentArray(value, 2, 3);
        return appendOptional([
            decodeStringValue(args[0], 'sessionId'),
            decodeSafeIntegerValue(args[1], 'offset'),
        ], decodeChunkOptions(args[2])) as TDocumentMethodArgs<'readPdfEmbeddedShapeIndexChunk'>;
    },
    () => [
        'embedded-shape-index-1',
        0,
    ],
);
const releasePdfEmbeddedShapeIndexArgs = documentArgs<'releasePdfEmbeddedShapeIndex'>(
    value => {
        const args = decodeArgumentArray(value, 1);
        return [decodeStringValue(args[0], 'sessionId')];
    },
    () => ['embedded-shape-index-1'],
);
const cancelPdfEmbeddedShapeIndexArgs = documentArgs<'cancelPdfEmbeddedShapeIndex'>(
    value => {
        const args = decodeArgumentArray(value, 1);
        return [decodeStringValue(args[0], 'sessionId')];
    },
    () => ['embedded-shape-index-1'],
);

function decodePoint(value: unknown, fieldName: string): IPdfEmbeddedShapeIndexPoint {
    const decoded = decodeRequiredObject<{
        x?: unknown;
        y?: unknown
    }>(value, fieldName);
    return {
        x: decodeFiniteNumber(decoded.x, `${fieldName}.x`),
        y: decodeFiniteNumber(decoded.y, `${fieldName}.y`),
    };
}

function decodePoints(value: unknown, fieldName: string): IPdfEmbeddedShapeIndexPoint[] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length > 40_000) {
        fail(`${fieldName} must contain at most 40000 points`);
    }
    return value.map((point, index) => decodePoint(point, `${fieldName}[${index}]`));
}

function decodeStrokes(value: unknown): IPdfEmbeddedShapeIndexPoint[][] | null {
    if (value === undefined || value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length > 4_096) {
        fail('annotation index entry strokes must contain at most 4096 strokes');
    }
    return value.map((stroke, index) => decodePoints(
        stroke,
        `annotation index entry strokes[${index}]`,
    ) ?? []);
}

function decodeEntry(value: unknown): IPdfEmbeddedShapeIndexEntry {
    const decoded = decodeRequiredObject<{
        pageIndex?: unknown;
        objectNumber?: unknown;
        generationNumber?: unknown;
        stableKey?: unknown;
        pdfSubtype?: unknown;
        type?: unknown;
        x?: unknown;
        y?: unknown;
        width?: unknown;
        height?: unknown;
        x2?: unknown;
        y2?: unknown;
        color?: unknown;
        fillColor?: unknown;
        opacity?: unknown;
        strokeWidth?: unknown;
        points?: unknown;
        strokes?: unknown;
        lineStartStyle?: unknown;
        lineEndStyle?: unknown;
        createdAt?: unknown;
        modifiedAt?: unknown;
    }>(value, 'embedded shape index entry');
    if (!isOneOf(PDF_ANNOTATION_SHAPE_PDF_SUBTYPES, decoded.pdfSubtype)) {
        fail('embedded shape index entry pdfSubtype is unsupported');
    }
    if (!isOneOf(PDF_ANNOTATION_SHAPE_TYPES, decoded.type)) {
        fail('embedded shape index entry type is unsupported');
    }
    const lineStartStyle = decoded.lineStartStyle === undefined || decoded.lineStartStyle === null
        ? null
        : isOneOf(PDF_ANNOTATION_LINE_END_STYLES, decoded.lineStartStyle)
            ? decoded.lineStartStyle
            : fail('embedded shape index entry lineStartStyle is unsupported');
    const lineEndStyle = decoded.lineEndStyle === undefined || decoded.lineEndStyle === null
        ? null
        : isOneOf(PDF_ANNOTATION_LINE_END_STYLES, decoded.lineEndStyle)
            ? decoded.lineEndStyle
            : fail('embedded shape index entry lineEndStyle is unsupported');
    return {
        pageIndex: decodeSafeIntegerValue(decoded.pageIndex, 'embedded shape index entry pageIndex') as IPdfEmbeddedShapeIndexEntry['pageIndex'],
        objectNumber: decodeSafeIntegerValue(decoded.objectNumber, 'embedded shape index entry objectNumber', 1),
        generationNumber: decodeSafeIntegerValue(decoded.generationNumber, 'embedded shape index entry generationNumber'),
        stableKey: decodeOptionalString(decoded.stableKey, 'embedded shape index entry stableKey'),
        pdfSubtype: decoded.pdfSubtype,
        type: decoded.type,
        x: decodeFiniteNumber(decoded.x, 'embedded shape index entry x'),
        y: decodeFiniteNumber(decoded.y, 'embedded shape index entry y'),
        width: decodeFiniteNumber(decoded.width, 'embedded shape index entry width', 0),
        height: decodeFiniteNumber(decoded.height, 'embedded shape index entry height', 0),
        x2: decodeOptionalFiniteNumber(decoded.x2, 'embedded shape index entry x2'),
        y2: decodeOptionalFiniteNumber(decoded.y2, 'embedded shape index entry y2'),
        color: decodeStringValue(decoded.color, 'embedded shape index entry color'),
        fillColor: decodeOptionalString(decoded.fillColor, 'embedded shape index entry fillColor'),
        opacity: decodeFiniteNumber(decoded.opacity, 'embedded shape index entry opacity', 0),
        strokeWidth: decodeFiniteNumber(decoded.strokeWidth, 'embedded shape index entry strokeWidth', 0),
        points: decodePoints(decoded.points, 'embedded shape index entry points'),
        strokes: decodeStrokes(decoded.strokes),
        lineStartStyle,
        lineEndStyle,
        createdAt: decodeOptionalTimestamp(decoded.createdAt, 'embedded shape index entry createdAt'),
        modifiedAt: decodeOptionalTimestamp(decoded.modifiedAt, 'embedded shape index entry modifiedAt'),
    } satisfies IPdfEmbeddedShapeIndexEntry;
}

const pdfEmbeddedShapeIndexSessionResult = documentResult<'beginPdfEmbeddedShapeIndex'>(
    value => {
        const decoded = decodeRequiredObject<{
            sessionId?: unknown;
            documentRef?: unknown;
            documentRevisionToken?: unknown;
            pageCount?: unknown;
            entryCount?: unknown;
            totalBytes?: unknown;
        }>(value, 'embedded shape index session');
        if (
            typeof decoded.sessionId !== 'string'
            || decoded.sessionId.length === 0
            || typeof decoded.documentRef !== 'string'
            || decoded.documentRef.length === 0
        ) {
            fail('invalid embedded shape index session identifiers');
        }
        const documentRevisionToken = typeof decoded.documentRevisionToken === 'string'
            ? parseDocumentRevisionToken(decoded.documentRevisionToken)
            : null;
        if (documentRevisionToken === null) {
            fail('embedded shape index documentRevisionToken is invalid');
        }
        return {
            sessionId: decoded.sessionId,
            documentRef: decoded.documentRef,
            documentRevisionToken,
            pageCount: decodeSafeIntegerValue(decoded.pageCount, 'embedded shape index pageCount'),
            entryCount: decodeSafeIntegerValue(decoded.entryCount, 'embedded shape index entryCount'),
            totalBytes: decodeSafeIntegerValue(decoded.totalBytes, 'embedded shape index totalBytes'),
        } satisfies IPdfEmbeddedShapeIndexSession;
    },
    () => ({
        sessionId: 'embedded-shape-index-1',
        documentRef: '/tmp/document.pdf',
        documentRevisionToken: fixtureRevisionToken,
        pageCount: 1,
        entryCount: 0,
        totalBytes: 1,
    }),
);
const pdfEmbeddedShapeIndexChunkResult = documentResult<'readPdfEmbeddedShapeIndexChunk'>(
    value => {
        const decoded = decodeRequiredObject<{
            offset?: unknown;
            nextOffset?: unknown;
            byteLength?: unknown;
            done?: unknown;
            entries?: unknown;
        }>(value, 'embedded shape index chunk');
        const nextOffset = decoded.nextOffset === null || decoded.nextOffset === undefined
            ? null
            : decodeSafeIntegerValue(decoded.nextOffset, 'embedded shape index chunk nextOffset');
        if (typeof decoded.done !== 'boolean' || !Array.isArray(decoded.entries)) {
            fail('invalid embedded shape index chunk');
        }
        const byteLength = decodeSafeIntegerValue(decoded.byteLength, 'embedded shape index chunk byteLength');
        if (byteLength > PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES) {
            fail(`embedded shape index chunk exceeds ${PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES} bytes`);
        }
        return {
            offset: decodeSafeIntegerValue(decoded.offset, 'embedded shape index chunk offset'),
            nextOffset,
            byteLength,
            done: decoded.done,
            entries: decoded.entries.map(decodeEntry),
        } satisfies IPdfEmbeddedShapeIndexChunk;
    },
    () => ({
        offset: 0,
        nextOffset: null,
        byteLength: 0,
        done: true,
        entries: [],
    }),
);
const pdfEmbeddedShapeIndexCancelResult = documentResult<'cancelPdfEmbeddedShapeIndex'>(
    value => {
        if (!isRecord(value) || typeof value.canceled !== 'boolean') {
            fail('invalid embedded shape index cancellation result');
        }
        return {canceled: value.canceled};
    },
    () => ({canceled: false}),
);

export {
    beginPdfEmbeddedShapeIndexArgs,
    cancelPdfEmbeddedShapeIndexArgs,
    pdfEmbeddedShapeIndexCancelResult,
    pdfEmbeddedShapeIndexChunkResult,
    pdfEmbeddedShapeIndexSessionResult,
    readPdfEmbeddedShapeIndexChunkArgs,
    releasePdfEmbeddedShapeIndexArgs,
};

export {
    PDF_EMBEDDED_SHAPE_INDEX_MAX_CHUNK_BYTES,
    PDF_EMBEDDED_SHAPE_INDEX_MAX_LINE_BYTES,
};
