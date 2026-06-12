import type { IpcRenderer } from 'electron';
import type {
    IDocumentsFileCapability,
    IPdfNativeAnnotationDelete,
    IPdfNativeFreeTextNote,
    IPdfNativeFreeTextNoteMarkerRect,
    IPdfNativeMarkupMarkerRect,
    IPdfNativeMarkupSubtypeHint,
    IPdfNativePageLabelRange,
    IPdfNativePlacedImage,
    IPdfNativeShapeAnnotation,
    IPdfNativeShapePoint,
    IPdfNativeWorkingCopyExpectation,
} from '@contracts/electronApiDocuments';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import { isRecord } from '@contracts/runtimeGuards';
import {
    DOCUMENTS_CHANNELS,
    type IDocumentsInvokeMap,
} from '@electron/features/documents/contract';
import { createTypedIpcInvoker } from '@electron/preload/ipcClient';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    assertWorkingCopyFileName,
    assertWriteData,
    MAX_IPC_FILE_NAME_LENGTH,
} from '@electron/features/documents/preloadShared';

type TDocumentsPreloadFileClient = Omit<IDocumentsFileCapability, 'getPathForFile'>;
const PDF_PERSISTENCE_CHUNK_BYTES = 8 * 1024 * 1024;
const PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS = 2;
const PDF_PERSISTENCE_READY_TIMEOUT_MS = 10_000;
const PDF_PERSISTENCE_ACK_TIMEOUT_MS = 60_000;
const PDF_NOTE_TEXT_MAX_UPDATES = 256;
const PDF_NATIVE_NOTE_MAX_CHANGES = 256;
const PDF_NATIVE_PAGE_LABEL_MAX_RANGES = 2_048;
const PDF_NATIVE_BOOKMARK_MAX_ITEMS = 5_000;
const PDF_NATIVE_BOOKMARK_MAX_DEPTH = 64;
const PDF_NATIVE_SHAPE_MAX_ITEMS = 4_096;
const PDF_NATIVE_SHAPE_MAX_DELETED_ITEMS = 4_096;
const PDF_NATIVE_SHAPE_MAX_POINTS = 20_000;
const PDF_NATIVE_SHAPE_MAX_TEXT_LENGTH = 2_048;
const PDF_NATIVE_MARKUP_MAX_ITEMS = 4_096;
const PDF_NATIVE_MARKUP_MAX_TEXT_LENGTH = 2_048;
const PDF_NATIVE_PLACED_IMAGE_MAX_ITEMS = 16;
const PDF_NATIVE_PLACED_IMAGE_MAX_BYTES = 128 * 1024 * 1024;
const PDF_DATE_PATTERN = /^D:\d{14}(?:Z|[+-]\d{2}'\d{2}')?$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/iu;
const PDF_NATIVE_PAGE_LABEL_STYLES = new Set([
    'D',
    'R',
    'r',
    'A',
    'a',
]);
const PDF_NATIVE_SHAPE_TYPES = new Set([
    'rectangle',
    'circle',
    'line',
    'arrow',
    'polyline',
    'polygon',
]);
const PDF_NATIVE_SHAPE_SUBTYPES = new Set([
    'Square',
    'Circle',
    'Line',
    'PolyLine',
    'Polygon',
    'Ink',
]);
const PDF_NATIVE_SHAPE_LINE_END_STYLES = new Set([
    'none',
    'openArrow',
    'closedArrow',
]);
const PDF_NATIVE_MARKUP_SUBTYPES = new Set([
    'Highlight',
    'Underline',
    'StrikeOut',
    'Squiggly',
]);

interface ISerializedPdfPersistencePortResult {
    path: string | null;
    validation: Awaited<ReturnType<IDocumentsFileCapability['validatePdfData']>>;
}

type TPdfValidationResult = ISerializedPdfPersistencePortResult['validation'];

interface IPdfPersistenceResultMessage {
    type: 'result';
    path: string | null;
    validation: TPdfValidationResult;
}

interface IPdfPersistenceErrorMessage {
    type: 'error';
    error?: string;
}

interface IPdfPersistenceReadyMessage {type: 'ready';}

interface IPdfPersistenceAckMessage {
    type: 'ack';
    seq: number;
}

type TPdfPersistenceMessage =
    | IPdfPersistenceResultMessage
    | IPdfPersistenceErrorMessage
    | IPdfPersistenceReadyMessage
    | IPdfPersistenceAckMessage;

function assertPositiveInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new TypeError(`${label} must be a positive integer`);
    }
    return value;
}

function assertPdfNoteTextUpdates(
    value: unknown,
    label: string,
    options: {allowEmpty?: boolean} = {},
) {
    if (
        !Array.isArray(value)
        || (!options.allowEmpty && value.length === 0)
        || value.length > PDF_NOTE_TEXT_MAX_UPDATES
    ) {
        const emptyDescription = options.allowEmpty ? 'an array' : 'a non-empty array';
        throw new TypeError(`${label} must be ${emptyDescription} with at most ${PDF_NOTE_TEXT_MAX_UPDATES} updates`);
    }

    const updates: unknown[] = value;
    return updates.map((update, index) => {
        if (!isRecord(update)) {
            throw new TypeError(`${label}[${index}] must be an object`);
        }
        const objectNumber = update.objectNumber;
        const generationNumber = update.generationNumber;
        const text = update.text;
        if (typeof objectNumber !== 'number' || !Number.isSafeInteger(objectNumber) || objectNumber < 1) {
            throw new TypeError(`${label}[${index}].objectNumber must be a positive safe integer`);
        }
        if (
            typeof generationNumber !== 'number'
            || !Number.isSafeInteger(generationNumber)
            || generationNumber < 0
            || generationNumber > 65_535
        ) {
            throw new TypeError(`${label}[${index}].generationNumber must be an integer from 0 to 65535`);
        }
        if (typeof text !== 'string') {
            throw new TypeError(`${label}[${index}].text must be a string`);
        }
        return {
            objectNumber,
            generationNumber,
            text,
        };
    });
}

