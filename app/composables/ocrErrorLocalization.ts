import type { TTranslationKey } from '@i18n-app';
import { useTypedI18n } from '@app/composables/useTypedI18n';

const REMOTE_METHOD_PREFIX_RE = /^Error invoking remote method '[^']+':\s*/u;

export const OCR_ERROR_MESSAGE_KEYS = [
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

export type TOcrErrorFallbackKey = (typeof OCR_ERROR_MESSAGE_KEYS)[number];

export interface IOcrErrorLocalizer { localizeOcrError: (errorValue: unknown, fallbackKey: TOcrErrorFallbackKey) => string; }

function normalizeOcrErrorMessage(message: string) {
    return message.replace(REMOTE_METHOD_PREFIX_RE, '').trim();
}

function truncateOcrErrorDetails(message: string) {
    const trimmed = message.trim();
    if (trimmed.length <= 240) {
        return trimmed;
    }
    return `${trimmed.slice(0, 237)}...`;
}

export function useOcrErrorLocalizer(): IOcrErrorLocalizer {
    const { t } = useTypedI18n();

    function isKnownLocalizedOcrError(message: string) {
        return OCR_ERROR_MESSAGE_KEYS
            .map(key => t(key))
            .includes(message);
    }

    function localizeOcrError(errorValue: unknown, fallbackKey: TOcrErrorFallbackKey) {
        const rawMessage = typeof errorValue === 'string'
            ? errorValue
            : (errorValue instanceof Error ? errorValue.message : '');
        if (!rawMessage) {
            return t(fallbackKey);
        }

        const normalized = normalizeOcrErrorMessage(rawMessage);
        if (isKnownLocalizedOcrError(rawMessage)) {
            return rawMessage;
        }
        if (isKnownLocalizedOcrError(normalized)) {
            return normalized;
        }

        if (
            normalized === 'Invalid file path'
            || normalized === 'Invalid file path: path must be a non-empty string'
        ) {
            return t('errors.file.invalid');
        }

        if (
            normalized === 'Invalid file path: reads only allowed within temp directory'
            || normalized === 'Invalid file path: writes only allowed within temp directory'
        ) {
            return t(fallbackKey);
        }

        return `${t(fallbackKey)}: ${truncateOcrErrorDetails(normalized)}`;
    }

    return { localizeOcrError };
}
