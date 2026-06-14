import { createHash } from 'crypto';
import {
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { join } from 'path';
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
    IPdfNativeNoteTextSaveResult,
    IPdfNativeShapeAnnotation,
    IPdfNativeShapePoint,
    IPdfNativeShapesMutation,
    IPdfNativeWorkingCopyExpectation,
    IPdfNoteTextUpdate,
} from '@contracts/electronApiDocuments';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import { isErrnoException } from '@contracts/runtimeGuards';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';
import {
    isNativePageOpsDisabled,
    resolveNativePageOpsPath,
} from '@electron/features/page-ops/public';
import {
    findWorkingCopyPathByOriginalPath,
    getWorkingCopyOriginalPath,
    refreshWorkingCopyOriginalFileExpectation,
} from '@electron/file-access/workingCopyStore';
import { isAllowedOriginalSavePath } from '@electron/file-access/isAllowedOriginalSavePath';
import { ensureWorkingCopyDirectory } from '@electron/file-access/workingCopyCreation';
import {
    atomicReplace,
    makeSiblingTempPath,
} from '@electron/utils/atomicReplace';
import { enqueueWorkingCopyMutation } from '@electron/file-access/workingCopyMutationQueue';
import { copyFileCopyOnWrite } from '@electron/file-access/workingCopyDirectory';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';
import { originalPathSaveBaseMatches } from '@electron/features/documents/main/originalPathSaveBaseMatches';

const PDF_NATIVE_MUTATION_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_NATIVE_NOTE_TEXT_UPDATES = 256;
const MAX_NATIVE_NOTE_CHANGES = 256;
const MAX_NATIVE_PAGE_LABEL_RANGES = 2_048;
const MAX_NATIVE_BOOKMARK_ITEMS = 5_000;
const MAX_NATIVE_BOOKMARK_DEPTH = 64;
const MAX_NATIVE_SHAPES = 4_096;
const MAX_NATIVE_SHAPE_DELETED_ITEMS = 4_096;
const MAX_NATIVE_SHAPE_POINTS = 20_000;
const MAX_NATIVE_SHAPE_TEXT_LENGTH = 2_048;
const MAX_NATIVE_MARKUP_ITEMS = 4_096;
const MAX_NATIVE_MARKUP_TEXT_LENGTH = 2_048;
const MAX_NATIVE_PLACED_IMAGES = 16;
const MAX_NATIVE_PLACED_IMAGE_BYTES = 128 * 1024 * 1024;
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
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/iu;
const log = createLogger('native-note-text-save');

interface INativeNoteCommandOptions {
    command: 'update-note-text' | 'save-note-changes' | 'save-mutations';
    payloadFileName: string;
    payloadFlag: '--updates-file' | '--changes-file' | '--mutations-file';
    payload: unknown;
    commandLabel: string;
}

interface INativePlacedImagePayload {
    pageIndex: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotationDegrees: number | null;
    mimeType: 'image/jpeg';
    bytes: number[];
}

type TNativePdfMutationPayload = Omit<IPdfNativeMutationSet, 'placedImages'> & { placedImages?: INativePlacedImagePayload[]; };

interface INativeNotePhaseTiming {
    phase: string;
    durationMs: number;
}

function createNotAppliedResult(): IPdfNativeNoteTextSaveResult {
    return {
        applied: false,
        validation: null,
    };
}

function createNativeValidationResult(): IPdfValidationResult {
    return {
        isValid: true,
        tool: 'native',
        errors: [],
        warnings: [],
    };
}

function normalizeWorkingPath(workingPath: unknown) {
    const normalizedWorkingPath = typeof workingPath === 'string' ? workingPath.trim() : '';
    if (!normalizedWorkingPath) {
        throw new Error('Invalid file path');
    }

    return normalizedWorkingPath;
}

function normalizeModifiedAt(modifiedAt: unknown) {
    const normalized = typeof modifiedAt === 'string' ? modifiedAt.trim() : '';
    if (!/^D:\d{14}(?:Z|[+-]\d{2}'\d{2}')?$/u.test(normalized)) {
        throw new Error('Invalid PDF modification timestamp');
    }
    return normalized;
}

function normalizeWorkingCopyExpectation(rawExpectedBase: unknown): IPdfNativeWorkingCopyExpectation {
    if (rawExpectedBase === undefined || rawExpectedBase === null) {
        throw new Error('Invalid native working-copy expectation');
    }
    if (!rawExpectedBase || typeof rawExpectedBase !== 'object') {
        throw new Error('Invalid native working-copy expectation');
    }
    const candidate = rawExpectedBase as Partial<IPdfNativeWorkingCopyExpectation>;
    if (
        typeof candidate.byteLength !== 'number'
        || !Number.isSafeInteger(candidate.byteLength)
        || candidate.byteLength <= 0
        || typeof candidate.sha256 !== 'string'
        || !SHA256_HEX_PATTERN.test(candidate.sha256)
    ) {
        throw new Error('Invalid native working-copy expectation');
    }
    return {
        byteLength: candidate.byteLength,
        sha256: candidate.sha256.toLowerCase(),
    };
}

async function workingCopyMatchesExpectation(
    workingPath: string,
    expectedBase: IPdfNativeWorkingCopyExpectation,
) {
    const bytes = await readFile(workingPath);
    if (bytes.byteLength !== expectedBase.byteLength) {
        return false;
    }
    const sha256 = createHash('sha256')
        .update(bytes)
        .digest('hex');
    return sha256 === expectedBase.sha256;
}

