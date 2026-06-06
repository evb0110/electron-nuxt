import type { TTranslationKey } from '@i18n-app';

export const ocrErrorMessageKeys = [
    'errors.file.invalid',
    'errors.ocr.loadLanguages',
    'errors.ocr.noValidPages',
    'errors.ocr.timeout',
    'errors.ocr.start',
    'errors.ocr.noPdfData',
    'errors.ocr.createSearchablePdf',
    'errors.ocr.noText',
    'errors.ocr.exportDocx',
] as const satisfies readonly TTranslationKey[];

export type TOcrErrorFallbackKey = (typeof ocrErrorMessageKeys)[number];