function assertPdfDateString(value: unknown, label: string) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!PDF_DATE_PATTERN.test(normalized)) {
        throw new TypeError(`${label} must be a PDF date string`);
    }
    return normalized;
}

function assertFiniteUnitNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new TypeError(`${label} must be a finite number from 0 to 1`);
    }
    return value;
}

function assertFiniteNonNegativeNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${label} must be a finite non-negative number`);
    }
    return value;
}

function assertOptionalFiniteUnitNumber(value: unknown, label: string) {
    if (value === undefined || value === null) {
        return null;
    }
    return assertFiniteUnitNumber(value, label);
}

function assertPdfNativeFreeTextNoteMarkerRect(value: unknown, label: string): IPdfNativeFreeTextNoteMarkerRect {
    return assertPdfNativeNormalizedMarkerRect(value, label);
}

function assertPdfNativeNormalizedMarkerRect(value: unknown, label: string): IPdfNativeFreeTextNoteMarkerRect {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const left = assertFiniteUnitNumber(value.left, `${label}.left`);
    const top = assertFiniteUnitNumber(value.top, `${label}.top`);
    const width = assertFiniteUnitNumber(value.width, `${label}.width`);
    const height = assertFiniteUnitNumber(value.height, `${label}.height`);
    if (width <= 0 || height <= 0 || left + width > 1 || top + height > 1) {
        throw new TypeError(`${label} must fit inside the normalized page bounds`);
    }
    return {
        left,
        top,
        width,
        height,
    };
}

function assertPdfNativeMarkupMarkerRect(value: unknown, label: string): IPdfNativeMarkupMarkerRect {
    return assertPdfNativeNormalizedMarkerRect(value, label);
}

function assertOptionalString(value: unknown, label: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string or null`);
    }
    return value;
}

function assertNativeShapeOptionalString(value: unknown, label: string) {
    const normalized = assertOptionalString(value, label);
    if (normalized !== null && normalized.length > PDF_NATIVE_SHAPE_MAX_TEXT_LENGTH) {
        throw new TypeError(`${label} is too long`);
    }
    return normalized;
}

function assertOptionalTimestamp(value: unknown, label: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${label} must be a finite positive timestamp or null`);
    }
    return Math.trunc(value);
}

function assertPdfNativeFreeTextNotes(value: unknown, label: string) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_NOTE_MAX_CHANGES) {
        throw new TypeError(`${label} must be an array with at most ${PDF_NATIVE_NOTE_MAX_CHANGES} notes`);
    }

    const notes: unknown[] = value;
    return notes.map((note, index): IPdfNativeFreeTextNote => {
        if (!isRecord(note)) {
            throw new TypeError(`${label}[${index}] must be an object`);
        }
        if (
            typeof note.pageIndex !== 'number'
            || !Number.isSafeInteger(note.pageIndex)
            || note.pageIndex < 0
        ) {
            throw new TypeError(`${label}[${index}].pageIndex must be a non-negative safe integer`);
        }
        const stableKey = typeof note.stableKey === 'string' ? note.stableKey.trim() : '';
        if (!stableKey) {
            throw new TypeError(`${label}[${index}].stableKey must be a non-empty string`);
        }
        if (typeof note.text !== 'string') {
            throw new TypeError(`${label}[${index}].text must be a string`);
        }
        return {
            pageIndex: note.pageIndex,
            stableKey,
            text: note.text,
            markerRect: assertPdfNativeFreeTextNoteMarkerRect(note.markerRect, `${label}[${index}].markerRect`),
            author: assertOptionalString(note.author, `${label}[${index}].author`),
            color: assertOptionalString(note.color, `${label}[${index}].color`),
            createdAt: assertOptionalTimestamp(note.createdAt, `${label}[${index}].createdAt`),
        };
    });
}

function assertPdfNativeAnnotationDeletes(value: unknown, label: string) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_NOTE_MAX_CHANGES) {
        throw new TypeError(`${label} must be an array with at most ${PDF_NATIVE_NOTE_MAX_CHANGES} deletes`);
    }

    const deletes: unknown[] = value;
    return deletes.map((item, index): IPdfNativeAnnotationDelete => {
        if (!isRecord(item)) {
            throw new TypeError(`${label}[${index}] must be an object`);
        }
        const stableKey = typeof item.stableKey === 'string' ? item.stableKey.trim() : '';
        const hasRef = item.objectNumber !== undefined || item.generationNumber !== undefined;
        const hasValidRef = typeof item.objectNumber === 'number'
            && Number.isSafeInteger(item.objectNumber)
            && item.objectNumber >= 1
            && typeof item.generationNumber === 'number'
            && Number.isSafeInteger(item.generationNumber)
            && item.generationNumber >= 0
            && item.generationNumber <= 65_535;
        const createdAt = item.createdAt ?? null;
        if (
            typeof item.pageIndex !== 'number'
            || !Number.isSafeInteger(item.pageIndex)
            || item.pageIndex < 0
            || (hasRef && !hasValidRef)
            || (!hasValidRef && !stableKey)
            || (createdAt !== null && (
                typeof createdAt !== 'number'
                || !Number.isFinite(createdAt)
                || createdAt < 0
            ))
        ) {
            throw new TypeError(`${label}[${index}] must contain a valid pageIndex and either a PDF object ref or stableKey`);
        }
        const normalizedDelete = {
            pageIndex: item.pageIndex,
            ...(stableKey ? {stableKey} : {}),
            ...(createdAt !== null ? {createdAt: Math.trunc(createdAt)} : {}),
        };
        if (!hasValidRef) {
            return normalizedDelete;
        }
        return {
            ...normalizedDelete,
            objectNumber: item.objectNumber as number,
            generationNumber: item.generationNumber as number,
        };
    });
}

function assertPdfNativeNoteChanges(
    value: unknown,
    label: string,
): NonNullable<Parameters<NonNullable<IDocumentsFileCapability['savePdfNoteChanges']>>[1]> {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const updates = value.updates === undefined
        ? []
        : assertPdfNoteTextUpdates(value.updates, `${label}.updates`, {allowEmpty: true});
    const freeTextNotes = assertPdfNativeFreeTextNotes(value.freeTextNotes, `${label}.freeTextNotes`);
    const deletes = assertPdfNativeAnnotationDeletes(value.deletes, `${label}.deletes`);
    if (updates.length + freeTextNotes.length + deletes.length === 0) {
        throw new TypeError(`${label} must include at least one note change`);
    }
    if (updates.length + freeTextNotes.length + deletes.length > PDF_NATIVE_NOTE_MAX_CHANGES) {
        throw new TypeError(`${label} must include at most ${PDF_NATIVE_NOTE_MAX_CHANGES} note changes`);
    }
    return {
        ...(updates.length > 0 ? {updates} : {}),
        ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
        ...(deletes.length > 0 ? {deletes} : {}),
    };
}

function assertPdfNativePageLabelRange(value: unknown, label: string): IPdfNativePageLabelRange {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const startPage = value.startPage;
    const style = value.style;
    const prefix = value.prefix;
    const startNumber = value.startNumber;
    if (typeof startPage !== 'number' || !Number.isSafeInteger(startPage) || startPage < 1) {
        throw new TypeError(`${label}.startPage must be a positive safe integer`);
    }
    if (style !== null && (typeof style !== 'string' || !PDF_NATIVE_PAGE_LABEL_STYLES.has(style))) {
        throw new TypeError(`${label}.style must be a valid PDF page-label style or null`);
    }
    if (typeof prefix !== 'string') {
        throw new TypeError(`${label}.prefix must be a string`);
    }
    if (typeof startNumber !== 'number' || !Number.isSafeInteger(startNumber) || startNumber < 1) {
        throw new TypeError(`${label}.startNumber must be a positive safe integer`);
    }
    const normalizedStyle = style === null
        ? null
        : style as IPdfNativePageLabelRange['style'];
    return {
        startPage,
        style: normalizedStyle,
        prefix,
        startNumber,
    };
}

function assertPdfNativePageLabelsMutation(value: unknown, label: string) {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const totalPages = assertPositiveInteger(value.totalPages, `${label}.totalPages`);
    if (!Array.isArray(value.ranges) || value.ranges.length > PDF_NATIVE_PAGE_LABEL_MAX_RANGES) {
        throw new TypeError(`${label}.ranges must be an array with at most ${PDF_NATIVE_PAGE_LABEL_MAX_RANGES} ranges`);
    }
    const ranges: unknown[] = value.ranges;
    return {
        totalPages,
        ranges: ranges.map((range, index) =>
            assertPdfNativePageLabelRange(range, `${label}.ranges[${index}]`)),
    };
}

function assertBookmarkColor(value: unknown, label: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
        throw new TypeError(`${label} must be a #RRGGBB color string or null`);
    }
    return value.toLowerCase();
}

