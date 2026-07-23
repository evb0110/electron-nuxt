import type {
    IPdfSaveAsOptions,
    IPdfSerializedSaveOptions,
} from '@contracts/electronApiDocuments';
import {isPdfValidationResult} from '@contracts/documentPersistenceFrames';
import type { IPdfValidationResult } from '@contracts/pdfConformance';
import { isRecord } from '@contracts/runtimeGuards';

const pdfObjectRefPattern = /^\d+\s+\d+\s+R$/u;

export function decodeOptionalDocumentObject<T>(
    value: unknown,
    fieldName: string,
): T | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be an object`);
    }
    return value as T;
}

export function decodeRequiredDocumentObject<T>(value: unknown, fieldName: string): T {
    const decoded = decodeOptionalDocumentObject<T>(value, fieldName);
    if (decoded === undefined) {
        throw new Error(`${fieldName} must be an object`);
    }
    return decoded;
}

export function decodePdfSaveAsOptions(value: unknown): IPdfSaveAsOptions | undefined {
    const decoded = decodeOptionalDocumentObject<IPdfSaveAsOptions>(value, 'saveAsOptions');
    if (decoded?.optimizeLossless !== undefined && typeof decoded.optimizeLossless !== 'boolean') {
        throw new Error('invalid PDF save-as options');
    }
    return decoded === undefined ? undefined : {...decoded};
}

export function decodePdfRevisionOptions(value: unknown): IPdfSerializedSaveOptions | undefined {
    const decoded = decodeOptionalDocumentObject<IPdfSerializedSaveOptions>(value, 'revisionOptions');
    if (decoded !== undefined && typeof decoded.expectedDocumentRevisionToken !== 'string') {
        throw new Error('invalid document revision options');
    }
    if (decoded === undefined) {
        return undefined;
    }
    if (decoded.changedObjectRefs !== undefined && (
        !Array.isArray(decoded.changedObjectRefs)
        || decoded.changedObjectRefs.length > 128
        || !decoded.changedObjectRefs.every(ref =>
            typeof ref === 'string' && pdfObjectRefPattern.test(ref))
    )) {
        throw new Error('invalid changed PDF object references');
    }
    if (decoded.workingCopyOnly !== undefined && decoded.workingCopyOnly !== true) {
        throw new Error('invalid working-copy-only PDF staging option');
    }
    return {
        expectedDocumentRevisionToken: decoded.expectedDocumentRevisionToken,
        ...(decoded.changedObjectRefs?.length
            ? {changedObjectRefs: [...new Set(decoded.changedObjectRefs)]}
            : {}),
        ...(decoded.workingCopyOnly === true ? {workingCopyOnly: true as const} : {}),
    };
}

export function appendOptionalDocumentArg<TBase extends unknown[], TValue>(
    base: TBase,
    value: TValue | undefined,
): TBase | [...TBase, TValue] {
    return value === undefined ? base : [
        ...base,
        value,
    ];
}

export function decodePdfValidation(value: unknown): IPdfValidationResult {
    if (!isPdfValidationResult(value)) {
        throw new Error('invalid PDF validation result');
    }
    return {
        isValid: value.isValid,
        tool: value.tool,
        errors: [...value.errors],
        warnings: [...value.warnings],
    };
}

export function decodeNullablePdfValidation(value: unknown): IPdfValidationResult | null {
    return value === null ? null : decodePdfValidation(value);
}

export function decodePdfPathValidationResult(value: unknown) {
    if (!isRecord(value) || (value.path !== null && typeof value.path !== 'string')) {
        throw new Error('invalid PDF persistence result');
    }
    return {
        path: value.path,
        validation: decodeNullablePdfValidation(value.validation),
    };
}
