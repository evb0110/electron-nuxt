import { uniq } from 'es-toolkit/array';
import { AVAILABLE_OCR_LANGUAGE_CODES } from '@electron/ocr/available-languages';
import { parseIntegerEnv } from '@electron/utils/env';

type TOcrErrorCode =
    | 'OCR_INVALID_PAYLOAD'
    | 'OCR_INTERNAL_ERROR'
    | 'OCR_QUEUE_BACKPRESSURE'
    | 'OCR_WORKER_UNAVAILABLE'
    | 'OCR_TOOLS_VALIDATION_FAILED';

interface IOcrErrorEnvelope {
    code: TOcrErrorCode;
    message: string;
    retryable: boolean;
    timestamp: number;
    details?: string;
}

interface IOcrRecognizePageRequest {
    pageNumber: number;
    imageData: Uint8Array;
    languages: string[];
}

interface IOcrCreatePdfPageRequest {
    pageNumber: number;
    languages: string[];
}

interface IOcrRecognizeBatchPayload {
    pages: IOcrRecognizePageRequest[];
    requestId: string;
}

interface IOcrCreateSearchablePdfPayload {
    sourcePdfPath: string;
    pages: IOcrCreatePdfPageRequest[];
    requestId: string;
    renderDpi?: number;
}

const MAX_PAGE_NUMBER = 1_000_000;
const MAX_LANGUAGES_PER_PAGE = 16;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_BATCH_PAGES = 5_000;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_ERROR_DETAILS_LENGTH = 512;
const MAX_UNIQUE_LANGUAGES_PER_JOB = parseIntegerEnv(
    'EVB_OCR_MAX_UNIQUE_LANGUAGES_PER_JOB',
    AVAILABLE_OCR_LANGUAGE_CODES.size,
    1,
    AVAILABLE_OCR_LANGUAGE_CODES.size,
);

export class OcrPayloadValidationError extends Error {
    readonly code: TOcrErrorCode;

    constructor(message: string, code: TOcrErrorCode = 'OCR_INVALID_PAYLOAD') {
        super(message);
        this.name = 'OcrPayloadValidationError';
        this.code = code;
    }
}

function trimErrorDetails(input: string) {
    const normalized = input.trim();
    if (normalized.length <= MAX_ERROR_DETAILS_LENGTH) {
        return normalized;
    }
    return `${normalized.slice(0, MAX_ERROR_DETAILS_LENGTH - 3)}...`;
}