function normalizeNoteTextUpdates(updates: unknown) {
    if (!Array.isArray(updates) || updates.length === 0 || updates.length > MAX_NATIVE_NOTE_TEXT_UPDATES) {
        throw new Error('Invalid note text update list');
    }

    return normalizeNoteTextUpdateArray(updates);
}

function normalizeOptionalNoteTextUpdates(updates: unknown) {
    if (updates === undefined) {
        return [];
    }
    if (!Array.isArray(updates) || updates.length > MAX_NATIVE_NOTE_TEXT_UPDATES) {
        throw new Error('Invalid note text update list');
    }

    return normalizeNoteTextUpdateArray(updates);
}

function normalizeNoteTextUpdateArray(updates: unknown[]) {
    return updates.map((update, index): IPdfNoteTextUpdate => {
        if (!update || typeof update !== 'object') {
            throw new Error(`Invalid note text update at index ${index}`);
        }
        const candidate = update as Partial<IPdfNoteTextUpdate>;
        const {
            objectNumber,
            generationNumber,
            text,
        } = candidate;
        if (
            typeof objectNumber !== 'number'
            || !Number.isSafeInteger(objectNumber)
            || objectNumber < 1
            || typeof generationNumber !== 'number'
            || !Number.isSafeInteger(generationNumber)
            || generationNumber < 0
            || generationNumber > 65_535
            || typeof text !== 'string'
        ) {
            throw new Error(`Invalid note text update at index ${index}`);
        }
        return {
            objectNumber,
            generationNumber,
            text,
        };
    });
}

function normalizeFreeTextNoteMarkerRect(value: unknown, label: string): IPdfNativeFreeTextNoteMarkerRect {
    return normalizeNativeMarkerRect(value, label);
}

function normalizeNativeMarkerRect(value: unknown, label: string): IPdfNativeFreeTextNoteMarkerRect {
    if (!value || typeof value !== 'object') {
        throw new Error(`${label} must be an object`);
    }
    const rect = value as Partial<IPdfNativeFreeTextNoteMarkerRect>;
    const {
        left,
        top,
        width,
        height,
    } = rect;
    if (
        typeof left !== 'number'
        || !Number.isFinite(left)
        || left < 0
        || left > 1
        || typeof top !== 'number'
        || !Number.isFinite(top)
        || top < 0
        || top > 1
        || typeof width !== 'number'
        || !Number.isFinite(width)
        || width <= 0
        || width > 1
        || typeof height !== 'number'
        || !Number.isFinite(height)
        || height <= 0
        || height > 1
        || left + width > 1
        || top + height > 1
    ) {
        throw new Error(`${label} must fit inside normalized page bounds`);
    }
    return {
        left,
        top,
        width,
        height,
    };
}

function normalizeMarkupMarkerRect(value: unknown, label: string): IPdfNativeMarkupMarkerRect {
    return normalizeNativeMarkerRect(value, label);
}

function normalizeOptionalString(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string') {
        throw new Error('Expected string or null');
    }
    return value;
}

function normalizeOptionalTimestamp(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error('Expected finite timestamp or null');
    }
    return Math.trunc(value);
}

function normalizeFiniteUnitNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${label} must be a finite number from 0 to 1`);
    }
    return value;
}

function normalizeOptionalFiniteUnitNumber(value: unknown, label: string) {
    if (value === undefined || value === null) {
        return null;
    }
    return normalizeFiniteUnitNumber(value, label);
}

function normalizeFiniteNonNegativeNumber(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`${label} must be a finite non-negative number`);
    }
    return value;
}

function normalizeNativeShapeOptionalString(value: unknown, label: string) {
    const normalized = normalizeOptionalString(value);
    if (normalized !== null && normalized.length > MAX_NATIVE_SHAPE_TEXT_LENGTH) {
        throw new Error(`${label} is too long`);
    }
    return normalized;
}

function normalizeNativeShapeEnum(
    value: unknown,
    label: string,
    allowed: Set<string>,
    options: {optional?: boolean} = {},
) {
    if (value === undefined || value === null) {
        if (options.optional) {
            return null;
        }
        throw new Error(`${label} is required`);
    }
    if (typeof value !== 'string' || !allowed.has(value)) {
        throw new Error(`${label} is not supported`);
    }
    return value;
}

function normalizeFreeTextNotes(notes: unknown) {
    if (notes === undefined) {
        return [];
    }
    if (!Array.isArray(notes) || notes.length > MAX_NATIVE_NOTE_CHANGES) {
        throw new Error('Invalid FreeText note list');
    }

    return notes.map((note, index): IPdfNativeFreeTextNote => {
        if (!note || typeof note !== 'object') {
            throw new Error(`Invalid FreeText note at index ${index}`);
        }
        const candidate = note as Partial<IPdfNativeFreeTextNote>;
        const stableKey = typeof candidate.stableKey === 'string' ? candidate.stableKey.trim() : '';
        if (
            typeof candidate.pageIndex !== 'number'
            || !Number.isSafeInteger(candidate.pageIndex)
            || candidate.pageIndex < 0
            || !stableKey
            || typeof candidate.text !== 'string'
        ) {
            throw new Error(`Invalid FreeText note at index ${index}`);
        }
        return {
            pageIndex: candidate.pageIndex,
            stableKey,
            text: candidate.text,
            markerRect: normalizeFreeTextNoteMarkerRect(candidate.markerRect, `FreeText note ${index} markerRect`),
            author: normalizeOptionalString(candidate.author),
            color: normalizeOptionalString(candidate.color),
            createdAt: normalizeOptionalTimestamp(candidate.createdAt),
        };
    });
}

function normalizeAnnotationDeletes(deletes: unknown) {
    if (deletes === undefined) {
        return [];
    }
    if (!Array.isArray(deletes) || deletes.length > MAX_NATIVE_NOTE_CHANGES) {
        throw new Error('Invalid native annotation delete list');
    }

    return deletes.map((item, index): IPdfNativeAnnotationDelete => {
        if (!item || typeof item !== 'object') {
            throw new Error(`Invalid native annotation delete at index ${index}`);
        }
        const candidate = item as Partial<IPdfNativeAnnotationDelete>;
        const stableKey = typeof candidate.stableKey === 'string' ? candidate.stableKey.trim() : '';
        const hasRef = candidate.objectNumber !== undefined || candidate.generationNumber !== undefined;
        const hasValidRef = typeof candidate.objectNumber === 'number'
            && Number.isSafeInteger(candidate.objectNumber)
            && candidate.objectNumber >= 1
            && typeof candidate.generationNumber === 'number'
            && Number.isSafeInteger(candidate.generationNumber)
            && candidate.generationNumber >= 0
            && candidate.generationNumber <= 65_535;
        const createdAt = candidate.createdAt ?? null;
        if (
            typeof candidate.pageIndex !== 'number'
            || !Number.isSafeInteger(candidate.pageIndex)
            || candidate.pageIndex < 0
            || (hasRef && !hasValidRef)
            || (!hasValidRef && !stableKey)
            || (createdAt !== null && (
                typeof createdAt !== 'number'
                || !Number.isFinite(createdAt)
                || createdAt < 0
            ))
        ) {
            throw new Error(`Invalid native annotation delete at index ${index}`);
        }
        return {
            pageIndex: candidate.pageIndex,
            ...(hasValidRef
                ? {
                    objectNumber: candidate.objectNumber,
                    generationNumber: candidate.generationNumber,
                }
                : {}),
            ...(stableKey ? {stableKey} : {}),
            ...(createdAt !== null ? {createdAt: Math.trunc(createdAt)} : {}),
        };
    });
}

function normalizeNoteChanges(rawChanges: unknown): IPdfNativeNoteChanges {
    if (!rawChanges || typeof rawChanges !== 'object') {
        throw new Error('Invalid native note changes');
    }
    const candidate = rawChanges as Partial<IPdfNativeNoteChanges>;
    const updates = normalizeOptionalNoteTextUpdates(candidate.updates);
    const freeTextNotes = normalizeFreeTextNotes(candidate.freeTextNotes);
    const deletes = normalizeAnnotationDeletes(candidate.deletes);
    if (updates.length + freeTextNotes.length + deletes.length === 0) {
        throw new Error('At least one native note change is required');
    }
    if (updates.length + freeTextNotes.length + deletes.length > MAX_NATIVE_NOTE_CHANGES) {
        throw new Error('Too many native note changes');
    }
    return {
        ...(updates.length > 0 ? {updates} : {}),
        ...(freeTextNotes.length > 0 ? {freeTextNotes} : {}),
        ...(deletes.length > 0 ? {deletes} : {}),
    };
}

function normalizePageLabelRange(value: unknown, index: number): IPdfNativePageLabelRange {
    if (!value || typeof value !== 'object') {
        throw new Error(`Invalid page label range at index ${index}`);
    }
    const candidate = value as Partial<IPdfNativePageLabelRange>;
    if (
        typeof candidate.startPage !== 'number'
        || !Number.isSafeInteger(candidate.startPage)
        || candidate.startPage < 1
        || (candidate.style !== null && (
            typeof candidate.style !== 'string'
            || !PDF_NATIVE_PAGE_LABEL_STYLES.has(candidate.style)
        ))
        || typeof candidate.prefix !== 'string'
        || typeof candidate.startNumber !== 'number'
        || !Number.isSafeInteger(candidate.startNumber)
        || candidate.startNumber < 1
    ) {
        throw new Error(`Invalid page label range at index ${index}`);
    }
    return {
        startPage: candidate.startPage,
        style: candidate.style,
        prefix: candidate.prefix,
        startNumber: candidate.startNumber,
    };
}

function normalizePageLabelsMutation(rawPageLabels: unknown): IPdfNativePageLabelsMutation | null {
    if (rawPageLabels === undefined) {
        return null;
    }
    if (!rawPageLabels || typeof rawPageLabels !== 'object') {
        throw new Error('Invalid native page-label mutation');
    }
    const candidate = rawPageLabels as Partial<IPdfNativePageLabelsMutation>;
    if (
        typeof candidate.totalPages !== 'number'
        || !Number.isSafeInteger(candidate.totalPages)
        || candidate.totalPages < 1
        || !Array.isArray(candidate.ranges)
        || candidate.ranges.length > MAX_NATIVE_PAGE_LABEL_RANGES
    ) {
        throw new Error('Invalid native page-label mutation');
    }
    return {
        totalPages: candidate.totalPages,
        ranges: candidate.ranges.map(normalizePageLabelRange),
    };
}

function normalizeBookmarkColor(value: unknown) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
        throw new Error('Invalid bookmark color');
    }
    return value.toLowerCase();
}

function countBookmarkItems(items: IPdfBookmarkEntry[]) {
    let count = 0;
    const visit = (children: IPdfBookmarkEntry[]) => {
        for (const child of children) {
            count += 1;
            visit(child.items);
        }
    };
    visit(items);
    return count;
}

function normalizeBookmarkItems(
    rawItems: unknown,
    label: string,
    depth = 0,
): IPdfBookmarkEntry[] {
    if (!Array.isArray(rawItems)) {
        throw new Error(`${label} must be an array`);
    }
    if (depth > MAX_NATIVE_BOOKMARK_DEPTH) {
        throw new Error('Native bookmark mutation is too deeply nested');
    }
    return rawItems.map((item, index): IPdfBookmarkEntry => {
        if (!item || typeof item !== 'object') {
            throw new Error(`Invalid bookmark item at ${label}[${index}]`);
        }
        const candidate = item as Partial<IPdfBookmarkEntry>;
        if (
            typeof candidate.title !== 'string'
            || (
                candidate.pageIndex !== null
                && (
                    typeof candidate.pageIndex !== 'number'
                    || !Number.isSafeInteger(candidate.pageIndex)
                    || candidate.pageIndex < 0
                )
            )
            || (candidate.namedDest !== null && typeof candidate.namedDest !== 'string')
        ) {
            throw new Error(`Invalid bookmark item at ${label}[${index}]`);
        }
        return {
            title: candidate.title,
            pageIndex: candidate.pageIndex,
            namedDest: candidate.namedDest,
            bold: candidate.bold === true,
            italic: candidate.italic === true,
            color: normalizeBookmarkColor(candidate.color),
            items: normalizeBookmarkItems(candidate.items, `${label}[${index}].items`, depth + 1),
        };
    });
}

function normalizeBookmarksMutation(rawBookmarks: unknown): IPdfNativeBookmarksMutation | null {
    if (rawBookmarks === undefined) {
        return null;
    }
    if (!rawBookmarks || typeof rawBookmarks !== 'object') {
        throw new Error('Invalid native bookmark mutation');
    }
    const candidate = rawBookmarks as Partial<IPdfNativeBookmarksMutation>;
    if (
        typeof candidate.totalPages !== 'number'
        || !Number.isSafeInteger(candidate.totalPages)
        || candidate.totalPages < 1
    ) {
        throw new Error('Invalid native bookmark mutation');
    }
    const items = normalizeBookmarkItems(candidate.items, 'bookmarks.items');
    if (countBookmarkItems(items) > MAX_NATIVE_BOOKMARK_ITEMS) {
        throw new Error('Too many native bookmark items');
    }
    return {
        totalPages: candidate.totalPages,
        untitledLabel: typeof candidate.untitledLabel === 'string'
            ? candidate.untitledLabel
            : '',
        items,
    };
}

function normalizeNativeShapePoint(value: unknown, label: string): IPdfNativeShapePoint {
    if (!value || typeof value !== 'object') {
        throw new Error(`${label} must be an object`);
    }
    const candidate = value as Partial<IPdfNativeShapePoint>;
    return {
        x: normalizeFiniteUnitNumber(candidate.x, `${label}.x`),
        y: normalizeFiniteUnitNumber(candidate.y, `${label}.y`),
    };
}

function normalizeNativeShapePoints(
    rawPoints: unknown,
    label: string,
    state: {pointCount: number},
) {
    if (rawPoints === undefined) {
        return undefined;
    }
    if (!Array.isArray(rawPoints)) {
        throw new Error(`${label} must be an array`);
    }
    state.pointCount += rawPoints.length;
    if (state.pointCount > MAX_NATIVE_SHAPE_POINTS) {
        throw new Error('Too many native shape points');
    }
    return rawPoints.map((point, index) => normalizeNativeShapePoint(point, `${label}[${index}]`));
}

function normalizeNativeShapeStrokes(
    rawStrokes: unknown,
    label: string,
    state: {pointCount: number},
) {
    if (rawStrokes === undefined) {
        return undefined;
    }
    if (!Array.isArray(rawStrokes)) {
        throw new Error(`${label} must be an array`);
    }
    return rawStrokes.map((stroke, index) =>
        normalizeNativeShapePoints(stroke, `${label}[${index}]`, state) ?? []);
}

function normalizeNativeShapeAnnotation(
    rawShape: unknown,
    index: number,
    state: {pointCount: number},
): IPdfNativeShapeAnnotation {
    if (!rawShape || typeof rawShape !== 'object') {
        throw new Error(`Invalid native shape at index ${index}`);
    }
    const candidate = rawShape as Partial<IPdfNativeShapeAnnotation>;
    const pageIndex = candidate.pageIndex;
    if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex) || pageIndex < 0) {
        throw new Error(`Invalid native shape page index at index ${index}`);
    }
    if (typeof candidate.color !== 'string' || candidate.color.length > MAX_NATIVE_SHAPE_TEXT_LENGTH) {
        throw new Error(`Invalid native shape color at index ${index}`);
    }
    if (
        typeof candidate.opacity !== 'number'
        || !Number.isFinite(candidate.opacity)
        || candidate.opacity < 0
        || candidate.opacity > 1
    ) {
        throw new Error(`Invalid native shape opacity at index ${index}`);
    }
    const id = normalizeNativeShapeOptionalString(candidate.id, `shape ${index} id`);
    const points = normalizeNativeShapePoints(candidate.points, `shape ${index} points`, state);
    const strokes = normalizeNativeShapeStrokes(candidate.strokes, `shape ${index} strokes`, state);
    const shape: IPdfNativeShapeAnnotation = {
        type: normalizeNativeShapeEnum(candidate.type, `shape ${index} type`, PDF_NATIVE_SHAPE_TYPES) as IPdfNativeShapeAnnotation['type'],
        pageIndex,
        x: normalizeFiniteUnitNumber(candidate.x, `shape ${index} x`),
        y: normalizeFiniteUnitNumber(candidate.y, `shape ${index} y`),
        width: normalizeFiniteNonNegativeNumber(candidate.width, `shape ${index} width`),
        height: normalizeFiniteNonNegativeNumber(candidate.height, `shape ${index} height`),
        x2: normalizeOptionalFiniteUnitNumber(candidate.x2, `shape ${index} x2`),
        y2: normalizeOptionalFiniteUnitNumber(candidate.y2, `shape ${index} y2`),
        color: candidate.color,
        fillColor: normalizeNativeShapeOptionalString(candidate.fillColor, `shape ${index} fillColor`),
        opacity: candidate.opacity,
        strokeWidth: normalizeFiniteNonNegativeNumber(candidate.strokeWidth, `shape ${index} strokeWidth`),
        annotationId: normalizeNativeShapeOptionalString(candidate.annotationId, `shape ${index} annotationId`),
        stableKey: normalizeNativeShapeOptionalString(candidate.stableKey, `shape ${index} stableKey`),
        pdfSubtype: normalizeNativeShapeEnum(
            candidate.pdfSubtype,
            `shape ${index} pdfSubtype`,
            PDF_NATIVE_SHAPE_SUBTYPES,
            {optional: true},
        ) as NonNullable<IPdfNativeShapeAnnotation['pdfSubtype']> | null,
        lineStartStyle: normalizeNativeShapeEnum(
            candidate.lineStartStyle,
            `shape ${index} lineStartStyle`,
            PDF_NATIVE_SHAPE_LINE_END_STYLES,
            {optional: true},
        ) as NonNullable<IPdfNativeShapeAnnotation['lineStartStyle']> | null,
        lineEndStyle: normalizeNativeShapeEnum(
            candidate.lineEndStyle,
            `shape ${index} lineEndStyle`,
            PDF_NATIVE_SHAPE_LINE_END_STYLES,
            {optional: true},
        ) as NonNullable<IPdfNativeShapeAnnotation['lineEndStyle']> | null,
        createdAt: normalizeOptionalTimestamp(candidate.createdAt),
        modifiedAt: normalizeOptionalTimestamp(candidate.modifiedAt),
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

function normalizeNativeShapeStringArray(rawItems: unknown, label: string) {
    if (rawItems === undefined) {
        return [];
    }
    if (!Array.isArray(rawItems) || rawItems.length > MAX_NATIVE_SHAPE_DELETED_ITEMS) {
        throw new Error(`${label} must be a bounded array`);
    }
    return rawItems.map((item, index) => {
        if (typeof item !== 'string' || item.length > MAX_NATIVE_SHAPE_TEXT_LENGTH) {
            throw new Error(`Invalid ${label} item at index ${index}`);
        }
        return item.trim();
    }).filter(Boolean);
}

function normalizeNativeMarkupSubtype(value: unknown, label: string) {
    if (typeof value !== 'string' || !PDF_NATIVE_MARKUP_SUBTYPES.has(value)) {
        throw new Error(`${label} is not supported`);
    }
    return value as NonNullable<IPdfNativeMarkupSubtypeHint['subtype']>;
}

function normalizeNativeMarkupOptionalString(value: unknown, label: string) {
    const normalized = normalizeOptionalString(value);
    if (normalized !== null && normalized.length > MAX_NATIVE_MARKUP_TEXT_LENGTH) {
        throw new Error(`${label} is too long`);
    }
    return normalized;
}

function normalizeNativeMarkupOptionalIndex(value: unknown, label: string) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer or null`);
    }
    return value;
}

