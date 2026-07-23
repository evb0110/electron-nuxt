import type {
    IPageOpsExtractResult,
    IPageOpsInsertResult,
    IPageOpsMetadataSnapshot,
    IPageOpsMutationOptions,
    IPageOpsResult,
    TPageOpsRotationAngle,
} from '@contracts/electronApiPageOps';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import {
    isDocumentRevisionInfo,
    parseDocumentRevisionToken,
    requireDocumentRevisionToken,
} from '@contracts/documentRevision';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { normalizeCropMargins } from '@contracts/shared';
import {
    definePlatformFeature,
    runtimeSchema as s,
    type IRuntimeSchema,
    type TFeatureCapability,
    type TFeatureInvokeMap,
    type TInferSchema,
} from '@contracts/platformFeature';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';

const MAX_COLLECTION_ITEMS = 100_000;
const METHOD_TIMEOUT_MS = 30 * 60 * 1_000;

type TDeleteArgs = [string, number[], number, IPageOpsMutationOptions | undefined];
type TExtractArgs = [string, number[]];
type TReorderArgs = [string, number[], IPageOpsMutationOptions | undefined];
type TInsertArgs = [string, number, number, IPageOpsMutationOptions | undefined];
type TInsertFileArgs = [
    string,
    number,
    number,
    string[],
    string | undefined,
    IPageOpsMutationOptions | undefined,
];
type TRotateArgs = [string, number[], number, TPageOpsRotationAngle, IPageOpsMutationOptions | undefined];
type TCropArgs = [string, number[], number, ICropMargins, IPageOpsMutationOptions | undefined];
type TRemoveCropArgs = [string, number[], number, IPageOpsMutationOptions | undefined];
type TGetPageGeometryArgs = [string, number];

function requireArgumentCount(value: unknown, count: number): asserts value is unknown[] {
    if (!Array.isArray(value) || value.length !== count) {
        throw new Error(`expected ${count} arguments, received ${Array.isArray(value) ? value.length : 0}`);
    }
}

function decodeString(args: unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${fieldName} must be a non-empty string`);
    }
    return value;
}

function decodeOptionalString(args: unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`${fieldName} must be a string`);
    }
    return value;
}

function decodeSafeInteger(args: unknown[], index: number, fieldName: string, min = 0) {
    const value = args[index];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        throw new Error(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function decodePositiveIntegerArray(args: unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty array`);
    }
    if (value.length > MAX_COLLECTION_ITEMS) {
        throw new Error(`${fieldName} exceeds maximum item count (${MAX_COLLECTION_ITEMS})`);
    }
    if (value.some(item => typeof item !== 'number' || !Number.isSafeInteger(item) || item < 1)) {
        throw new Error(`${fieldName} must contain positive safe integers`);
    }
    return value as number[];
}