function asString(value: unknown, fieldName: string, maxLength = 1_024) {
    if (typeof value !== 'string') {
        throw new OcrPayloadValidationError(`${fieldName} must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed) {
        throw new OcrPayloadValidationError(`${fieldName} must not be empty`);
    }
    if (trimmed.length > maxLength) {
        throw new OcrPayloadValidationError(`${fieldName} exceeds maximum length (${maxLength})`);
    }
    return trimmed;
}

function asPositiveInteger(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
        throw new OcrPayloadValidationError(`${fieldName} must be a positive integer`);
    }
    if (value > MAX_PAGE_NUMBER) {
        throw new OcrPayloadValidationError(`${fieldName} exceeds maximum value (${MAX_PAGE_NUMBER})`);
    }
    return value;
}

function asOptionalDpi(value: unknown, fieldName: string) {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new OcrPayloadValidationError(`${fieldName} must be a finite number`);
    }
    const rounded = Math.round(value);
    if (rounded < 72 || rounded > 1200) {
        throw new OcrPayloadValidationError(`${fieldName} must be between 72 and 1200`);
    }
    return rounded;
}

function toUint8Array(value: unknown, fieldName: string, maxBytes: number) {
    let bytes: Uint8Array;

    if (value instanceof Uint8Array) {
        bytes = value;
    } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
    } else if (ArrayBuffer.isView(value)) {
        bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } else {
        throw new OcrPayloadValidationError(`${fieldName} must be a Uint8Array`);
    }

    if (bytes.byteLength === 0) {
        throw new OcrPayloadValidationError(`${fieldName} must not be empty`);
    }
    if (bytes.byteLength > maxBytes) {
        throw new OcrPayloadValidationError(`${fieldName} exceeds maximum size (${maxBytes} bytes)`);
    }

    return bytes;
}

function asLanguages(value: unknown, fieldName: string) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new OcrPayloadValidationError(`${fieldName} must be a non-empty array`);
    }
    if (value.length > MAX_LANGUAGES_PER_PAGE) {
        throw new OcrPayloadValidationError(`${fieldName} exceeds maximum size (${MAX_LANGUAGES_PER_PAGE})`);
    }

    const parsed = value.map((languageCode, index) => asString(languageCode, `${fieldName}[${index}]`, 32));
    const unique = uniq(parsed);
    for (const languageCode of unique) {
        if (!AVAILABLE_OCR_LANGUAGE_CODES.has(languageCode)) {
            throw new OcrPayloadValidationError(`Unsupported OCR language: ${languageCode}`);
        }
    }
    return unique;
}

function assertUniqueLanguageBudget(
    pages: Array<{ languages: string[] }>,
    fieldName: string,
) {
    const uniqueLanguages = uniq(pages.flatMap(page => page.languages));
    if (uniqueLanguages.length > MAX_UNIQUE_LANGUAGES_PER_JOB) {
        throw new OcrPayloadValidationError(
            `${fieldName} exceed maximum unique language count (${MAX_UNIQUE_LANGUAGES_PER_JOB})`,
        );
    }
}

function asRecognizePageRequest(payload: unknown, fieldName: string): IOcrRecognizePageRequest {
    if (!payload || typeof payload !== 'object') {
        throw new OcrPayloadValidationError(`${fieldName} must be an object`);
    }

    const record = payload as Record<string, unknown>;
    return {
        pageNumber: asPositiveInteger(record.pageNumber, `${fieldName}.pageNumber`),
        imageData: toUint8Array(record.imageData, `${fieldName}.imageData`, MAX_IMAGE_BYTES),
        languages: asLanguages(record.languages, `${fieldName}.languages`),
    };
}

function asCreatePdfPageRequest(payload: unknown, fieldName: string): IOcrCreatePdfPageRequest {
    if (!payload || typeof payload !== 'object') {
        throw new OcrPayloadValidationError(`${fieldName} must be an object`);
    }

    const record = payload as Record<string, unknown>;
    return {
        pageNumber: asPositiveInteger(record.pageNumber, `${fieldName}.pageNumber`),
        languages: asLanguages(record.languages, `${fieldName}.languages`),
    };
}

function asRequestId(value: unknown, fieldName: string) {
    return asString(value, fieldName, MAX_REQUEST_ID_LENGTH);
}

export function validateRecognizeRequest(payload: unknown): IOcrRecognizePageRequest {
    return asRecognizePageRequest(payload, 'request');
}

export function validateRecognizeBatchPayload(
    pagesPayload: unknown,
    requestIdPayload: unknown,
): IOcrRecognizeBatchPayload {
    if (!Array.isArray(pagesPayload) || pagesPayload.length === 0) {
        throw new OcrPayloadValidationError('pages must be a non-empty array');
    }
    if (pagesPayload.length > MAX_BATCH_PAGES) {
        throw new OcrPayloadValidationError(`pages exceeds maximum size (${MAX_BATCH_PAGES})`);
    }

    const pages = pagesPayload.map((page, index) => asRecognizePageRequest(page, `pages[${index}]`));
    assertUniqueLanguageBudget(pages, 'pages');
    return {
        pages,
        requestId: asRequestId(requestIdPayload, 'requestId'),
    };
}

export function validateCreateSearchablePdfPayload(
    sourcePdfPathPayload: unknown,
    pagesPayload: unknown,
    requestIdPayload: unknown,
    renderDpiPayload?: unknown,
): IOcrCreateSearchablePdfPayload {
    if (!Array.isArray(pagesPayload) || pagesPayload.length === 0) {
        throw new OcrPayloadValidationError('pages must be a non-empty array');
    }
    if (pagesPayload.length > MAX_BATCH_PAGES) {
        throw new OcrPayloadValidationError(`pages exceeds maximum size (${MAX_BATCH_PAGES})`);
    }

    const pages = pagesPayload.map((page, index) => asCreatePdfPageRequest(page, `pages[${index}]`));
    assertUniqueLanguageBudget(pages, 'pages');

    return {
        sourcePdfPath: asString(sourcePdfPathPayload, 'sourcePdfPath', 4_096),
        pages,
        requestId: asRequestId(requestIdPayload, 'requestId'),
        renderDpi: asOptionalDpi(renderDpiPayload, 'renderDpi'),
    };
}

export function validateCancelRequestId(requestIdPayload: unknown): string {
    return asRequestId(requestIdPayload, 'requestId');
}

export function mapStartFailureCode(message: string): TOcrErrorCode {
    const normalized = message.toLowerCase();
    if (normalized.includes('queue') && normalized.includes('full')) {
        return 'OCR_QUEUE_BACKPRESSURE';
    }
    if (
        normalized.includes('worker')
        && (
            normalized.includes('missing')
            || normalized.includes('unavailable')
            || normalized.includes('not found')
        )
    ) {
        return 'OCR_WORKER_UNAVAILABLE';
    }
    return 'OCR_INTERNAL_ERROR';
}

export function buildOcrErrorEnvelope(
    code: TOcrErrorCode,
    message: string,
    options: {
        retryable?: boolean;
        details?: string;
    } = {},
): IOcrErrorEnvelope {
    return {
        code,
        message,
        retryable: options.retryable ?? false,
        timestamp: Date.now(),
        details: options.details ? trimErrorDetails(options.details) : undefined,
    };
}

export function toOcrErrorEnvelope(
    error: unknown,
    fallbackCode: TOcrErrorCode = 'OCR_INTERNAL_ERROR',
    retryable = false,
): IOcrErrorEnvelope {
    if (error instanceof OcrPayloadValidationError) {
        return buildOcrErrorEnvelope(error.code, error.message, {retryable: false});
    }
    if (error instanceof Error) {
        return buildOcrErrorEnvelope(fallbackCode, error.message || 'Unknown OCR error', {
            retryable,
            details: error.stack,
        });
    }
    return buildOcrErrorEnvelope(fallbackCode, 'Unknown OCR error', {
        retryable,
        details: String(error),
    });
}