function normalizeNativeMarkupOverride(value: unknown, index: number) {
    if (!Array.isArray(value) || value.length !== 2) {
        throw new Error(`Invalid native markup override at index ${index}`);
    }
    const tuple: unknown[] = value;
    const [
        annotationId,
        subtype,
    ] = tuple;
    if (
        typeof annotationId !== 'string'
        || annotationId.trim().length === 0
        || annotationId.length > MAX_NATIVE_MARKUP_TEXT_LENGTH
    ) {
        throw new Error(`Invalid native markup override id at index ${index}`);
    }
    return [
        annotationId.trim(),
        normalizeNativeMarkupSubtype(subtype, `markup override ${index} subtype`),
    ] as const;
}

function normalizeNativeMarkupHint(rawHint: unknown, index: number): IPdfNativeMarkupSubtypeHint {
    if (!rawHint || typeof rawHint !== 'object') {
        throw new Error(`Invalid native markup hint at index ${index}`);
    }
    const candidate = rawHint as Partial<IPdfNativeMarkupSubtypeHint>;
    if (
        typeof candidate.pageIndex !== 'number'
        || !Number.isSafeInteger(candidate.pageIndex)
        || candidate.pageIndex < 0
    ) {
        throw new Error(`Invalid native markup hint page index at index ${index}`);
    }
    return {
        subtype: normalizeNativeMarkupSubtype(candidate.subtype, `markup hint ${index} subtype`),
        pageIndex: candidate.pageIndex,
        markerRect: normalizeMarkupMarkerRect(candidate.markerRect, `Markup hint ${index} markerRect`),
        annotationId: normalizeNativeMarkupOptionalString(candidate.annotationId, `markup hint ${index} annotationId`),
        color: normalizeNativeMarkupOptionalString(candidate.color, `markup hint ${index} color`),
        id: normalizeNativeMarkupOptionalString(candidate.id, `markup hint ${index} id`),
        pageMarkupIndex: normalizeNativeMarkupOptionalIndex(candidate.pageMarkupIndex, `markup hint ${index} pageMarkupIndex`),
        source: normalizeNativeMarkupOptionalString(candidate.source, `markup hint ${index} source`),
    };
}

