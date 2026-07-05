import type {
    Merge,
    SetRequired,
    Simplify,
} from 'type-fest';
import type {
    IPdfNativeAnnotationDelete,
    IPdfNativeBookmarksMutation,
    IPdfNativeFreeTextNote,
    IPdfNativeFreeTextNoteMarkerRect,
    IPdfNativeMarkupMarkerRect,
    IPdfNativeMarkupSubtypeHint,
    IPdfNativeMutationSet,
    IPdfNativeNoteChanges,
    IPdfNativePageLabelRange,
    IPdfNativePageLabelsMutation,
    IPdfNativePlacedImage,
    IPdfNativeShapeAnnotation,
    IPdfNativeShapePoint,
    IPdfNativeShapesMutation,
    IPdfNativeWorkingCopyExpectation,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import {
    PDF_ANNOTATION_LINE_END_STYLES,
    PDF_ANNOTATION_MARKUP_SUBTYPES,
    PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    PDF_ANNOTATION_SHAPE_TYPES,
} from '@contracts/annotations';
import {
    isPdfNativeNormalizedBoxInsidePageBounds,
    isPdfNativeNormalizedRectInsidePageBounds,
} from '@contracts/nativePdfPageBounds';
import { toPageIndex } from '@contracts/pageNumbers';
import { PDF_PAGE_LABEL_STYLE_VALUES } from '@contracts/pdfPageLabels';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

export const PDF_NATIVE_MUTATION_LIMITS = {
    noteTextUpdates: 256,
    noteChanges: 256,
    pageLabelRanges: 2_048,
    bookmarkItems: 5_000,
    bookmarkDepth: 64,
    shapes: 4_096,
    shapeDeletedItems: 4_096,
    shapePoints: 20_000,
    shapeTextLength: 2_048,
    markupItems: 4_096,
    markupTextLength: 2_048,
    placedImages: 16,
    placedImageBytes: 128 * 1024 * 1024,
    placedImagesTotalBytes: 512 * 1024 * 1024,
} as const;

export const PDF_NATIVE_MUTATION_ENUM_VALUES = {
    pageLabelStyles: PDF_PAGE_LABEL_STYLE_VALUES,
    shapeTypes: PDF_ANNOTATION_SHAPE_TYPES,
    shapePdfSubtypes: PDF_ANNOTATION_SHAPE_PDF_SUBTYPES,
    shapeLineEndStyles: PDF_ANNOTATION_LINE_END_STYLES,
    markupSubtypes: PDF_ANNOTATION_MARKUP_SUBTYPES,
} as const;

export const PDF_NATIVE_DATE_PATTERN = /^D:\d{14}(?:Z|[+-]\d{2}'\d{2}')?$/u;
export const PDF_NATIVE_SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/iu;

type TPdfNativeValidationErrorKind = 'typeError' | 'error';
type TPdfNativePlacedImageBytesMode = 'uint8Array' | 'numberArray';
type TPdfNativePlacedImageBytes<TMode extends TPdfNativePlacedImageBytesMode> = TMode extends 'numberArray'
    ? number[]
    : Uint8Array;
type TPdfNativePlacedImageForMode<TMode extends TPdfNativePlacedImageBytesMode> = Simplify<
    Merge<
        SetRequired<IPdfNativePlacedImage, 'rotationDegrees'>,
        {bytes: TPdfNativePlacedImageBytes<TMode>;}
    >
>;

export interface IPdfNativePlacedImageNativeToolPayload extends TPdfNativePlacedImageForMode<'numberArray'> {}

export type TPdfNativeMutationSetNativeToolPayload = Simplify<
    Merge<IPdfNativeMutationSet, {placedImages?: IPdfNativePlacedImageNativeToolPayload[];}>
>;

export interface IPdfNativeValidationOptions {errorKind?: TPdfNativeValidationErrorKind;}

interface IPdfNativeNoteTextUpdateValidationOptions extends IPdfNativeValidationOptions {allowEmpty?: boolean;}

interface IPdfNativeMutationSetValidationOptions extends IPdfNativeValidationOptions {placedImageBytes?: TPdfNativePlacedImageBytesMode;}

interface IPdfNativeMutationSetUint8ArrayValidationOptions extends IPdfNativeValidationOptions {placedImageBytes?: 'uint8Array';}

interface IPdfNativeMutationSetNumberArrayValidationOptions extends IPdfNativeValidationOptions {placedImageBytes: 'numberArray';}

interface IPdfNativeBookmarkState {
    count: number;
    depth: number;
}

interface IPdfNativeShapePointState {count: number;}

interface IPdfNativePlacedImageByteState {totalBytes: number;}

function createValidationError(message: string, options: IPdfNativeValidationOptions = {}) {
    return options.errorKind === 'error'
        ? new Error(message)
        : new TypeError(message);
}

function fail(message: string, options: IPdfNativeValidationOptions = {}): never {
    throw createValidationError(message, options);
}

function normalizePositiveInteger(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        fail(`${label} must be a positive integer`, options);
    }
    return value;
}

