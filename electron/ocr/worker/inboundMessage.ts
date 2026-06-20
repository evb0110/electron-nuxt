import { isRecord } from '@contracts/runtimeGuards';
import type {
    IOcrSearchablePdfOptions,
    TOcrPreprocessingMode,
    TOcrQualityProfile,
} from '@contracts/electronApiOcr';
import type {
    IOcrPdfPageRequest,
    IOcrWorkerStartPayload,
    TOcrWorkerInboundMessage,
} from '@electron/ocr/worker/types';

const OCR_QUALITY_PROFILES = new Set<TOcrQualityProfile>([
    'balanced',
    'accurate',
    'poor-scan',
]);
const OCR_PREPROCESSING_MODES = new Set<TOcrPreprocessingMode>([
    'off',
    'clean',
]);

function toStringArray(value: unknown) {
    if (!Array.isArray(value)) {
        return null;
    }
    if (!value.every(item => typeof item === 'string')) {
        return null;
    }
    return value;
}

function parsePdfPageRequest(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }
    if (typeof value.pageNumber !== 'number' || !Number.isFinite(value.pageNumber)) {
        return null;
    }
    const languages = toStringArray(value.languages);
    if (!languages) {
        return null;
    }
    return {
        pageNumber: value.pageNumber,
        languages,
    };
}

function parsePdfPageRequests(value: unknown) {
    if (!Array.isArray(value)) {
        return null;
    }

    const pages: IOcrPdfPageRequest[] = [];
    for (const page of value) {
        const parsedPage = parsePdfPageRequest(page);
        if (!parsedPage) {
            return null;
        }
        pages.push(parsedPage);
    }

    return pages;
}

function parseOptionalDpi(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function parseOptionalPageSegmentationMode(value: unknown) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 13
        ? value
        : undefined;
}

function parseOcrWorkerOptions(value: unknown): IOcrSearchablePdfOptions | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (!isRecord(value)) {
        return undefined;
    }

    const options: IOcrSearchablePdfOptions = {};
    const renderDpi = parseOptionalDpi(value.renderDpi);
    const qualityProfile = typeof value.qualityProfile === 'string' && OCR_QUALITY_PROFILES.has(value.qualityProfile as TOcrQualityProfile)
        ? value.qualityProfile as TOcrQualityProfile
        : undefined;
    const preprocessingMode = typeof value.preprocessingMode === 'string' && OCR_PREPROCESSING_MODES.has(value.preprocessingMode as TOcrPreprocessingMode)
        ? value.preprocessingMode as TOcrPreprocessingMode
        : undefined;
    const pageSegmentationMode = parseOptionalPageSegmentationMode(value.pageSegmentationMode);

    if (renderDpi !== undefined) {
        options.renderDpi = renderDpi;
    }
    if (qualityProfile !== undefined) {
        options.qualityProfile = qualityProfile;
    }
    if (preprocessingMode !== undefined) {
        options.preprocessingMode = preprocessingMode;
    }
    if (pageSegmentationMode !== undefined) {
        options.pageSegmentationMode = pageSegmentationMode;
    }
    return options;
}

export function parseOcrWorkerStartPayload(value: unknown): IOcrWorkerStartPayload | null {
    if (!isRecord(value)) {
        return null;
    }

    const sourcePdfPath = typeof value.sourcePdfPath === 'string'
        ? value.sourcePdfPath.trim()
        : '';
    const pages = parsePdfPageRequests(value.pages);
    if (!sourcePdfPath || !pages) {
        return null;
    }

    const payload: IOcrWorkerStartPayload = {
        sourcePdfPath,
        pages,
    };
    const options = parseOcrWorkerOptions(value.options);
    const renderDpi = parseOptionalDpi(value.renderDpi);
    if (renderDpi !== undefined) {
        payload.renderDpi = renderDpi;
    }
    if (options !== undefined) {
        payload.options = options;
        if (payload.renderDpi === undefined && options.renderDpi !== undefined) {
            payload.renderDpi = options.renderDpi;
        }
    }
    return payload;
}

export function parseOcrWorkerInboundMessage(value: unknown): TOcrWorkerInboundMessage | null {
    if (!isRecord(value) || typeof value.jobId !== 'string') {
        return null;
    }

    if (value.type === 'cancel') {
        return {
            type: 'cancel',
            jobId: value.jobId,
        };
    }

    if (value.type === 'resource-acquired') {
        if (
            typeof value.requestId !== 'string'
            || typeof value.token !== 'string'
            || typeof value.effectiveDpi !== 'number'
            || !Number.isFinite(value.effectiveDpi)
        ) {
            return null;
        }
        return {
            type: 'resource-acquired',
            jobId: value.jobId,
            requestId: value.requestId,
            token: value.token,
            effectiveDpi: value.effectiveDpi,
        };
    }

    if (value.type !== 'start') {
        return null;
    }

    const data = parseOcrWorkerStartPayload(value.data);
    if (!data) {
        return null;
    }

    return {
        type: 'start',
        jobId: value.jobId,
        data,
    };
}