function normalizeMarkupMutation(rawMarkup: unknown): IPdfNativeMutationSet['markup'] | null {
    if (rawMarkup === undefined) {
        return null;
    }
    if (!rawMarkup || typeof rawMarkup !== 'object') {
        throw new Error('Invalid native text-markup mutation');
    }
    const candidate = rawMarkup as Partial<NonNullable<IPdfNativeMutationSet['markup']>>;
    if (
        !Array.isArray(candidate.overrides)
        || candidate.overrides.length > MAX_NATIVE_MARKUP_ITEMS
        || !Array.isArray(candidate.hints)
        || candidate.hints.length > MAX_NATIVE_MARKUP_ITEMS
    ) {
        throw new Error('Invalid native text-markup mutation');
    }
    const overrides = candidate.overrides.map(normalizeNativeMarkupOverride);
    const hints = candidate.hints.map(normalizeNativeMarkupHint);
    if (overrides.length + hints.length === 0) {
        throw new Error('Native text-markup mutation must include at least one rewrite');
    }
    return {
        overrides,
        hints,
    };
}

function normalizeNativePlacedImageBytes(rawBytes: unknown, label: string) {
    if (rawBytes instanceof Uint8Array) {
        if (rawBytes.byteLength === 0 || rawBytes.byteLength > MAX_NATIVE_PLACED_IMAGE_BYTES) {
            throw new Error(`Invalid native placed image bytes at ${label}`);
        }
        return Array.from(rawBytes);
    }
    if (Array.isArray(rawBytes)) {
        if (rawBytes.length === 0 || rawBytes.length > MAX_NATIVE_PLACED_IMAGE_BYTES) {
            throw new Error(`Invalid native placed image bytes at ${label}`);
        }
        return rawBytes.map((byte, byteIndex) => {
            if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
                throw new Error(`Invalid native placed image byte at ${label}.${byteIndex}`);
            }
            return byte;
        });
    }
    throw new Error(`Invalid native placed image bytes at ${label}`);
}