function normalizeFiniteUnitNumber(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        fail(`${label} must be a finite number from 0 to 1`, options);
    }
    return value;
}

function normalizeFiniteNonNegativeNumber(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(`${label} must be a finite non-negative number`, options);
    }
    return value;
}

function normalizeOptionalFiniteUnitNumber(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    return normalizeFiniteUnitNumber(value, label, options);
}

function normalizeOptionalString(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        fail(`${label} must be a string or null`, options);
    }
    return value;
}

function normalizeNativeShapeOptionalString(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    const normalized = normalizeOptionalString(value, label, options);
    if (normalized !== null && normalized.length > PDF_NATIVE_MUTATION_LIMITS.shapeTextLength) {
        fail(`${label} is too long`, options);
    }
    return normalized;
}

function normalizeOptionalTimestamp(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        fail(`${label} must be a finite positive timestamp or null`, options);
    }
    return Math.trunc(value);
}

function normalizeNativeMarkerRect(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeFreeTextNoteMarkerRect {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const left = normalizeFiniteUnitNumber(value.left, `${label}.left`, options);
    const top = normalizeFiniteUnitNumber(value.top, `${label}.top`, options);
    const width = normalizeFiniteUnitNumber(value.width, `${label}.width`, options);
    const height = normalizeFiniteUnitNumber(value.height, `${label}.height`, options);
    if (!isPdfNativeNormalizedRectInsidePageBounds({
        left,
        top,
        width,
        height,
    })) {
        fail(`${label} must fit inside the normalized page bounds`, options);
    }
    return {
        left,
        top,
        width,
        height,
    };
}

function normalizeFreeTextNoteMarkerRect(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeFreeTextNoteMarkerRect {
    return normalizeNativeMarkerRect(value, label, options);
}

function normalizeMarkupMarkerRect(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeMarkupMarkerRect {
    return normalizeNativeMarkerRect(value, label, options);
}

function normalizeFreeTextNotes(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.noteChanges) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.noteChanges} notes`, options);
    }

    return Array.from(value, (note, index): IPdfNativeFreeTextNote => {
        if (!isRecord(note)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        if (
            typeof note.pageIndex !== 'number'
            || !Number.isSafeInteger(note.pageIndex)
            || note.pageIndex < 0
        ) {
            fail(`${label}[${index}].pageIndex must be a non-negative safe integer`, options);
        }
        const stableKey = typeof note.stableKey === 'string' ? note.stableKey.trim() : '';
        if (!stableKey) {
            fail(`${label}[${index}].stableKey must be a non-empty string`, options);
        }
        if (typeof note.text !== 'string') {
            fail(`${label}[${index}].text must be a string`, options);
        }
        return {
            pageIndex: toPageIndex(note.pageIndex),
            stableKey,
            text: note.text,
            markerRect: normalizeFreeTextNoteMarkerRect(note.markerRect, `${label}[${index}].markerRect`, options),
            author: normalizeOptionalString(note.author, `${label}[${index}].author`, options),
            color: normalizeOptionalString(note.color, `${label}[${index}].color`, options),
            createdAt: normalizeOptionalTimestamp(note.createdAt, `${label}[${index}].createdAt`, options),
        };
    });
}

function normalizeAnnotationDeletes(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.noteChanges) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.noteChanges} deletes`, options);
    }

    return Array.from(value, (item, index): IPdfNativeAnnotationDelete => {
        if (!isRecord(item)) {
            fail(`${label}[${index}] must be an object`, options);
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
            fail(`${label}[${index}] must contain a valid pageIndex and either a PDF object ref or stableKey`, options);
        }
        const normalizedDelete = {
            pageIndex: toPageIndex(item.pageIndex),
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

function normalizeOptionalPdfNativeNoteTextUpdates(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    return normalizePdfNativeNoteTextUpdates(value, label, {
        ...options,
        allowEmpty: true,
    });
}

function normalizePageLabelRange(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativePageLabelRange {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const startPage = value.startPage;
    const style = value.style;
    const prefix = value.prefix;
    const startNumber = value.startNumber;
    if (typeof startPage !== 'number' || !Number.isSafeInteger(startPage) || startPage < 1) {
        fail(`${label}.startPage must be a positive safe integer`, options);
    }
    if (style !== null && !isOneOf(PDF_NATIVE_MUTATION_ENUM_VALUES.pageLabelStyles, style)) {
        fail(`${label}.style must be a valid PDF page-label style or null`, options);
    }
    if (typeof prefix !== 'string') {
        fail(`${label}.prefix must be a string`, options);
    }
    if (typeof startNumber !== 'number' || !Number.isSafeInteger(startNumber) || startNumber < 1) {
        fail(`${label}.startNumber must be a positive safe integer`, options);
    }
    return {
        startPage,
        style,
        prefix,
        startNumber,
    };
}

function normalizePageLabelsMutation(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativePageLabelsMutation {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const totalPages = normalizePositiveInteger(value.totalPages, `${label}.totalPages`, options);
    if (!Array.isArray(value.ranges) || value.ranges.length > PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges) {
        fail(`${label}.ranges must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.pageLabelRanges} ranges`, options);
    }
    return {
        totalPages,
        ranges: Array.from(value.ranges, (range, index) =>
            normalizePageLabelRange(range, `${label}.ranges[${index}]`, options)),
    };
}

function normalizeBookmarkColor(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
        fail(`${label} must be a #RRGGBB color string or null`, options);
    }
    return value.toLowerCase();
}

function normalizeBookmarkItems(
    value: unknown,
    label: string,
    state: IPdfNativeBookmarkState,
    options: IPdfNativeValidationOptions,
): IPdfBookmarkEntry[] {
    if (!Array.isArray(value)) {
        fail(`${label} must be an array`, options);
    }
    if (state.depth > PDF_NATIVE_MUTATION_LIMITS.bookmarkDepth) {
        fail(`${label} exceeds the maximum bookmark depth`, options);
    }
    return Array.from(value, (item, index): IPdfBookmarkEntry => {
        state.count += 1;
        if (state.count > PDF_NATIVE_MUTATION_LIMITS.bookmarkItems) {
            fail(`bookmark mutations must include at most ${PDF_NATIVE_MUTATION_LIMITS.bookmarkItems} items`, options);
        }
        if (!isRecord(item)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        const title = item.title;
        if (typeof title !== 'string') {
            fail(`${label}[${index}].title must be a string`, options);
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
            fail(`${label}[${index}].pageIndex must be a non-negative safe integer or null`, options);
        }
        const namedDest = item.namedDest;
        if (namedDest !== null && typeof namedDest !== 'string') {
            fail(`${label}[${index}].namedDest must be a string or null`, options);
        }
        const pageYRatio = item.pageYRatio;
        if (
            pageYRatio !== undefined
            && pageYRatio !== null
            && (
                typeof pageYRatio !== 'number'
                || !Number.isFinite(pageYRatio)
                || pageYRatio < 0
                || pageYRatio > 1
            )
        ) {
            fail(`${label}[${index}].pageYRatio must be a finite number from 0 to 1 or null`, options);
        }
        const previousDepth = state.depth;
        state.depth = previousDepth + 1;
        let items: IPdfBookmarkEntry[];
        try {
            items = normalizeBookmarkItems(item.items, `${label}[${index}].items`, state, options);
        } finally {
            state.depth = previousDepth;
        }
        if (state.count > PDF_NATIVE_MUTATION_LIMITS.bookmarkItems) {
            fail(`bookmark mutations must include at most ${PDF_NATIVE_MUTATION_LIMITS.bookmarkItems} items`, options);
        }
        return {
            title,
            pageIndex: pageIndex,
            pageYRatio: typeof pageYRatio === 'number' ? pageYRatio : null,
            namedDest: namedDest,
            bold: item.bold === true,
            italic: item.italic === true,
            color: normalizeBookmarkColor(item.color, `${label}[${index}].color`, options),
            items,
        };
    });
}

function normalizeBookmarksMutation(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeBookmarksMutation {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    return {
        totalPages: normalizePositiveInteger(value.totalPages, `${label}.totalPages`, options),
        untitledLabel: typeof value.untitledLabel === 'string' ? value.untitledLabel : '',
        items: normalizeBookmarkItems(value.items, `${label}.items`, {
            count: 0,
            depth: 0,
        }, options),
    };
}

function normalizeShapePoint(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeShapePoint {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    return {
        x: normalizeFiniteUnitNumber(value.x, `${label}.x`, options),
        y: normalizeFiniteUnitNumber(value.y, `${label}.y`, options),
    };
}

function normalizeShapePoints(
    value: unknown,
    label: string,
    state: IPdfNativeShapePointState,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        fail(`${label} must be an array`, options);
    }
    state.count += value.length;
    if (state.count > PDF_NATIVE_MUTATION_LIMITS.shapePoints) {
        fail(`shape mutations must include at most ${PDF_NATIVE_MUTATION_LIMITS.shapePoints} points`, options);
    }
    return Array.from(value, (point, index) => normalizeShapePoint(point, `${label}[${index}]`, options));
}

function normalizeShapeStrokes(
    value: unknown,
    label: string,
    state: IPdfNativeShapePointState,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)) {
        fail(`${label} must be an array`, options);
    }
    return Array.from(value, (points, index) => normalizeShapePoints(points, `${label}[${index}]`, state, options) ?? []);
}

function normalizeShapeEnum<T extends string>(
    value: unknown,
    label: string,
    allowed: readonly T[],
    options: IPdfNativeValidationOptions,
): T;
function normalizeShapeEnum<T extends string>(
    value: unknown,
    label: string,
    allowed: readonly T[],
    options: IPdfNativeValidationOptions & { optional: true },
): T | null;
function normalizeShapeEnum<T extends string>(
    value: unknown,
    label: string,
    allowed: readonly T[],
    options: IPdfNativeValidationOptions & { optional?: boolean },
): T | null {
    if (value === undefined || value === null) {
        if (options.optional) {
            return null;
        }
        fail(`${label} is required`, options);
    }
    if (!isOneOf(allowed, value)) {
        fail(`${label} is not a supported value`, options);
    }
    return value;
}

function normalizeShapeAnnotation(
    value: unknown,
    label: string,
    state: IPdfNativeShapePointState,
    options: IPdfNativeValidationOptions,
): IPdfNativeShapeAnnotation {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const type = normalizeShapeEnum(value.type, `${label}.type`, PDF_NATIVE_MUTATION_ENUM_VALUES.shapeTypes, options);
    const pageIndex = value.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        fail(`${label}.pageIndex must be a non-negative safe integer`, options);
    }
    const color = value.color;
    if (typeof color !== 'string' || color.length > PDF_NATIVE_MUTATION_LIMITS.shapeTextLength) {
        fail(`${label}.color must be a color string`, options);
    }
    const opacity = value.opacity;
    if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
        fail(`${label}.opacity must be a finite number from 0 to 1`, options);
    }
    const id = normalizeNativeShapeOptionalString(value.id, `${label}.id`, options);
    const points = normalizeShapePoints(value.points, `${label}.points`, state, options);
    const strokes = normalizeShapeStrokes(value.strokes, `${label}.strokes`, state, options);
    const shape: IPdfNativeShapeAnnotation = {
        type,
        pageIndex: toPageIndex(pageIndex),
        x: normalizeFiniteUnitNumber(value.x, `${label}.x`, options),
        y: normalizeFiniteUnitNumber(value.y, `${label}.y`, options),
        width: normalizeFiniteNonNegativeNumber(value.width, `${label}.width`, options),
        height: normalizeFiniteNonNegativeNumber(value.height, `${label}.height`, options),
        x2: normalizeOptionalFiniteUnitNumber(value.x2, `${label}.x2`, options),
        y2: normalizeOptionalFiniteUnitNumber(value.y2, `${label}.y2`, options),
        color,
        fillColor: normalizeNativeShapeOptionalString(value.fillColor, `${label}.fillColor`, options),
        opacity,
        strokeWidth: normalizeFiniteNonNegativeNumber(value.strokeWidth, `${label}.strokeWidth`, options),
        annotationId: normalizeNativeShapeOptionalString(value.annotationId, `${label}.annotationId`, options),
        stableKey: normalizeNativeShapeOptionalString(value.stableKey, `${label}.stableKey`, options),
        pdfSubtype: normalizeShapeEnum(
            value.pdfSubtype,
            `${label}.pdfSubtype`,
            PDF_NATIVE_MUTATION_ENUM_VALUES.shapePdfSubtypes,
            {
                ...options,
                optional: true,
            },
        ),
        lineStartStyle: normalizeShapeEnum(
            value.lineStartStyle,
            `${label}.lineStartStyle`,
            PDF_NATIVE_MUTATION_ENUM_VALUES.shapeLineEndStyles,
            {
                ...options,
                optional: true,
            },
        ),
        lineEndStyle: normalizeShapeEnum(
            value.lineEndStyle,
            `${label}.lineEndStyle`,
            PDF_NATIVE_MUTATION_ENUM_VALUES.shapeLineEndStyles,
            {
                ...options,
                optional: true,
            },
        ),
        createdAt: normalizeOptionalTimestamp(value.createdAt, `${label}.createdAt`, options),
        modifiedAt: normalizeOptionalTimestamp(value.modifiedAt, `${label}.modifiedAt`, options),
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

function normalizeStringArray(
    value: unknown,
    label: string,
    maxItems: number,
    maxTextLength: number,
    options: IPdfNativeValidationOptions,
) {
    if (!Array.isArray(value) || value.length > maxItems) {
        fail(`${label} must be an array with at most ${maxItems} items`, options);
    }
    return Array.from(value, (item, index) => {
        if (typeof item !== 'string' || item.length > maxTextLength) {
            fail(`${label}[${index}] must be a string`, options);
        }
        return item.trim();
    }).filter(item => item.length > 0);
}

function normalizeMarkupSubtype(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (!isOneOf(PDF_NATIVE_MUTATION_ENUM_VALUES.markupSubtypes, value)) {
        fail(`${label} must be a supported text-markup subtype`, options);
    }
    return value;
}

function normalizeMarkupOptionalString(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    const normalized = normalizeOptionalString(value, label, options);
    if (normalized !== null && normalized.length > PDF_NATIVE_MUTATION_LIMITS.markupTextLength) {
        fail(`${label} is too long`, options);
    }
    return normalized;
}

function normalizeMarkupOptionalIndex(value: unknown, label: string, options: IPdfNativeValidationOptions) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        fail(`${label} must be a non-negative safe integer or null`, options);
    }
    return value;
}

function normalizeMarkupOverride(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
) {
    if (!Array.isArray(value) || value.length !== 2) {
        fail(`${label} must be an [annotationId, subtype] tuple`, options);
    }
    const tuple: unknown[] = value;
    const [
        annotationId,
        subtype,
    ] = tuple;
    if (
        typeof annotationId !== 'string'
        || annotationId.trim().length === 0
        || annotationId.length > PDF_NATIVE_MUTATION_LIMITS.markupTextLength
    ) {
        fail(`${label}[0] must be a bounded annotation id`, options);
    }
    return [
        annotationId.trim(),
        normalizeMarkupSubtype(subtype, `${label}[1]`, options),
    ] as const;
}

function normalizeMarkupHint(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeMarkupSubtypeHint {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const pageIndex = value.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        fail(`${label}.pageIndex must be a non-negative safe integer`, options);
    }
    return {
        subtype: normalizeMarkupSubtype(value.subtype, `${label}.subtype`, options),
        pageIndex: toPageIndex(pageIndex),
        markerRect: normalizeMarkupMarkerRect(value.markerRect, `${label}.markerRect`, options),
        annotationId: normalizeMarkupOptionalString(value.annotationId, `${label}.annotationId`, options),
        color: normalizeMarkupOptionalString(value.color, `${label}.color`, options),
        id: normalizeMarkupOptionalString(value.id, `${label}.id`, options),
        pageMarkupIndex: normalizeMarkupOptionalIndex(value.pageMarkupIndex, `${label}.pageMarkupIndex`, options),
        source: normalizeMarkupOptionalString(value.source, `${label}.source`, options),
    };
}

function normalizeMarkupMutation(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): NonNullable<IPdfNativeMutationSet['markup']> {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    if (!Array.isArray(value.overrides) || value.overrides.length > PDF_NATIVE_MUTATION_LIMITS.markupItems) {
        fail(`${label}.overrides must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.markupItems} items`, options);
    }
    if (!Array.isArray(value.hints) || value.hints.length > PDF_NATIVE_MUTATION_LIMITS.markupItems) {
        fail(`${label}.hints must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.markupItems} items`, options);
    }
    const overrides = Array.from(value.overrides, (override, index) =>
        normalizeMarkupOverride(override, `${label}.overrides[${index}]`, options));
    const hints = Array.from(value.hints, (hint, index) =>
        normalizeMarkupHint(hint, `${label}.hints[${index}]`, options));
    if (overrides.length + hints.length === 0) {
        fail(`${label} must include at least one text-markup rewrite`, options);
    }
    return {
        overrides,
        hints,
    };
}

function normalizePlacedImageBytesAsUint8Array(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): {
    bytes: Uint8Array;
    byteLength: number;
} {
    if (
        !(value instanceof Uint8Array)
        || value.byteLength === 0
        || value.byteLength > PDF_NATIVE_MUTATION_LIMITS.placedImageBytes
    ) {
        fail(`${label} must be a non-empty Uint8Array`, options);
    }

    return {
        bytes: value,
        byteLength: value.byteLength,
    };
}

function normalizePlacedImageBytesAsNumberArray(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): {
    bytes: number[];
    byteLength: number;
} {
    if (value instanceof Uint8Array) {
        if (value.byteLength === 0 || value.byteLength > PDF_NATIVE_MUTATION_LIMITS.placedImageBytes) {
            fail(`${label} must be non-empty image bytes`, options);
        }
        return {
            bytes: Array.from(value),
            byteLength: value.byteLength,
        };
    }

    if (Array.isArray(value)) {
        if (value.length === 0 || value.length > PDF_NATIVE_MUTATION_LIMITS.placedImageBytes) {
            fail(`${label} must be non-empty image bytes`, options);
        }
        const bytes = Array.from(value, (byte, byteIndex) => {
            if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
                fail(`${label}[${byteIndex}] must be an integer byte`, options);
            }
            return byte;
        });
        return {
            bytes,
            byteLength: bytes.length,
        };
    }

    fail(`${label} must be non-empty image bytes`, options);
}

function normalizePlacedImage(
    value: unknown,
    label: string,
    mode: TPdfNativePlacedImageBytesMode,
    byteState: IPdfNativePlacedImageByteState,
    options: IPdfNativeValidationOptions,
): SetRequired<IPdfNativePlacedImage, 'rotationDegrees'> | IPdfNativePlacedImageNativeToolPayload {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const pageIndex = value.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        fail(`${label}.pageIndex must be a non-negative safe integer`, options);
    }
    const x = normalizeFiniteUnitNumber(value.x, `${label}.x`, options);
    const y = normalizeFiniteUnitNumber(value.y, `${label}.y`, options);
    const width = normalizeFiniteUnitNumber(value.width, `${label}.width`, options);
    const height = normalizeFiniteUnitNumber(value.height, `${label}.height`, options);
    if (!isPdfNativeNormalizedBoxInsidePageBounds({
        x,
        y,
        width,
        height,
    })) {
        fail(`${label} must fit inside the normalized page bounds`, options);
    }
    const rotationDegrees = value.rotationDegrees ?? null;
    if (
        rotationDegrees !== null
        && (typeof rotationDegrees !== 'number' || !Number.isFinite(rotationDegrees))
    ) {
        fail(`${label}.rotationDegrees must be a finite number or null`, options);
    }
    if (value.mimeType !== 'image/jpeg') {
        fail(`${label}.mimeType must be image/jpeg`, options);
    }
    const normalized = {
        pageIndex: toPageIndex(pageIndex),
        x,
        y,
        width,
        height,
        rotationDegrees,
        mimeType: 'image/jpeg' as const,
    };

    if (mode === 'uint8Array') {
        const imageBytes = normalizePlacedImageBytesAsUint8Array(value.bytes, `${label}.bytes`, options);
        byteState.totalBytes += imageBytes.byteLength;
        if (byteState.totalBytes > PDF_NATIVE_MUTATION_LIMITS.placedImagesTotalBytes) {
            fail(`placed image bytes must total at most ${PDF_NATIVE_MUTATION_LIMITS.placedImagesTotalBytes} bytes`, options);
        }
        return {
            ...normalized,
            bytes: imageBytes.bytes,
        };
    }

    const imageBytes = normalizePlacedImageBytesAsNumberArray(value.bytes, `${label}.bytes`, options);
    byteState.totalBytes += imageBytes.byteLength;
    if (byteState.totalBytes > PDF_NATIVE_MUTATION_LIMITS.placedImagesTotalBytes) {
        fail(`placed image bytes must total at most ${PDF_NATIVE_MUTATION_LIMITS.placedImagesTotalBytes} bytes`, options);
    }
    return {
        ...normalized,
        bytes: imageBytes.bytes,
    };
}

