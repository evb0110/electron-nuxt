import type { TPageNumber } from '@contracts/pageNumbers';
import { requirePageNumber } from '@contracts/pageNumbers';

import type {
    IPdfDataPrintOptions,
    IPdfNativePrintDialogOpenedEvent,
    IPdfPathPrintOptions,
} from '@contracts/electronApiDocuments';
import {isRecord} from '@contracts/runtimeGuards';
import {requireRequestId} from '@contracts/shared';

const MAX_PDF_PRINT_REQUEST_ID_LENGTH = 128;

function decodePdfPrintRequestId(value: unknown, label: string) {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > MAX_PDF_PRINT_REQUEST_ID_LENGTH
    ) {
        throw new TypeError(`${label} must be a non-empty bounded string`);
    }
    return requireRequestId(value);
}

export function decodePdfPathPrintOptions(
    value: unknown,
    label: string,
): IPdfPathPrintOptions {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    if (value.viewMode !== 'single' && value.viewMode !== 'facing' && value.viewMode !== 'facing-first-single') {
        throw new TypeError(`${label}.viewMode is invalid`);
    }
    if (value.orientation !== 'auto' && value.orientation !== 'portrait' && value.orientation !== 'landscape') {
        throw new TypeError(`${label}.orientation is invalid`);
    }
    let pageNumbers: TPageNumber[] | undefined;
    if (value.pageNumbers !== undefined) {
        if (!Array.isArray(value.pageNumbers)) {
            throw new TypeError(`${label}.pageNumbers must be an array`);
        }
        pageNumbers = value.pageNumbers.map((pageNumber, index) => {
            if (typeof pageNumber !== 'number' || !Number.isSafeInteger(pageNumber) || pageNumber < 1) {
                throw new TypeError(`${label}.pageNumbers[${index}] must be a positive safe integer`);
            }
            return requirePageNumber(pageNumber);
        });
    }

    return {
        viewMode: value.viewMode,
        orientation: value.orientation,
        ...(pageNumbers === undefined ? {} : {pageNumbers}),
        ...(value.requestId === undefined
            ? {}
            : {requestId: decodePdfPrintRequestId(value.requestId, `${label}.requestId`)}),
    };
}

export function decodeOptionalPdfPathPrintOptions(
    value: unknown,
    label: string,
): IPdfPathPrintOptions | undefined {
    return value === undefined || value === null
        ? undefined
        : decodePdfPathPrintOptions(value, label);
}

export function decodePdfDataPrintOptions(
    value: unknown,
    label: string,
): IPdfDataPrintOptions {
    if (!isRecord(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value.requestId === undefined
        ? {}
        : {requestId: decodePdfPrintRequestId(value.requestId, `${label}.requestId`)};
}

export function decodeOptionalPdfDataPrintOptions(
    value: unknown,
    label: string,
): IPdfDataPrintOptions | undefined {
    return value === undefined || value === null
        ? undefined
        : decodePdfDataPrintOptions(value, label);
}

export function decodePdfNativePrintDialogOpenedEvent(
    value: unknown,
): IPdfNativePrintDialogOpenedEvent {
    if (!isRecord(value)) {
        throw new TypeError('native print dialog event must be an object');
    }
    return {requestId: decodePdfPrintRequestId(value.requestId, 'native print dialog event requestId')};
}