function normalizeNativePlacedImages(rawPlacedImages: unknown) {
    if (rawPlacedImages === undefined) {
        return [];
    }
    if (!Array.isArray(rawPlacedImages) || rawPlacedImages.length > MAX_NATIVE_PLACED_IMAGES) {
        throw new Error('Invalid native placed image list');
    }

    return rawPlacedImages.map((image, index): INativePlacedImagePayload => {
        if (!image || typeof image !== 'object') {
            throw new Error(`Invalid native placed image at index ${index}`);
        }
        const candidate = image as Record<string, unknown>;
        if (
            typeof candidate.pageIndex !== 'number'
            || !Number.isSafeInteger(candidate.pageIndex)
            || candidate.pageIndex < 0
            || candidate.mimeType !== 'image/jpeg'
        ) {
            throw new Error(`Invalid native placed image at index ${index}`);
        }
        const bounds = normalizeNativeMarkerRect({
            left: candidate.x,
            top: candidate.y,
            width: candidate.width,
            height: candidate.height,
        }, `Native placed image ${index}`);
        const rotationDegrees = candidate.rotationDegrees ?? null;
        if (
            rotationDegrees !== null
            && (typeof rotationDegrees !== 'number' || !Number.isFinite(rotationDegrees))
        ) {
            throw new Error(`Invalid native placed image rotation at index ${index}`);
        }
        const bytes = normalizeNativePlacedImageBytes(candidate.bytes, `index ${index}`);
        return {
            pageIndex: candidate.pageIndex,
            x: bounds.left,
            y: bounds.top,
            width: bounds.width,
            height: bounds.height,
            rotationDegrees,
            mimeType: 'image/jpeg',
            bytes,
        };
    });
}

function normalizeShapesMutation(rawShapes: unknown): IPdfNativeShapesMutation | null {
    if (rawShapes === undefined) {
        return null;
    }
    if (!rawShapes || typeof rawShapes !== 'object') {
        throw new Error('Invalid native shape mutation');
    }
    const candidate = rawShapes as Partial<IPdfNativeShapesMutation>;
    if (
        typeof candidate.totalPages !== 'number'
        || !Number.isSafeInteger(candidate.totalPages)
        || candidate.totalPages < 1
        || !Array.isArray(candidate.shapes)
        || candidate.shapes.length > MAX_NATIVE_SHAPES
    ) {
        throw new Error('Invalid native shape mutation');
    }
    const pointState = {pointCount: 0};
    return {
        totalPages: candidate.totalPages,
        rewriteShapeState: candidate.rewriteShapeState === true,
        shapes: candidate.shapes.map((shape, index) => normalizeNativeShapeAnnotation(shape, index, pointState)),
        deletedAnnotationIds: normalizeNativeShapeStringArray(candidate.deletedAnnotationIds, 'deleted shape annotation ids'),
        deletedStableKeys: normalizeNativeShapeStringArray(candidate.deletedStableKeys, 'deleted shape stable keys'),
    };
}