function normalizePlacedImages(
    value: unknown,
    label: string,
    mode: TPdfNativePlacedImageBytesMode,
    options: IPdfNativeValidationOptions,
) {
    if (value === undefined) {
        return [];
    }
    if (!Array.isArray(value) || value.length > PDF_NATIVE_MUTATION_LIMITS.placedImages) {
        fail(`${label} must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.placedImages} images`, options);
    }
    const byteState = {totalBytes: 0};
    return Array.from(value, (image, index) =>
        normalizePlacedImage(image, `${label}[${index}]`, mode, byteState, options));
}

function normalizeShapesMutation(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions,
): IPdfNativeShapesMutation {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    if (!Array.isArray(value.shapes) || value.shapes.length > PDF_NATIVE_MUTATION_LIMITS.shapes) {
        fail(`${label}.shapes must be an array with at most ${PDF_NATIVE_MUTATION_LIMITS.shapes} shapes`, options);
    }
    const pointState = {count: 0};
    return {
        totalPages: normalizePositiveInteger(value.totalPages, `${label}.totalPages`, options),
        rewriteShapeState: value.rewriteShapeState === true,
        shapes: Array.from(value.shapes, (shape, index) =>
            normalizeShapeAnnotation(shape, `${label}.shapes[${index}]`, pointState, options)),
        deletedAnnotationIds: normalizeStringArray(
            value.deletedAnnotationIds,
            `${label}.deletedAnnotationIds`,
            PDF_NATIVE_MUTATION_LIMITS.shapeDeletedItems,
            PDF_NATIVE_MUTATION_LIMITS.shapeTextLength,
            options,
        ),
        deletedStableKeys: normalizeStringArray(
            value.deletedStableKeys,
            `${label}.deletedStableKeys`,
            PDF_NATIVE_MUTATION_LIMITS.shapeDeletedItems,
            PDF_NATIVE_MUTATION_LIMITS.shapeTextLength,
            options,
        ),
    };
}