function assertPdfNativeBookmarkItems(
    value: unknown,
    label: string,
    state: {
        count: number;
        depth: number
    },
): IPdfBookmarkEntry[] {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    if (state.depth > PDF_NATIVE_BOOKMARK_MAX_DEPTH) {
        throw new TypeError(`${label} exceeds the maximum bookmark depth`);
    }
    const bookmarkItems: unknown[] = value;
    return bookmarkItems.map((item, index): IPdfBookmarkEntry => {
        state.count += 1;
        if (state.count > PDF_NATIVE_BOOKMARK_MAX_ITEMS) {
            throw new TypeError(`bookmark mutations must include at most ${PDF_NATIVE_BOOKMARK_MAX_ITEMS} items`);
        }
        if (!isRecord(item)) {
            throw new TypeError(`${label}[${index}] must be an object`);
        }
        const title = item.title;
        if (typeof title !== 'string') {
            throw new TypeError(`${label}[${index}].title must be a string`);
        }
        const pageIndex = item.pageIndex;
        if (
            pageIndex !== null
            && (
                typeof pageIndex !== 'number'
                || !Number.isSafeInteger(pageIndex)
                || pageIndex < 0
            )
        ) {
            throw new TypeError(`${label}[${index}].pageIndex must be a non-negative safe integer or null`);
        }
        const namedDest = item.namedDest;
        if (namedDest !== null && typeof namedDest !== 'string') {
            throw new TypeError(`${label}[${index}].namedDest must be a string or null`);
        }
        const previousDepth = state.depth;
        state.depth = previousDepth + 1;
        let items: IPdfBookmarkEntry[];
        try {
            items = assertPdfNativeBookmarkItems(item.items, `${label}[${index}].items`, state);
        } finally {
            state.depth = previousDepth;
        }
        if (state.count > PDF_NATIVE_BOOKMARK_MAX_ITEMS) {
            throw new TypeError(`bookmark mutations must include at most ${PDF_NATIVE_BOOKMARK_MAX_ITEMS} items`);
        }
        return {
            title,
            pageIndex,
            namedDest,
            bold: item.bold === true,
            italic: item.italic === true,
            color: assertBookmarkColor(item.color, `${label}[${index}].color`),
            items,
        };
    });
}

function assertPdfNativeBookmarksMutation(value: unknown, label: string) {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return {
        totalPages: assertPositiveInteger(value.totalPages, `${label}.totalPages`),
        untitledLabel: typeof value.untitledLabel === 'string' ? value.untitledLabel : '',
        items: assertPdfNativeBookmarkItems(value.items, `${label}.items`, {
            count: 0,
            depth: 0,
        }),
    };
}