function normalizeNativeMutationSet(rawMutations: unknown): TNativePdfMutationPayload {
    if (!rawMutations || typeof rawMutations !== 'object') {
        throw new Error('Invalid native PDF mutations');
    }
    const candidate = rawMutations as Partial<IPdfNativeMutationSet>;
    const updates = normalizeOptionalNoteTextUpdates(candidate.updates);
    const freeTextNotes = normalizeFreeTextNotes(candidate.freeTextNotes);
    const deletes = normalizeAnnotationDeletes(candidate.deletes);
    const pageLabels = normalizePageLabelsMutation(candidate.pageLabels);
    const bookmarks = normalizeBookmarksMutation(candidate.bookmarks);
    const shapes = normalizeShapesMutation(candidate.shapes);
    const markup = normalizeMarkupMutation(candidate.markup);
    const placedImages = normalizeNativePlacedImages(candidate.placedImages);
    if (
        updates.length + freeTextNotes.length + deletes.length === 0
        && !pageLabels
        && !bookmarks
        && !shapes
        && !markup
        && placedImages.length === 0
    ) {
        throw new Error('At least one native PDF mutation is required');
    }
    if (updates.length + freeTextNotes.length + deletes.length > MAX_NATIVE_NOTE_CHANGES) {
        throw new Error('Too many native note changes');
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

function getValidatedOriginalPath(workingPath: string, senderWebContentsId: number) {
    const originalPath = getWorkingCopyOriginalPath(workingPath, senderWebContentsId)?.originalPath;
    if (!originalPath) {
        throw new Error('No original path found for this working copy');
    }
    if (!isAllowedOriginalSavePath(originalPath)) {
        throw new Error('Invalid original path for this working copy');
    }

    return originalPath;
}

async function assertNativeOutputReady(outputPath: string) {
    const outputStat = await stat(outputPath);
    if (outputStat.size === 0) {
        throw new Error('Native note text update produced an empty PDF');
    }
}

async function cleanupTempPath(path: string) {
    await rm(path, {force: true}).catch((error) => {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return;
        }
        log.debug(`Failed to cleanup native note text temp file "${path}": ${getErrorMessage(error)}`);
    });
}

async function measureNativeNotePhase<T>(
    phaseTimings: INativeNotePhaseTiming[],
    phase: string,
    operation: () => Promise<T>,
) {
    const start = performance.now();
    try {
        return await operation();
    } finally {
        phaseTimings.push({
            phase,
            durationMs: Math.round((performance.now() - start) * 10) / 10,
        });
    }
}

async function syncNativeOutputToRequestingWorkingCopy(
    originalPath: string,
    requestedWorkingPath: string,
    senderWebContentsId: number,
) {
    const currentWorkingPath = findWorkingCopyPathByOriginalPath(originalPath, senderWebContentsId);
    await ensureWorkingCopyDirectory(requestedWorkingPath, senderWebContentsId);
    await copyFileCopyOnWrite(originalPath, requestedWorkingPath);
    refreshWorkingCopyOriginalFileExpectation(requestedWorkingPath, senderWebContentsId);

    if (currentWorkingPath && currentWorkingPath !== requestedWorkingPath) {
        log.debug(`Skipped native output sync to distinct current working copy: ${JSON.stringify({
            currentWorkingPath,
            requestedWorkingPath,
        })}`);
    }
}

async function runNativeNoteCommand(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    rawModifiedAt: unknown,
    options: INativeNoteCommandOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const modifiedAt = normalizeModifiedAt(rawModifiedAt);

    if (isNativePageOpsDisabled()) {
        return createNotAppliedResult();
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        return createNotAppliedResult();
    }

    const originalPath = getValidatedOriginalPath(normalizedWorkingPath, event.sender.id);
    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
        throw new Error('Working copy path is not managed');
    }

    return enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
        const phaseTimings: INativeNotePhaseTiming[] = [];
        const operationStart = performance.now();
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
            throw new Error('Working copy path is not managed');
        }

        const tempPath = makeSiblingTempPath(originalPath);
        const tempDir = await mkdtemp(join(tmpdir(), 'pdf-note-text-'));
        const payloadFilePath = join(tempDir, options.payloadFileName);
        try {
            await measureNativeNotePhase(phaseTimings, 'write-payload', () =>
                writeFile(payloadFilePath, JSON.stringify(options.payload)));
            await measureNativeNotePhase(phaseTimings, 'clone-working-to-temp', () =>
                copyFileCopyOnWrite(normalizedWorkingPath, tempPath));
            await measureNativeNotePhase(phaseTimings, 'native-command', () =>
                runNativeToolCommand(binaryPath, [
                    options.command,
                    '--input',
                    tempPath,
                    '--output',
                    tempPath,
                    options.payloadFlag,
                    payloadFilePath,
                    '--modified-at',
                    modifiedAt,
                    '--append',
                ], {
                    timeoutMs: PDF_NATIVE_MUTATION_TIMEOUT_MS,
                    commandLabel: options.commandLabel,
                }));
            await measureNativeNotePhase(phaseTimings, 'assert-output', () =>
                assertNativeOutputReady(tempPath));
            const validation = createNativeValidationResult();
            const originalBaseMatches = await measureNativeNotePhase(phaseTimings, 'assert-original-base', () =>
                originalPathSaveBaseMatches(normalizedWorkingPath, originalPath, event.sender.id));
            if (!originalBaseMatches) {
                log.debug(`Native note save skipped because original base expectation no longer matches: ${JSON.stringify({
                    command: options.command,
                    totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                })}`);
                return createNotAppliedResult();
            }

            await measureNativeNotePhase(phaseTimings, 'atomic-replace-original', () =>
                atomicReplace(tempPath, originalPath));
            await measureNativeNotePhase(phaseTimings, 'sync-requesting-working-copy', () =>
                syncNativeOutputToRequestingWorkingCopy(originalPath, normalizedWorkingPath, event.sender.id));
            log.debug(`Native note save phase timings: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
            })}`);
            return {
                applied: true,
                validation,
            };
        } catch (error) {
            log.debug(`Native note text update failed, falling back to pdf-lib: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
                error: getErrorMessage(error),
            })}`);
            return createNotAppliedResult();
        } finally {
            await cleanupTempPath(tempPath);
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    });
}