export function normalizePdfNativeModifiedAt(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions = {},
) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!PDF_NATIVE_DATE_PATTERN.test(normalized)) {
        fail(`${label} must be a PDF date string`, options);
    }
    return normalized;
}

export function normalizePdfNativeWorkingCopyExpectation(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions = {},
): IPdfNativeWorkingCopyExpectation {
    if (value === undefined || value === null) {
        fail(`${label} must be an object`, options);
    }
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const byteLength = value.byteLength;
    const sha256 = value.sha256;
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength <= 0) {
        fail(`${label}.byteLength must be a positive safe integer`, options);
    }
    if (typeof sha256 !== 'string' || !PDF_NATIVE_SHA256_HEX_PATTERN.test(sha256)) {
        fail(`${label}.sha256 must be a SHA-256 hex digest`, options);
    }
    return {
        byteLength,
        sha256: sha256.toLowerCase(),
    };
}

export function normalizePdfNativeNoteTextUpdates(
    value: unknown,
    label: string,
    options: IPdfNativeNoteTextUpdateValidationOptions = {},
): IPdfNoteTextUpdate[] {
    if (
        !Array.isArray(value)
        || (!options.allowEmpty && value.length === 0)
        || value.length > PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates
    ) {
        const emptyDescription = options.allowEmpty ? 'an array' : 'a non-empty array';
        fail(`${label} must be ${emptyDescription} with at most ${PDF_NATIVE_MUTATION_LIMITS.noteTextUpdates} updates`, options);
    }

    return Array.from(value, (update, index): IPdfNoteTextUpdate => {
        if (!isRecord(update)) {
            fail(`${label}[${index}] must be an object`, options);
        }
        const objectNumber = update.objectNumber;
        const generationNumber = update.generationNumber;
        const text = update.text;
        if (typeof objectNumber !== 'number' || !Number.isSafeInteger(objectNumber) || objectNumber < 1) {
            fail(`${label}[${index}].objectNumber must be a positive safe integer`, options);
        }
        if (
            typeof generationNumber !== 'number'
            || !Number.isSafeInteger(generationNumber)
            || generationNumber < 0
            || generationNumber > 65_535
        ) {
            fail(`${label}[${index}].generationNumber must be an integer from 0 to 65535`, options);
        }
        if (typeof text !== 'string') {
            fail(`${label}[${index}].text must be a string`, options);
        }
        return {
            objectNumber,
            generationNumber,
            text,
        };
    });
}

