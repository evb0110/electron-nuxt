import {
    getOcrPaths,
    getOcrToolPaths,
    validateOcrTools,
    type IOcrPaths,
    type IOcrToolPaths,
    type IToolValidationResult,
} from '@electron/ocr/paths';

export type {
    IOcrPaths,
    IOcrToolPaths,
    IToolValidationResult,
};

export function getNativeToolPaths(): IOcrToolPaths {
    return getOcrToolPaths();
}

export function getNativeTesseractPaths(): IOcrPaths {
    return getOcrPaths();
}

export async function validateNativeTools(): Promise<IToolValidationResult> {
    return validateOcrTools();
}