async function runNativeWorkingCopyCommand(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    rawModifiedAt: unknown,
    rawExpectedBase: unknown,
    options: INativeNoteCommandOptions,
): Promise<IPdfNativeNoteTextSaveResult> {
    const normalizedWorkingPath = normalizeWorkingPath(workingPath);
    const modifiedAt = normalizeModifiedAt(rawModifiedAt);
    const expectedBase = normalizeWorkingCopyExpectation(rawExpectedBase);

    if (isNativePageOpsDisabled()) {
        return createNotAppliedResult();
    }

    const binaryPath = resolveNativePageOpsPath();
    if (!binaryPath) {
        return createNotAppliedResult();
    }

    if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
        throw new Error('Working copy path is not managed');
    }

    return enqueueWorkingCopyMutation(normalizedWorkingPath, async () => {
        const phaseTimings: INativeNotePhaseTiming[] = [];
        const operationStart = performance.now();
        if (!await ensureWorkingCopyDirectory(normalizedWorkingPath, event.sender.id)) {
            throw new Error('Working copy path is not managed');
        }
        if (!await workingCopyMatchesExpectation(normalizedWorkingPath, expectedBase)) {
            log.debug(`Native working-copy mutation skipped because base expectation no longer matches: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
            })}`);
            return createNotAppliedResult();
        }

        const tempPath = makeSiblingTempPath(normalizedWorkingPath);
        const tempDir = await mkdtemp(join(tmpdir(), 'pdf-working-copy-mutation-'));
        const payloadFilePath = join(tempDir, options.payloadFileName);
        try {
            await measureNativeNotePhase(phaseTimings, 'write-payload', () =>
                writeFile(payloadFilePath, JSON.stringify(options.payload)));
            await measureNativeNotePhase(phaseTimings, 'clone-working-to-temp', () =>
                copyFileCopyOnWrite(normalizedWorkingPath, tempPath));
            await measureNativeNotePhase(phaseTimings, 'native-command', () =>
                runNativeToolCommand(binaryPath, [
                    options.command,
                    '--input',
                    tempPath,
                    '--output',
                    tempPath,
                    options.payloadFlag,
                    payloadFilePath,
                    '--modified-at',
                    modifiedAt,
                    '--append',
                ], {
                    timeoutMs: PDF_NATIVE_MUTATION_TIMEOUT_MS,
                    commandLabel: options.commandLabel,
                }));
            await measureNativeNotePhase(phaseTimings, 'assert-output', () =>
                assertNativeOutputReady(tempPath));
            const validation = createNativeValidationResult();

            await measureNativeNotePhase(phaseTimings, 'atomic-replace-working-copy', () =>
                atomicReplace(tempPath, normalizedWorkingPath));
            log.debug(`Native working-copy mutation phase timings: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
            })}`);
            return {
                applied: true,
                validation,
            };
        } catch (error) {
            log.debug(`Native working-copy mutation failed, falling back to pdf-lib: ${JSON.stringify({
                command: options.command,
                totalMs: Math.round((performance.now() - operationStart) * 10) / 10,
                phases: phaseTimings,
                error: getErrorMessage(error),
            })}`);
            return createNotAppliedResult();
        } finally {
            await cleanupTempPath(tempPath);
            await rm(tempDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined);
        }
    });
}

export async function handleNativeNoteTextSave(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    rawUpdates: unknown,
    rawModifiedAt: unknown,
): Promise<IPdfNativeNoteTextSaveResult> {
    const updates = normalizeNoteTextUpdates(rawUpdates);
    return runNativeNoteCommand(event, workingPath, rawModifiedAt, {
        command: 'update-note-text',
        payloadFileName: 'updates.json',
        payloadFlag: '--updates-file',
        payload: {updates},
        commandLabel: 'evb-pdf-page-ops(update-note-text)',
    });
}

export async function handleNativeNoteChangesSave(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    rawChanges: unknown,
    rawModifiedAt: unknown,
): Promise<IPdfNativeNoteTextSaveResult> {
    const changes = normalizeNoteChanges(rawChanges);
    return runNativeNoteCommand(event, workingPath, rawModifiedAt, {
        command: 'save-note-changes',
        payloadFileName: 'changes.json',
        payloadFlag: '--changes-file',
        payload: changes,
        commandLabel: 'evb-pdf-page-ops(save-note-changes)',
    });
}

export async function handleNativePdfMutationsSave(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    rawMutations: unknown,
    rawModifiedAt: unknown,
): Promise<IPdfNativeNoteTextSaveResult> {
    const mutations = normalizeNativeMutationSet(rawMutations);
    return runNativeNoteCommand(event, workingPath, rawModifiedAt, {
        command: 'save-mutations',
        payloadFileName: 'mutations.json',
        payloadFlag: '--mutations-file',
        payload: mutations,
        commandLabel: 'evb-pdf-page-ops(save-mutations)',
    });
}

export async function handleNativePdfMutationsApplyToWorkingCopy(
    event: Electron.IpcMainInvokeEvent,
    workingPath: unknown,
    rawMutations: unknown,
    rawModifiedAt: unknown,
    rawExpectedBase: unknown,
): Promise<IPdfNativeNoteTextSaveResult> {
    const mutations = normalizeNativeMutationSet(rawMutations);
    return runNativeWorkingCopyCommand(event, workingPath, rawModifiedAt, rawExpectedBase, {
        command: 'save-mutations',
        payloadFileName: 'mutations.json',
        payloadFlag: '--mutations-file',
        payload: mutations,
        commandLabel: 'evb-pdf-page-ops(save-mutations-working-copy)',
    });
}