function decodeStringArray(args: unknown[], index: number, fieldName: string) {
    const value = args[index];
    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} must be an array`);
    }
    if (value.length > MAX_COLLECTION_ITEMS) {
        throw new Error(`${fieldName} exceeds maximum item count (${MAX_COLLECTION_ITEMS})`);
    }
    if (value.some(item => typeof item !== 'string' || item.trim().length === 0)) {
        throw new Error(`${fieldName} must be an array of non-empty strings`);
    }
    return value as string[];
}

function decodeBookmarkEntries(
    value: unknown,
    depth = 0,
    counter = {value: 0},
): IPdfBookmarkEntry[] {
    if (!Array.isArray(value) || depth > 64) {
        throw new Error('options.metadataSnapshot.bookmarks must be a bounded bookmark array');
    }
    return value.map((raw): IPdfBookmarkEntry => {
        counter.value += 1;
        if (counter.value > 5_000) {
            throw new Error('options.metadataSnapshot.bookmarks exceeds the item limit');
        }
        if (!isRecord(raw)) {
            throw new Error('options.metadataSnapshot.bookmarks contains an invalid bookmark');
        }
        const pageIndex = raw.pageIndex;
        const pageYRatio = raw.pageYRatio;
        if (pageIndex !== null && (!Number.isSafeInteger(pageIndex) || (pageIndex as number) < 0)) {
            throw new Error('bookmark.pageIndex must be a non-negative integer or null');
        }
        if (
            typeof raw.title !== 'string'
            || raw.title.length > 4_096
            || (raw.namedDest !== null && typeof raw.namedDest !== 'string')
            || typeof raw.bold !== 'boolean'
            || typeof raw.italic !== 'boolean'
            || (raw.color !== null && typeof raw.color !== 'string')
        ) {
            throw new Error('options.metadataSnapshot.bookmarks contains invalid fields');
        }
        if (pageYRatio !== undefined && pageYRatio !== null && !isFiniteNumber(pageYRatio)) {
            throw new Error('bookmark.pageYRatio must be finite or null');
        }
        return {
            title: raw.title,
            pageIndex: pageIndex as number | null,
            ...(pageYRatio === undefined ? {} : {pageYRatio}),
            namedDest: raw.namedDest,
            bold: raw.bold,
            italic: raw.italic,
            color: raw.color,
            items: decodeBookmarkEntries(raw.items, depth + 1, counter),
        };
    });
}

function decodeMetadataSnapshot(value: unknown): IPageOpsMetadataSnapshot {
    if (!isRecord(value)) {
        throw new Error('options.metadataSnapshot must be an object');
    }
    const pageLabels = value.pageLabels;
    if (
        pageLabels !== null
        && (
            !Array.isArray(pageLabels)
            || pageLabels.length > 1_000_000
            || !pageLabels.every(label => typeof label === 'string' && label.length <= 4_096)
        )
    ) {
        throw new Error('options.metadataSnapshot.pageLabels must be a string array or null');
    }
    if (typeof value.untitledBookmarkLabel !== 'string') {
        throw new Error('options.metadataSnapshot.untitledBookmarkLabel must be a string');
    }
    return {
        pageLabels,
        bookmarks: decodeBookmarkEntries(value.bookmarks),
        untitledBookmarkLabel: value.untitledBookmarkLabel,
    };
}

function decodeMutationOptions(value: unknown): IPageOpsMutationOptions | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error('options must be an object');
    }
    const allowedKeys = new Set([
        'expectedDocumentRevisionToken',
        'metadataSnapshot',
    ]);
    const unsupportedKey = Object.keys(value).find(key => !allowedKeys.has(key));
    if (unsupportedKey) {
        throw new Error(`options contains unsupported key "${unsupportedKey}"`);
    }
    const metadataSnapshot = value.metadataSnapshot === undefined
        ? undefined
        : decodeMetadataSnapshot(value.metadataSnapshot);
    if (value.expectedDocumentRevisionToken === undefined) {
        return metadataSnapshot === undefined ? {} : {metadataSnapshot};
    }
    if (value.expectedDocumentRevisionToken === null) {
        return {
            expectedDocumentRevisionToken: null,
            ...(metadataSnapshot === undefined ? {} : {metadataSnapshot}),
        };
    }
    const token = parseDocumentRevisionToken(value.expectedDocumentRevisionToken);
    if (token === null) {
        throw new Error('options.expectedDocumentRevisionToken must be a valid document revision token or null');
    }
    return {
        expectedDocumentRevisionToken: token,
        ...(metadataSnapshot === undefined ? {} : {metadataSnapshot}),
    };
}

function decodeRotationAngle(args: unknown[], index: number): TPageOpsRotationAngle {
    const angle = decodeSafeInteger(args, index, 'angle');
    if (angle !== 90 && angle !== 180 && angle !== 270) {
        throw new Error('angle must be 90, 180, or 270');
    }
    return angle;
}

function decodeRevision(value: unknown): IDocumentRevisionInfo | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isDocumentRevisionInfo(value)) {
        throw new Error('documentRevision must be valid');
    }
    return {
        version: value.version,
        token: value.token,
        documentRef: value.documentRef,
        authority: value.authority,
        contentRevision: value.contentRevision,
        mintedAt: value.mintedAt,
    };
}

function decodeOptionalBoolean(value: unknown, fieldName: string) {
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== 'boolean') {
        throw new Error(`${fieldName} must be a boolean`);
    }
    return value;
}

function decodePageOpsResult(value: unknown): IPageOpsResult {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('page operation result must include success');
    }
    const pageCount = value.pageCount === undefined
        ? undefined
        : decodeSafeInteger([value.pageCount], 0, 'pageCount');
    const documentRevision = decodeRevision(value.documentRevision);
    return {
        success: value.success,
        ...(pageCount === undefined ? {} : {pageCount}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
    };
}

function decodeExtractResult(value: unknown): IPageOpsExtractResult {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('page extraction result must include success');
    }
    const canceled = decodeOptionalBoolean(value.canceled, 'canceled');
    if (value.destPath !== undefined && typeof value.destPath !== 'string') {
        throw new Error('destPath must be a string');
    }
    return {
        success: value.success,
        ...(canceled === undefined ? {} : {canceled}),
        ...(value.destPath === undefined ? {} : {destPath: value.destPath}),
    };
}

function decodeInsertResult(value: unknown): IPageOpsInsertResult {
    if (!isRecord(value) || typeof value.success !== 'boolean') {
        throw new Error('page insertion result must include success');
    }
    const canceled = decodeOptionalBoolean(value.canceled, 'canceled');
    const documentRevision = decodeRevision(value.documentRevision);
    return {
        success: value.success,
        ...(canceled === undefined ? {} : {canceled}),
        ...(documentRevision === undefined ? {} : {documentRevision}),
    };
}

function decodePdfBox(value: unknown) {
    if (
        !isRecord(value)
        || !isFiniteNumber(value.x)
        || !isFiniteNumber(value.y)
        || !isFiniteNumber(value.width)
        || !isFiniteNumber(value.height)
    ) {
        throw new Error('page geometry box must contain finite coordinates');
    }
    return {
        x: value.x,
        y: value.y,
        width: value.width,
        height: value.height,
    };
}

function decodePageGeometry(value: unknown): IPageGeometry {
    if (!isRecord(value) || !isFiniteNumber(value.rotation)) {
        throw new Error('page geometry must contain a finite rotation');
    }
    return {
        mediaBox: decodePdfBox(value.mediaBox),
        cropBox: value.cropBox === null ? null : decodePdfBox(value.cropBox),
        rotation: value.rotation,
    };
}

const fixtureOptions = {
    expectedDocumentRevisionToken: requireDocumentRevisionToken('drt1:fixture'),
    metadataSnapshot: {
        pageLabels: ['1'],
        bookmarks: [],
        untitledBookmarkLabel: 'Untitled',
    },
} satisfies IPageOpsMutationOptions;
const pageOpsResult = s.fromParser(decodePageOpsResult, () => ({
    success: true,
    pageCount: 1,
}));
const extractResult = s.fromParser(decodeExtractResult, () => ({
    success: true,
    destPath: '/tmp/extract.pdf',
}));
const insertResult = s.fromParser(decodeInsertResult, () => ({success: true}));
const pageGeometry = s.fromParser(decodePageGeometry, () => ({
    mediaBox: {
        x: 0,
        y: 0,
        width: 612,
        height: 792,
    },
    cropBox: null,
    rotation: 0,
}));
function args<T extends unknown[]>(
    count: number,
    decode: (value: unknown[]) => T,
    example: () => T,
) {
    return s.fromParser((value: unknown) => {
        requireArgumentCount(value, count);
        return decode(value);
    }, example);
}

function method<
    const TName extends string,
    const TChannel extends string,
    TArgs extends IRuntimeSchema<unknown[]>,
    TResult extends IRuntimeSchema<unknown>,
    TMapArgs extends (...args: never[]) => TInferSchema<TArgs>,
>(
    name: TName,
    channel: TChannel,
    methodArgs: TArgs,
    result: TResult,
    mapArgs: TMapArgs,
) {
    return {
        kind: 'async',
        channel,
        ipc: {
            args: methodArgs,
            result,
            timeoutMs: METHOD_TIMEOUT_MS,
        },
        client: {mapArgs},
        main: {
            method: name,
            context: 'sender',
        },
        browser: {method: name},
        lazy: 'forwarded',
    } as const;
}

export const PAGE_OPS_PLATFORM_FEATURE = definePlatformFeature({
    path: ['pageOps'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        delete: method(
            'delete',
            'page-ops:delete',
            args<TDeleteArgs>(4, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePositiveIntegerArray(value, 1, 'pages'),
                decodeSafeInteger(value, 2, 'totalPages', 1),
                decodeMutationOptions(value[3]),
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                1,
                fixtureOptions,
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                pages: number[],
                totalPages: number,
                options?: IPageOpsMutationOptions,
            ): TDeleteArgs => [
                workingCopyPath,
                pages,
                totalPages,
                options,
            ],
        ),
        extract: method(
            'extract',
            'page-ops:extract',
            args<TExtractArgs>(2, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePositiveIntegerArray(value, 1, 'pages'),
            ], () => [
                '/tmp/fixture.pdf',
                [1],
            ]),
            extractResult,
            (workingCopyPath: string, pages: number[]): TExtractArgs => [
                workingCopyPath,
                pages,
            ],
        ),
        reorder: method(
            'reorder',
            'page-ops:reorder',
            args<TReorderArgs>(3, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePositiveIntegerArray(value, 1, 'newOrder'),
                decodeMutationOptions(value[2]),
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                fixtureOptions,
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                newOrder: number[],
                options?: IPageOpsMutationOptions,
            ): TReorderArgs => [
                workingCopyPath,
                newOrder,
                options,
            ],
        ),
        insert: method(
            'insert',
            'page-ops:insert',
            args<TInsertArgs>(4, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodeSafeInteger(value, 1, 'totalPages'),
                decodeSafeInteger(value, 2, 'afterPage'),
                decodeMutationOptions(value[3]),
            ], () => [
                '/tmp/fixture.pdf',
                1,
                1,
                fixtureOptions,
            ]),
            insertResult,
            (
                workingCopyPath: string,
                totalPages: number,
                afterPage: number,
                options?: IPageOpsMutationOptions,
            ): TInsertArgs => [
                workingCopyPath,
                totalPages,
                afterPage,
                options,
            ],
        ),
        insertFile: method(
            'insertFile',
            'page-ops:insert-file',
            args<TInsertFileArgs>(6, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodeSafeInteger(value, 1, 'totalPages'),
                decodeSafeInteger(value, 2, 'afterPage'),
                decodeStringArray(value, 3, 'sourcePaths'),
                decodeOptionalString(value, 4, 'requestId'),
                decodeMutationOptions(value[5]),
            ], () => [
                '/tmp/fixture.pdf',
                1,
                1,
                ['/tmp/source.pdf'],
                'page-ops-fixture',
                fixtureOptions,
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                totalPages: number,
                afterPage: number,
                sourcePaths: string[],
                requestId?: string,
                options?: IPageOpsMutationOptions,
            ): TInsertFileArgs => [
                workingCopyPath,
                totalPages,
                afterPage,
                sourcePaths,
                requestId,
                options,
            ],
        ),
        rotate: method(
            'rotate',
            'page-ops:rotate',
            args<TRotateArgs>(5, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePositiveIntegerArray(value, 1, 'pages'),
                decodeSafeInteger(value, 2, 'totalPages', 1),
                decodeRotationAngle(value, 3),
                decodeMutationOptions(value[4]),
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                1,
                90,
                fixtureOptions,
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                pages: number[],
                totalPages: number,
                angle: TPageOpsRotationAngle,
                options?: IPageOpsMutationOptions,
            ): TRotateArgs => [
                workingCopyPath,
                pages,
                totalPages,
                angle,
                options,
            ],
        ),
        crop: method(
            'crop',
            'page-ops:crop',
            args<TCropArgs>(5, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePositiveIntegerArray(value, 1, 'pages'),
                decodeSafeInteger(value, 2, 'totalPages', 1),
                normalizeCropMargins(value[3]),
                decodeMutationOptions(value[4]),
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                1,
                {
                    top: 0,
                    bottom: 0,
                    left: 0,
                    right: 0,
                },
                fixtureOptions,
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                pages: number[],
                totalPages: number,
                margins: ICropMargins,
                options?: IPageOpsMutationOptions,
            ): TCropArgs => [
                workingCopyPath,
                pages,
                totalPages,
                margins,
                options,
            ],
        ),
        removeCrop: method(
            'removeCrop',
            'page-ops:remove-crop',
            args<TRemoveCropArgs>(4, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodePositiveIntegerArray(value, 1, 'pages'),
                decodeSafeInteger(value, 2, 'totalPages', 1),
                decodeMutationOptions(value[3]),
            ], () => [
                '/tmp/fixture.pdf',
                [1],
                1,
                fixtureOptions,
            ]),
            pageOpsResult,
            (
                workingCopyPath: string,
                pages: number[],
                totalPages: number,
                options?: IPageOpsMutationOptions,
            ): TRemoveCropArgs => [
                workingCopyPath,
                pages,
                totalPages,
                options,
            ],
        ),
        getPageGeometry: method(
            'getPageGeometry',
            'page-ops:get-page-geometry',
            args<TGetPageGeometryArgs>(2, value => [
                decodeString(value, 0, 'workingCopyPath'),
                decodeSafeInteger(value, 1, 'pageNumber', 1),
            ], () => [
                '/tmp/fixture.pdf',
                1,
            ]),
            pageGeometry,
            (workingCopyPath: string, pageNumber: number): TGetPageGeometryArgs => [
                workingCopyPath,
                pageNumber,
            ],
        ),
    },
    events: {},
});

export type IPageOpsCapability = TFeatureCapability<typeof PAGE_OPS_PLATFORM_FEATURE>;
export type IPageOpsInvokeMap = TFeatureInvokeMap<typeof PAGE_OPS_PLATFORM_FEATURE>;
