import type {
    TPdfViewMode,
    TPrintOrientation,
} from '@contracts/shared';
import { isRecord } from '@contracts/runtimeGuards';

const PDF_PRINT_LAYOUT_UTILITY_REQUEST_FIELDS = new Set([
    'inputPath',
    'outputPath',
    'pageNumbers',
    'viewMode',
    'orientation',
]);

export interface IPdfPrintLayoutUtilityRequest {
    inputPath: string;
    outputPath: string;
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

export type TPdfPrintLayoutUtilityResult =
    | {
        type: 'result';
        ok: true;
        bytes: number;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
    };

function isPrintViewMode(value: unknown): value is TPdfViewMode {
    return value === 'single' || value === 'facing' || value === 'facing-first-single';
}

function isPrintOrientation(value: unknown): value is TPrintOrientation {
    return value === 'auto' || value === 'portrait' || value === 'landscape';
}

function isPrintPageNumbers(value: unknown): value is number[] {
    return Array.isArray(value)
        && value.length > 0
        && value.every(pageNumber => (
            typeof pageNumber === 'number'
            && Number.isSafeInteger(pageNumber)
            && pageNumber >= 1
        ));
}

export function decodePdfPrintLayoutUtilityRequest(value: unknown): IPdfPrintLayoutUtilityRequest | null {
    if (
        !isRecord(value)
        || Object.keys(value).some(key => !PDF_PRINT_LAYOUT_UTILITY_REQUEST_FIELDS.has(key))
        || typeof value.inputPath !== 'string'
        || value.inputPath.length === 0
        || typeof value.outputPath !== 'string'
        || value.outputPath.length === 0
        || !isPrintViewMode(value.viewMode)
        || !isPrintOrientation(value.orientation)
    ) {
        return null;
    }
    if (
        value.pageNumbers !== undefined
        && !isPrintPageNumbers(value.pageNumbers)
    ) {
        return null;
    }
    return {
        inputPath: value.inputPath,
        outputPath: value.outputPath,
        viewMode: value.viewMode,
        orientation: value.orientation,
        ...(value.pageNumbers === undefined ? {} : {pageNumbers: value.pageNumbers}),
    };
}

export function decodePdfPrintLayoutUtilityResult(value: unknown): TPdfPrintLayoutUtilityResult | null {
    if (!isRecord(value) || value.type !== 'result' || typeof value.ok !== 'boolean') {
        return null;
    }
    if (value.ok) {
        return typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes > 0
            ? {
                type: 'result',
                ok: true,
                bytes: value.bytes,
            }
            : null;
    }
    return typeof value.error === 'string' && value.error.length > 0
        ? {
            type: 'result',
            ok: false,
            error: value.error,
        }
        : null;
}