function assertPdfNativeShapePoint(value: unknown, label: string): IPdfNativeShapePoint {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return {
        x: assertFiniteUnitNumber(value.x, `${label}.x`),
        y: assertFiniteUnitNumber(value.y, `${label}.y`),
    };
}

function assertPdfNativeShapePoints(value: unknown, label: string, state: {count: number}) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    const points: unknown[] = value;
    state.count += points.length;
    if (state.count > PDF_NATIVE_SHAPE_MAX_POINTS) {
        throw new TypeError(`shape mutations must include at most ${PDF_NATIVE_SHAPE_MAX_POINTS} points`);
    }
    return points.map((point, index) => assertPdfNativeShapePoint(point, `${label}[${index}]`));
}

function assertPdfNativeShapeStrokes(value: unknown, label: string, state: {count: number}) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    const strokes: unknown[] = value;
    return strokes.map((points, index) => assertPdfNativeShapePoints(points, `${label}[${index}]`, state) ?? []);
}

function assertNativeShapeEnum(
    value: unknown,
    label: string,
    allowed: Set<string>,
    options: {optional?: boolean} = {},
) {
    if (value === undefined || value === null) {
        if (options.optional) {
            return null;
        }
        throw new TypeError(`${label} is required`);
    }
    if (typeof value !== 'string' || !allowed.has(value)) {
        throw new TypeError(`${label} is not a supported value`);
    }
    return value;
}

function assertPdfNativeShapeAnnotation(
    value: unknown,
    label: string,
    state: {count: number},
): IPdfNativeShapeAnnotation {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const type = assertNativeShapeEnum(value.type, `${label}.type`, PDF_NATIVE_SHAPE_TYPES);
    const pageIndex = value.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        throw new TypeError(`${label}.pageIndex must be a non-negative safe integer`);
    }
    const color = value.color;
    if (typeof color !== 'string' || color.length > PDF_NATIVE_SHAPE_MAX_TEXT_LENGTH) {
        throw new TypeError(`${label}.color must be a color string`);
    }
    const opacity = value.opacity;
    if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        throw new TypeError(`${label}.opacity must be a finite number from 0 to 1`);
    }
    const id = assertNativeShapeOptionalString(value.id, `${label}.id`);
    const points = assertPdfNativeShapePoints(value.points, `${label}.points`, state);
    const strokes = assertPdfNativeShapeStrokes(value.strokes, `${label}.strokes`, state);
    const shape: IPdfNativeShapeAnnotation = {
        type: type as IPdfNativeShapeAnnotation['type'],
        pageIndex,
        x: assertFiniteUnitNumber(value.x, `${label}.x`),
        y: assertFiniteUnitNumber(value.y, `${label}.y`),
        width: assertFiniteNonNegativeNumber(value.width, `${label}.width`),
        height: assertFiniteNonNegativeNumber(value.height, `${label}.height`),
        x2: assertOptionalFiniteUnitNumber(value.x2, `${label}.x2`),
        y2: assertOptionalFiniteUnitNumber(value.y2, `${label}.y2`),
        color,
        fillColor: assertNativeShapeOptionalString(value.fillColor, `${label}.fillColor`),
        opacity,
        strokeWidth: assertFiniteNonNegativeNumber(value.strokeWidth, `${label}.strokeWidth`),
        annotationId: assertNativeShapeOptionalString(value.annotationId, `${label}.annotationId`),
        stableKey: assertNativeShapeOptionalString(value.stableKey, `${label}.stableKey`),
        pdfSubtype: assertNativeShapeEnum(value.pdfSubtype, `${label}.pdfSubtype`, PDF_NATIVE_SHAPE_SUBTYPES, {optional: true}) as NonNullable<IPdfNativeShapeAnnotation['pdfSubtype']> | null,
        lineStartStyle: assertNativeShapeEnum(value.lineStartStyle, `${label}.lineStartStyle`, PDF_NATIVE_SHAPE_LINE_END_STYLES, {optional: true}) as NonNullable<IPdfNativeShapeAnnotation['lineStartStyle']> | null,
        lineEndStyle: assertNativeShapeEnum(value.lineEndStyle, `${label}.lineEndStyle`, PDF_NATIVE_SHAPE_LINE_END_STYLES, {optional: true}) as NonNullable<IPdfNativeShapeAnnotation['lineEndStyle']> | null,
        createdAt: assertOptionalTimestamp(value.createdAt, `${label}.createdAt`),
        modifiedAt: assertOptionalTimestamp(value.modifiedAt, `${label}.modifiedAt`),
    };
    if (id !== null) {
        shape.id = id;
    }
    if (points !== undefined) {
        shape.points = points;
    }
    if (strokes !== undefined) {
        shape.strokes = strokes;
    }
    return shape;
}

function assertStringArray(value: unknown, label: string, maxItems: number) {
    if (!Array.isArray(value) || value.length > maxItems) {
        throw new TypeError(`${label} must be an array with at most ${maxItems} items`);
    }
    const items: unknown[] = value;
    return items.map((item, index) => {
        if (typeof item !== 'string' || item.length > PDF_NATIVE_SHAPE_MAX_TEXT_LENGTH) {
            throw new TypeError(`${label}[${index}] must be a string`);
        }
        return item.trim();
    }).filter(item => item.length > 0);
}

function assertNativeMarkupSubtype(value: unknown, label: string) {
    if (typeof value !== 'string' || !PDF_NATIVE_MARKUP_SUBTYPES.has(value)) {
        throw new TypeError(`${label} must be a supported text-markup subtype`);
    }
    return value as NonNullable<IPdfNativeMarkupSubtypeHint['subtype']>;
}

function assertNativeMarkupOptionalString(value: unknown, label: string) {
    const normalized = assertOptionalString(value, label);
    if (normalized !== null && normalized.length > PDF_NATIVE_MARKUP_MAX_TEXT_LENGTH) {
        throw new TypeError(`${label} is too long`);
    }
    return normalized;
}