export function normalizePdfNativeNoteChanges(
    value: unknown,
    label: string,
    options: IPdfNativeValidationOptions = {},
): IPdfNativeNoteChanges {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const updates = normalizeOptionalPdfNativeNoteTextUpdates(value.updates, `${label}.updates`, options);
    const freeTextNotes = normalizeFreeTextNotes(value.freeTextNotes, `${label}.freeTextNotes`, options);
    const deletes = normalizeAnnotationDeletes(value.deletes, `${label}.deletes`, options);
    if (updates.length + freeTextNotes.length + deletes.length === 0) {
        fail(`${label} must include at least one note change`, options);
    }
    if (updates.length + freeTextNotes.length + deletes.length > PDF_NATIVE_MUTATION_LIMITS.noteChanges) {
        fail(`${label} must include at most ${PDF_NATIVE_MUTATION_LIMITS.noteChanges} note changes`, options);
    }
    return {
        ...(updates.length > 0 ? {updates} : {}),
        ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
        ...(deletes.length > 0 ? {deletes} : {}),
    };
}

export function normalizePdfNativeMutationSet(
    value: unknown,
    label: string,
    options?: IPdfNativeMutationSetUint8ArrayValidationOptions,
): IPdfNativeMutationSet;
export function normalizePdfNativeMutationSet(
    value: unknown,
    label: string,
    options: IPdfNativeMutationSetNumberArrayValidationOptions,
): TPdfNativeMutationSetNativeToolPayload;
export function normalizePdfNativeMutationSet(
    value: unknown,
    label: string,
    options: IPdfNativeMutationSetValidationOptions = {},
): IPdfNativeMutationSet | TPdfNativeMutationSetNativeToolPayload {
    if (!isRecord(value)) {
        fail(`${label} must be an object`, options);
    }
    const placedImageBytes = options.placedImageBytes ?? 'uint8Array';
    const updates = normalizeOptionalPdfNativeNoteTextUpdates(value.updates, `${label}.updates`, options);
    const freeTextNotes = normalizeFreeTextNotes(value.freeTextNotes, `${label}.freeTextNotes`, options);
    const deletes = normalizeAnnotationDeletes(value.deletes, `${label}.deletes`, options);
    const pageLabels = value.pageLabels === undefined
        ? null
        : normalizePageLabelsMutation(value.pageLabels, `${label}.pageLabels`, options);
    const bookmarks = value.bookmarks === undefined
        ? null
        : normalizeBookmarksMutation(value.bookmarks, `${label}.bookmarks`, options);
    const shapes = value.shapes === undefined
        ? null
        : normalizeShapesMutation(value.shapes, `${label}.shapes`, options);
    const markup = value.markup === undefined
        ? null
        : normalizeMarkupMutation(value.markup, `${label}.markup`, options);
    const placedImages = normalizePlacedImages(value.placedImages, `${label}.placedImages`, placedImageBytes, options);
    if (
        updates.length + freeTextNotes.length + deletes.length === 0
        && !pageLabels
        && !bookmarks
        && !shapes
        && !markup
        && placedImages.length === 0
    ) {
        fail(`${label} must include at least one native PDF mutation`, options);
    }
    if (updates.length + freeTextNotes.length + deletes.length > PDF_NATIVE_MUTATION_LIMITS.noteChanges) {
        fail(`${label} must include at most ${PDF_NATIVE_MUTATION_LIMITS.noteChanges} note changes`, options);
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
    } as IPdfNativeMutationSet | TPdfNativeMutationSetNativeToolPayload;
}
