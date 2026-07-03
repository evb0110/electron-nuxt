import { isRecord } from '@contracts/runtimeGuards';
import type {
    IDocumentRevisionInfo,
    TDocumentRevisionAuthority,
} from '@contracts/documentRevision';
import type {
    IOcrWorkerStartPayload,
    TOcrWorkerInboundMessage,
} from '@electron/ocr/worker/types';
import {
    OcrPayloadValidationError,
    validateCancelRequestId,
    validateCreateSearchablePdfPayload,
} from '@electron/ocr/contracts';

const DOCUMENT_REVISION_AUTHORITIES: ReadonlySet<TDocumentRevisionAuthority> = new Set([
    'browser-document-store',
    'electron-working-copy',
]);

function parseDocumentRevisionInfo(value: unknown): IDocumentRevisionInfo | null {
    const authority = isRecord(value) ? value.authority : undefined;
    if (
        !isRecord(value)
        || value.version !== 1
        || typeof value.documentRef !== 'string'
        || typeof authority !== 'string'
        || !DOCUMENT_REVISION_AUTHORITIES.has(authority as TDocumentRevisionAuthority)
        || typeof value.token !== 'string'
        || value.token.length === 0
        || typeof value.contentRevision !== 'number'
        || !Number.isSafeInteger(value.contentRevision)
        || value.contentRevision < 1
        || typeof value.mintedAt !== 'number'
        || !Number.isFinite(value.mintedAt)
    ) {
        return null;
    }

    return {
        version: 1,
        documentRef: value.documentRef,
        authority: authority as TDocumentRevisionAuthority,
        token: value.token,
        contentRevision: value.contentRevision,
        mintedAt: value.mintedAt,
    };
}

export function parseOcrWorkerStartPayload(value: unknown): IOcrWorkerStartPayload | null {
    if (!isRecord(value)) {
        return null;
    }

    try {
        const documentRevision = parseDocumentRevisionInfo(value.documentRevision);
        if (!documentRevision) {
            return null;
        }
        const validated = validateCreateSearchablePdfPayload(
            value.sourcePdfPath,
            value.pages,
            'worker-start',
            value.options ?? value.renderDpi,
        );
        const payload: IOcrWorkerStartPayload = {
            sourcePdfPath: validated.sourcePdfPath,
            documentRevision,
            pages: validated.pages,
        };
        if (validated.options.renderDpi !== undefined) {
            payload.renderDpi = validated.options.renderDpi;
        }
        if (isRecord(value.options)) {
            payload.options = validated.options;
        }
        return payload;
    } catch (error) {
        if (error instanceof OcrPayloadValidationError) {
            return null;
        }
        throw error;
    }
}

function isValidRequestId(value: unknown) {
    try {
        validateCancelRequestId(value);
        return true;
    } catch (error) {
        if (error instanceof OcrPayloadValidationError) {
            return false;
        }
        throw error;
    }
}

function parseResourceAcquiredDpi(value: unknown) {
    if (
        typeof value !== 'number'
        || !Number.isFinite(value)
        || !Number.isInteger(value)
        || value < 1
    ) {
        return null;
    }
    return value;
}

function isValidWorkerId(value: unknown) {
    if (typeof value !== 'string') {
        return false;
    }
    try {
        validateCreateSearchablePdfPayload(
            '/worker-control-placeholder.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            value,
            180,
        );
        return true;
    } catch (error) {
        if (error instanceof OcrPayloadValidationError) {
            return false;
        }
        throw error;
    }
}

export function parseOcrWorkerInboundMessage(value: unknown): TOcrWorkerInboundMessage | null {
    if (!isRecord(value) || typeof value.jobId !== 'string' || !isValidWorkerId(value.jobId)) {
        return null;
    }
    const jobId = value.jobId;

    if (value.type === 'cancel') {
        return {
            type: 'cancel',
            jobId,
        };
    }

    if (value.type === 'resource-acquired') {
        const effectiveDpi = parseResourceAcquiredDpi(value.effectiveDpi);
        if (
            typeof value.requestId !== 'string'
            ||
            !isValidRequestId(value.requestId)
            || typeof value.token !== 'string'
            || effectiveDpi === null
        ) {
            return null;
        }
        const requestId = value.requestId;
        const token = value.token;
        return {
            type: 'resource-acquired',
            jobId,
            requestId,
            token,
            effectiveDpi,
        };
    }

    if (value.type === 'resource-denied') {
        if (
            typeof value.requestId !== 'string'
            || !isValidRequestId(value.requestId)
            || typeof value.reason !== 'string'
            || value.reason.trim().length === 0
        ) {
            return null;
        }
        return {
            type: 'resource-denied',
            jobId,
            requestId: value.requestId,
            reason: value.reason,
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
        jobId,
        data,
    };
}

export function parseInvalidOcrWorkerStartMessage(value: unknown) {
    if (
        !isRecord(value)
        || value.type !== 'start'
        || typeof value.jobId !== 'string'
        || !isValidWorkerId(value.jobId)
    ) {
        return null;
    }

    if (parseOcrWorkerStartPayload(value.data) !== null) {
        return null;
    }

    return {
        jobId: value.jobId,
        error: 'Invalid OCR worker start payload',
    };
}
