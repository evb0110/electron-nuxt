import type {
    IPdfNativePagePreview,
    IPdfNativePageSize,
    IPdfNativePageSizes,
    TPdfNativePageSizes,
} from '@contracts/electronApiDocuments';
import {PDF_NATIVE_PAGE_SIZE_OVERRIDE_LIMIT} from '@contracts/electronApiDocuments';
import { requirePageNumber } from '@contracts/pageNumbers';
import {
    isFiniteNumber,
    isRecord,
} from '@contracts/runtimeGuards';
import {parseEpochMs} from '@contracts/timestamps';

function fail(message: string): never {
    throw new Error(message);
}

function decodeSafeIntegerValue(value: unknown, fieldName: string, min = 0) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
        fail(`${fieldName} must be a safe integer >= ${min}`);
    }
    return value;
}

function decodeUint8ArrayValue(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        fail(`${fieldName} must be a Uint8Array`);
    }
    return value;
}

const PDF_ROTATIONS = [
    0,
    90,
    180,
    270,
] as const;

function isPdfRotation(value: unknown): value is typeof PDF_ROTATIONS[number] {
    return PDF_ROTATIONS.some(rotation => rotation === value);
}

function decodeOpeningGeometry(value: unknown) {
    if (
        !isRecord(value)
        || value.pageNumber !== 1
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 1
        || !isFiniteNumber(value.width)
        || value.width <= 0
        || !isFiniteNumber(value.height)
        || value.height <= 0
        || !isPdfRotation(value.rotation)
        || typeof value.size !== 'number'
        || !Number.isSafeInteger(value.size)
        || value.size < 0
        || parseEpochMs(value.modifiedAt) === null
        || value.linearized !== undefined && typeof value.linearized !== 'boolean'
    ) {
        fail('invalid PDF opening geometry result');
    }
    return {
        pageNumber: requirePageNumber(1),
        pageCount: value.pageCount,
        width: value.width,
        height: value.height,
        rotation: value.rotation,
        size: value.size,
        modifiedAt: parseEpochMs(value.modifiedAt) ?? fail('invalid PDF modification time'),
        ...(value.linearized === undefined ? {} : {linearized: value.linearized}),
    };
}

function decodePageSize(value: unknown, fieldName: string): IPdfNativePageSize {
    if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) {
        fail(`invalid ${fieldName}`);
    }
    return {
        width: value.width,
        height: value.height,
    };
}

function decodePageSizesResult(value: unknown): TPdfNativePageSizes {
    if (Array.isArray(value)) {
        return value.map((item, index) => decodePageSize(item, `native page size ${String(index)}`));
    }
    if (!isRecord(value)) {
        fail('invalid native page sizes result');
    }
    const pageCount = decodeSafeIntegerValue(value.pageCount, 'native page sizes pageCount', 1);
    const defaultPageSize = decodePageSize(value.defaultPageSize, 'native default page size');
    if (
        !Array.isArray(value.overrides)
        || value.overrides.length > PDF_NATIVE_PAGE_SIZE_OVERRIDE_LIMIT
    ) {
        fail('native page sizes overrides must be an array');
    }
    const overrides = value.overrides.map((item, index) => {
        if (!isRecord(item)) {
            fail(`invalid native page size override ${String(index)}`);
        }
        const pageNumber = decodeSafeIntegerValue(
            item.pageNumber,
            `native page size override ${String(index)}.pageNumber`,
            1,
        );
        if (pageNumber > pageCount) {
            fail(`native page size override ${String(index)}.pageNumber exceeds pageCount`);
        }
        return {
            pageNumber: requirePageNumber(pageNumber, pageCount),
            ...decodePageSize(item, `native page size override ${String(index)}`),
        };
    });
    return {
        pageCount,
        defaultPageSize,
        overrides,
    } satisfies IPdfNativePageSizes;
}

function decodePagePreviewResult(value: unknown): IPdfNativePagePreview {
    if (!isRecord(value) || !isFiniteNumber(value.width) || !isFiniteNumber(value.height)) {
        fail('invalid native page preview result');
    }
    const rasterWidthCeilingPx = value.rasterWidthCeilingPx === undefined
        ? undefined
        : decodeSafeIntegerValue(value.rasterWidthCeilingPx, 'rasterWidthCeilingPx', 1);
    return {
        bytes: decodeUint8ArrayValue(value.bytes, 'bytes'),
        width: value.width,
        height: value.height,
        ...(rasterWidthCeilingPx === undefined ? {} : {rasterWidthCeilingPx}),
    };
}

export {
    decodeOpeningGeometry,
    decodePagePreviewResult,
    decodePageSizesResult,
    decodeSafeIntegerValue,
    decodeUint8ArrayValue,
    fail,
};