function assertNativeMarkupOptionalIndex(value: unknown, label: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer or null`);
    }
    return value;
}

function assertPdfNativeMarkupOverride(value: unknown, label: string) {
    if (!Array.isArray(value) || value.length !== 2) {
        throw new TypeError(`${label} must be an [annotationId, subtype] tuple`);
    }
    const tuple: unknown[] = value;
    const [
        annotationId,
        subtype,
    ] = tuple;
    if (
        typeof annotationId !== 'string'
        || annotationId.trim().length === 0
        || annotationId.length > PDF_NATIVE_MARKUP_MAX_TEXT_LENGTH
    ) {
        throw new TypeError(`${label}[0] must be a bounded annotation id`);
    }
    return [
        annotationId.trim(),
        assertNativeMarkupSubtype(subtype, `${label}[1]`),
    ] as const;
}

function assertPdfNativeMarkupHint(value: unknown, label: string): IPdfNativeMarkupSubtypeHint {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const pageIndex = value.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        throw new TypeError(`${label}.pageIndex must be a non-negative safe integer`);
    }
    return {
        subtype: assertNativeMarkupSubtype(value.subtype, `${label}.subtype`),
        pageIndex,
        markerRect: assertPdfNativeMarkupMarkerRect(value.markerRect, `${label}.markerRect`),
        annotationId: assertNativeMarkupOptionalString(value.annotationId, `${label}.annotationId`),
        color: assertNativeMarkupOptionalString(value.color, `${label}.color`),
        id: assertNativeMarkupOptionalString(value.id, `${label}.id`),
        pageMarkupIndex: assertNativeMarkupOptionalIndex(value.pageMarkupIndex, `${label}.pageMarkupIndex`),
        source: assertNativeMarkupOptionalString(value.source, `${label}.source`),
    };
}

function assertPdfNativeMarkupMutation(value: unknown, label: string) {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (!Array.isArray(value.overrides) || value.overrides.length > PDF_NATIVE_MARKUP_MAX_ITEMS) {
        throw new TypeError(`${label}.overrides must be an array with at most ${PDF_NATIVE_MARKUP_MAX_ITEMS} items`);
    }
    if (!Array.isArray(value.hints) || value.hints.length > PDF_NATIVE_MARKUP_MAX_ITEMS) {
        throw new TypeError(`${label}.hints must be an array with at most ${PDF_NATIVE_MARKUP_MAX_ITEMS} items`);
    }
    const overrideItems: unknown[] = value.overrides;
    const hintItems: unknown[] = value.hints;
    const overrides = overrideItems.map((override, index) =>
        assertPdfNativeMarkupOverride(override, `${label}.overrides[${index}]`));
    const hints = hintItems.map((hint, index) =>
        assertPdfNativeMarkupHint(hint, `${label}.hints[${index}]`));
    if (overrides.length + hints.length === 0) {
        throw new TypeError(`${label} must include at least one text-markup rewrite`);
    }
    return {
        overrides,
        hints,
    };
}

function assertPdfNativePlacedImage(value: unknown, label: string): IPdfNativePlacedImage {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const pageIndex = value.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        throw new TypeError(`${label}.pageIndex must be a non-negative safe integer`);
    }
    const x = assertFiniteUnitNumber(value.x, `${label}.x`);
    const y = assertFiniteUnitNumber(value.y, `${label}.y`);
    const width = assertFiniteUnitNumber(value.width, `${label}.width`);
    const height = assertFiniteUnitNumber(value.height, `${label}.height`);
    if (width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
        throw new TypeError(`${label} must fit inside the normalized page bounds`);
    }
    const rotationDegrees = value.rotationDegrees ?? null;
    if (
        rotationDegrees !== null
        && (typeof rotationDegrees !== 'number' || !Number.isFinite(rotationDegrees))
    ) {
        throw new TypeError(`${label}.rotationDegrees must be a finite number or null`);
    }
    if (value.mimeType !== 'image/jpeg') {
        throw new TypeError(`${label}.mimeType must be image/jpeg`);
    }
    if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength === 0 || value.bytes.byteLength > PDF_NATIVE_PLACED_IMAGE_MAX_BYTES) {
        throw new TypeError(`${label}.bytes must be a non-empty Uint8Array`);
    }
    return {
        pageIndex,
        x,
        y,
        width,
        height,
        rotationDegrees,
        mimeType: 'image/jpeg',
        bytes: value.bytes,
    };
}

function assertPdfNativePlacedImages(value: unknown, label: string) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_PLACED_IMAGE_MAX_ITEMS) {
        throw new TypeError(`${label} must be an array with at most ${PDF_NATIVE_PLACED_IMAGE_MAX_ITEMS} images`);
    }
    const images: unknown[] = value;
    return images.map((image, index) => assertPdfNativePlacedImage(image, `${label}[${index}]`));
}

function assertPdfNativeWorkingCopyExpectation(value: unknown, label: string): IPdfNativeWorkingCopyExpectation {
    if (value === undefined || value === null) {
        throw new TypeError(`${label} must be an object`);
    }
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const byteLength = value.byteLength;
    const sha256 = value.sha256;
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength <= 0) {
        throw new TypeError(`${label}.byteLength must be a positive safe integer`);
    }
    if (typeof sha256 !== 'string' || !SHA256_HEX_PATTERN.test(sha256)) {
        throw new TypeError(`${label}.sha256 must be a SHA-256 hex digest`);
    }
    return {
        byteLength,
        sha256: sha256.toLowerCase(),
    };
}

function assertPdfNativeShapesMutation(value: unknown, label: string) {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (!Array.isArray(value.shapes) || value.shapes.length > PDF_NATIVE_SHAPE_MAX_ITEMS) {
        throw new TypeError(`${label}.shapes must be an array with at most ${PDF_NATIVE_SHAPE_MAX_ITEMS} shapes`);
    }
    const pointState = {count: 0};
    return {
        totalPages: assertPositiveInteger(value.totalPages, `${label}.totalPages`),
        rewriteShapeState: value.rewriteShapeState === true,
        shapes: value.shapes.map((shape, index) =>
            assertPdfNativeShapeAnnotation(shape, `${label}.shapes[${index}]`, pointState)),
        deletedAnnotationIds: assertStringArray(
            value.deletedAnnotationIds,
            `${label}.deletedAnnotationIds`,
            PDF_NATIVE_SHAPE_MAX_DELETED_ITEMS,
        ),
        deletedStableKeys: assertStringArray(
            value.deletedStableKeys,
            `${label}.deletedStableKeys`,
            PDF_NATIVE_SHAPE_MAX_DELETED_ITEMS,
        ),
    };
}

function assertPdfNativeMutationSet(
    value: unknown,
    label: string,
): NonNullable<Parameters<NonNullable<IDocumentsFileCapability['savePdfNativeMutations']>>[1]> {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    const updates = value.updates === undefined
        ? []
        : assertPdfNoteTextUpdates(value.updates, `${label}.updates`, {allowEmpty: true});
    const freeTextNotes = assertPdfNativeFreeTextNotes(value.freeTextNotes, `${label}.freeTextNotes`);
    const deletes = assertPdfNativeAnnotationDeletes(value.deletes, `${label}.deletes`);
    const pageLabels = value.pageLabels === undefined
        ? null
        : assertPdfNativePageLabelsMutation(value.pageLabels, `${label}.pageLabels`);
    const bookmarks = value.bookmarks === undefined
        ? null
        : assertPdfNativeBookmarksMutation(value.bookmarks, `${label}.bookmarks`);
    const shapes = value.shapes === undefined
        ? null
        : assertPdfNativeShapesMutation(value.shapes, `${label}.shapes`);
    const markup = value.markup === undefined
        ? null
        : assertPdfNativeMarkupMutation(value.markup, `${label}.markup`);
    const placedImages = assertPdfNativePlacedImages(value.placedImages, `${label}.placedImages`);
    if (
        updates.length + freeTextNotes.length + deletes.length === 0
        && !pageLabels
        && !bookmarks
        && !shapes
        && !markup
        && placedImages.length === 0
    ) {
        throw new TypeError(`${label} must include at least one native PDF mutation`);
    }
    if (updates.length + freeTextNotes.length + deletes.length > PDF_NATIVE_NOTE_MAX_CHANGES) {
        throw new TypeError(`${label} must include at most ${PDF_NATIVE_NOTE_MAX_CHANGES} note changes`);
    }
    return {
        ...(updates.length > 0 ? {updates} : {}),
        ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
        ...(deletes.length > 0 ? {deletes} : {}),
        ...(pageLabels ? {pageLabels} : {}),
        ...(bookmarks ? {bookmarks} : {}),
        ...(shapes ? {shapes} : {}),
        ...(markup ? {markup} : {}),
        ...(placedImages.length > 0 ? {placedImages} : {}),
    };
}

function assertPersistenceData(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength === 0) {
        throw new Error(`${fieldName} must not be empty`);
    }
    return value;
}

function isPdfValidationResult(value: unknown): value is TPdfValidationResult {
    return isRecord(value)
        && typeof value.isValid === 'boolean'
        && (value.tool === 'qpdf' || value.tool === 'browser' || value.tool === 'native')
        && Array.isArray(value.errors)
        && value.errors.every(error => typeof error === 'string')
        && Array.isArray(value.warnings)
        && value.warnings.every(warning => typeof warning === 'string');
}

function parsePdfPersistenceMessage(value: unknown): TPdfPersistenceMessage | null {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return null;
    }
    if (value.type === 'result' && isPdfValidationResult(value.validation)) {
        return {
            type: 'result',
            path: typeof value.path === 'string' ? value.path : null,
            validation: value.validation,
        };
    }
    if (value.type === 'error') {
        const errorMessage: IPdfPersistenceErrorMessage = {type: 'error'};
        if (typeof value.error === 'string') {
            errorMessage.error = value.error;
        }
        return errorMessage;
    }
    if (value.type === 'ready') {
        return {type: 'ready'};
    }
    if (value.type === 'ack' && typeof value.seq === 'number') {
        return {
            type: 'ack',
            seq: value.seq,
        };
    }
    return null;
}

function getPdfPersistenceErrorMessage(payload: IPdfPersistenceErrorMessage) {
    return typeof payload.error === 'string' ? payload.error : 'PDF persistence failed';
}

function waitForPortStreamResult(port: MessagePort) {
    return new Promise<ISerializedPdfPersistencePortResult>((resolve, reject) => {
        const handleMessage = (event: MessageEvent<unknown>) => {
            const payload = parsePdfPersistenceMessage(event.data);
            if (!payload) {
                return;
            }
            if (payload.type === 'result') {
                resolve({
                    path: payload.path,
                    validation: payload.validation,
                });
                return;
            }
            if (payload.type === 'error') {
                reject(new Error(getPdfPersistenceErrorMessage(payload)));
            }
        };
        port.addEventListener('message', handleMessage);
    });
}

function waitForPortReady(port: MessagePort) {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            port.removeEventListener('message', handleMessage);
            reject(new Error('PDF persistence port did not become ready'));
        }, PDF_PERSISTENCE_READY_TIMEOUT_MS);
        const handleMessage = (event: MessageEvent<unknown>) => {
            const payload = parsePdfPersistenceMessage(event.data);
            if (!payload) {
                return;
            }
            if (payload.type === 'ready') {
                clearTimeout(timeout);
                port.removeEventListener('message', handleMessage);
                resolve();
                return;
            }
            if (payload.type === 'error') {
                clearTimeout(timeout);
                port.removeEventListener('message', handleMessage);
                reject(new Error(getPdfPersistenceErrorMessage(payload)));
            }
        };
        port.addEventListener('message', handleMessage);
    });
}

function waitForPortAck(port: MessagePort, expectedSeq: number) {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            port.removeEventListener('message', handleMessage);
            reject(new Error(`PDF persistence chunk ${expectedSeq} was not acknowledged`));
        }, PDF_PERSISTENCE_ACK_TIMEOUT_MS);
        const handleMessage = (event: MessageEvent<unknown>) => {
            const payload = parsePdfPersistenceMessage(event.data);
            if (!payload) {
                return;
            }
            if (payload.type === 'ack') {
                if (payload.seq !== expectedSeq) {
                    return;
                }
                clearTimeout(timeout);
                port.removeEventListener('message', handleMessage);
                resolve();
                return;
            }
            if (payload.type === 'error') {
                clearTimeout(timeout);
                port.removeEventListener('message', handleMessage);
                reject(new Error(getPdfPersistenceErrorMessage(payload)));
            }
        };
        port.addEventListener('message', handleMessage);
    });
}

async function streamPdfBytesToPersistencePort(
    ipcRenderer: Pick<IpcRenderer, 'postMessage'>,
    sessionId: string,
    data: Uint8Array,
) {
    const channel = new MessageChannel();
    channel.port1.start();
    try {
        const resultPromise = waitForPortStreamResult(channel.port1);
        ipcRenderer.postMessage(DOCUMENTS_CHANNELS.fileSavePdfDataPort, sessionId, [channel.port2]);
        await waitForPortReady(channel.port1);

        let seq = 0;
        const inFlightAcks: Array<Promise<void>> = [];
        for (let offset = 0; offset < data.byteLength; offset += PDF_PERSISTENCE_CHUNK_BYTES) {
            const end = Math.min(offset + PDF_PERSISTENCE_CHUNK_BYTES, data.byteLength);
            const bytes = data.slice(offset, end);
            channel.port1.postMessage({
                type: 'chunk',
                seq,
                bytes,
            });
            inFlightAcks.push(waitForPortAck(channel.port1, seq));
            if (inFlightAcks.length >= PDF_PERSISTENCE_MAX_IN_FLIGHT_CHUNKS) {
                await inFlightAcks.shift();
            }
            seq += 1;
        }
        await Promise.all(inFlightAcks);

        channel.port1.postMessage({ type: 'complete' });
        return await resultPromise;
    } finally {
        channel.port1.close();
    }
}

export function createDocumentsPreloadFileClient(
    ipcRenderer: Pick<IpcRenderer, 'invoke' | 'postMessage'>,
): TDocumentsPreloadFileClient {
    const invoke = createTypedIpcInvoker<IDocumentsInvokeMap>(ipcRenderer);
    const openDocumentDialog = () => invoke(DOCUMENTS_CHANNELS.openDocumentDialog);
    const openDocumentDirect = (path: string) => invoke(DOCUMENTS_CHANNELS.openDocumentDirect, path);
    const openDocumentDirectBatch = (paths: string[], requestId?: string) =>
        invoke(DOCUMENTS_CHANNELS.openDocumentDirectBatch, paths, requestId);

    return {
        openDocumentDialog,
        openPdfDialog: openDocumentDialog,
        openCombineDialog: () => invoke(DOCUMENTS_CHANNELS.openCombineDialog),
        openFolderDialog: () => invoke(DOCUMENTS_CHANNELS.openFolderDialog),
        openImageDialog: () => invoke(DOCUMENTS_CHANNELS.openImageDialog),
        openDocumentDirect,
        openPdfDirect: openDocumentDirect,
        openDocumentDirectBatch,
        openPdfDirectBatch: openDocumentDirectBatch,
        savePdfAs: (workingPath) => invoke(DOCUMENTS_CHANNELS.savePdfAs, workingPath),
        savePdfDataAs: async (workingPath, data) => {
            const checkedWorkingPath = assertAbsolutePath(workingPath, 'savePdfDataAs.workingPath');
            const checkedData = assertPersistenceData(data, 'savePdfDataAs.data');
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.savePdfDataAsBegin,
                checkedWorkingPath,
                checkedData.byteLength,
            );
            if (!beginResult.sessionId) {
                return {
                    path: null,
                    validation: null,
                };
            }

            return streamPdfBytesToPersistencePort(ipcRenderer, beginResult.sessionId, checkedData);
        },
        savePdfDialog: (suggestedName) => invoke(DOCUMENTS_CHANNELS.savePdfDialog, suggestedName),
        saveDocxAs: (workingPath) => invoke(DOCUMENTS_CHANNELS.saveDocxAs, workingPath),
        readFile: (path) => invoke(DOCUMENTS_CHANNELS.fileRead, path),
        statFile: (path) => invoke(DOCUMENTS_CHANNELS.fileStat, path),
        readFileRange: (path, offset, length) =>
            invoke(DOCUMENTS_CHANNELS.fileReadRange, path, offset, length),
        readTextFile: (path) => invoke(DOCUMENTS_CHANNELS.fileReadText, path),
        fileExists: (path) => invoke(DOCUMENTS_CHANNELS.fileExists, path),
        analyzePdfConformance: (path) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfAnalyzeConformance,
                assertAbsolutePath(path, 'analyzePdfConformance.path'),
            ),
        validatePdfData: (data, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfValidateData,
                assertWriteData(data, 'validatePdfData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'validatePdfData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        validatePdfPath: (path) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfValidatePath,
                assertAbsolutePath(path, 'validatePdfPath.path'),
            ),
        openPdfInDefaultAppData: (data, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfOpenInDefaultAppData,
                assertWriteData(data, 'openPdfInDefaultAppData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'openPdfInDefaultAppData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        openPdfInDefaultAppPath: (path, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfOpenInDefaultAppPath,
                assertAbsolutePath(path, 'openPdfInDefaultAppPath.path'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'openPdfInDefaultAppPath.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        printPdfData: (data, fileName?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfPrintData,
                assertWriteData(data, 'printPdfData.data'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'printPdfData.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
            ),
        printPdfPath: (path, fileName?: string, pageNumbers?: number[]) =>
            invoke(
                DOCUMENTS_CHANNELS.pdfPrintPath,
                assertAbsolutePath(path, 'printPdfPath.path'),
                typeof fileName === 'string'
                    ? assertNonEmptyString(fileName, 'printPdfPath.fileName', MAX_IPC_FILE_NAME_LENGTH)
                    : undefined,
                Array.isArray(pageNumbers)
                    ? pageNumbers.map((pageNumber, index) => assertPositiveInteger(pageNumber, `printPdfPath.pageNumbers[${index}]`))
                    : undefined,
            ),
        writeFile: (path, data) =>
            invoke(
                DOCUMENTS_CHANNELS.fileWrite,
                assertAbsolutePath(path, 'writeFile.path'),
                assertWriteData(data, 'writeFile.data'),
            ),
        replaceWorkingCopyFromPath: (workingCopyPath, sourcePath) =>
            invoke(
                DOCUMENTS_CHANNELS.fileReplaceWorkingCopyFromPath,
                assertAbsolutePath(workingCopyPath, 'replaceWorkingCopyFromPath.workingCopyPath'),
                assertAbsolutePath(sourcePath, 'replaceWorkingCopyFromPath.sourcePath'),
            ),
        writeDocxFile: (path, data) =>
            invoke(
                DOCUMENTS_CHANNELS.fileWriteDocx,
                assertAbsolutePath(path, 'writeDocxFile.path'),
                assertWriteData(data, 'writeDocxFile.data'),
            ),
        createWorkingCopyFromData: (fileName, data, originalPath?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromData,
                assertWorkingCopyFileName(fileName, 'createWorkingCopyFromData.fileName'),
                assertWriteData(data, 'createWorkingCopyFromData.data'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromData.originalPath'),
            ),
        createWorkingCopyFromPath: (sourcePath, originalPath?: string) =>
            invoke(
                DOCUMENTS_CHANNELS.createWorkingCopyFromPath,
                assertAbsolutePath(sourcePath, 'createWorkingCopyFromPath.sourcePath'),
                assertOptionalAbsolutePath(originalPath, 'createWorkingCopyFromPath.originalPath'),
            ),
        saveFile: (path) => invoke(DOCUMENTS_CHANNELS.fileSave, path),
        savePdfData: async (path, data) => {
            const checkedPath = assertAbsolutePath(path, 'savePdfData.path');
            const checkedData = assertPersistenceData(data, 'savePdfData.data');
            const beginResult = await invoke(
                DOCUMENTS_CHANNELS.fileSavePdfDataBegin,
                checkedPath,
                checkedData.byteLength,
            );
            const result = await streamPdfBytesToPersistencePort(ipcRenderer, beginResult.sessionId, checkedData);
            return result.validation;
        },
        savePdfNoteTextUpdates: (path, updates, modifiedAt) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNoteTextUpdates,
                assertAbsolutePath(path, 'savePdfNoteTextUpdates.path'),
                assertPdfNoteTextUpdates(updates, 'savePdfNoteTextUpdates.updates'),
                assertPdfDateString(modifiedAt, 'savePdfNoteTextUpdates.modifiedAt'),
            ),
        savePdfNoteChanges: (path, changes, modifiedAt) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNoteChanges,
                assertAbsolutePath(path, 'savePdfNoteChanges.path'),
                assertPdfNativeNoteChanges(changes, 'savePdfNoteChanges.changes'),
                assertPdfDateString(modifiedAt, 'savePdfNoteChanges.modifiedAt'),
            ),
        savePdfNativeMutations: (path, mutations, modifiedAt) =>
            invoke(
                DOCUMENTS_CHANNELS.fileSavePdfNativeMutations,
                assertAbsolutePath(path, 'savePdfNativeMutations.path'),
                assertPdfNativeMutationSet(mutations, 'savePdfNativeMutations.mutations'),
                assertPdfDateString(modifiedAt, 'savePdfNativeMutations.modifiedAt'),
            ),
        applyPdfNativeMutationsToWorkingCopy: (path, mutations, modifiedAt, expectedBase) =>
            invoke(
                DOCUMENTS_CHANNELS.fileApplyPdfNativeMutationsToWorkingCopy,
                assertAbsolutePath(path, 'applyPdfNativeMutationsToWorkingCopy.path'),
                assertPdfNativeMutationSet(mutations, 'applyPdfNativeMutationsToWorkingCopy.mutations'),
                assertPdfDateString(modifiedAt, 'applyPdfNativeMutationsToWorkingCopy.modifiedAt'),
                assertPdfNativeWorkingCopyExpectation(expectedBase, 'applyPdfNativeMutationsToWorkingCopy.expectedBase'),
            ),
        cleanupFile: (path) => invoke(DOCUMENTS_CHANNELS.fileCleanup, path),
        cleanupOcrTemp: (path) => invoke(DOCUMENTS_CHANNELS.fileCleanupOcrTemp, path),
        setWindowTitle: (title) => invoke(DOCUMENTS_CHANNELS.windowSetTitle, title),
        showItemInFolder: (path) => invoke(DOCUMENTS_CHANNELS.shellShowItemInFolder, path),
        recentFiles: {
            get: () => invoke(DOCUMENTS_CHANNELS.recentFilesGet),
            remove: (path) => invoke(DOCUMENTS_CHANNELS.recentFilesRemove, path),
            clear: () => invoke(DOCUMENTS_CHANNELS.recentFilesClear),
        },
    };
}
