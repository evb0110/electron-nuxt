import type { TDocumentRef } from '@contracts/documentRef';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { isRecord } from '@contracts/runtimeGuards';

export const DOCUMENT_MUTATION_ERROR_PREFIX = 'EVB_DOCUMENT_MUTATION_ERROR:';

export type TDocumentMutationErrorCode =
    | 'MISSING_REVISION'
    | 'STALE_REVISION'
    | 'WORKING_COPY_SYNC_REQUIRED';

export interface IDocumentMutationErrorPayload {
    code: TDocumentMutationErrorCode;
    message: string;
    documentRef?: TDocumentRef;
    expectedRevision?: TDocumentRevisionToken | null;
    actualRevision?: TDocumentRevisionToken | null;
}

export class DocumentMutationError extends Error {
    readonly code: TDocumentMutationErrorCode;
    readonly documentRef: TDocumentRef | undefined;
    readonly expectedRevision: TDocumentRevisionToken | null | undefined;
    readonly actualRevision: TDocumentRevisionToken | null | undefined;

    constructor(payload: IDocumentMutationErrorPayload) {
        super(encodeDocumentMutationError(payload));
        this.name = 'DocumentMutationError';
        this.code = payload.code;
        this.documentRef = payload.documentRef;
        this.expectedRevision = payload.expectedRevision;
        this.actualRevision = payload.actualRevision;
    }
}

export function encodeDocumentMutationError(payload: IDocumentMutationErrorPayload) {
    return `${DOCUMENT_MUTATION_ERROR_PREFIX}${JSON.stringify(payload)}`;
}

function decodeDocumentMutationErrorMessage(message: string): IDocumentMutationErrorPayload | null {
    const markerIndex = message.indexOf(DOCUMENT_MUTATION_ERROR_PREFIX);
    if (markerIndex < 0) {
        return null;
    }

    const encoded = message.slice(markerIndex + DOCUMENT_MUTATION_ERROR_PREFIX.length).trim();
    try {
        const parsed: unknown = JSON.parse(encoded);
        if (!isRecord(parsed)) {
            return null;
        }
        if (
            parsed.code !== 'MISSING_REVISION'
            && parsed.code !== 'STALE_REVISION'
            && parsed.code !== 'WORKING_COPY_SYNC_REQUIRED'
        ) {
            return null;
        }
        const fallbackMessage = getDefaultDocumentMutationErrorMessage(parsed.code);
        const expectedRevision = parsed.expectedRevision === null
            ? null
            : parseDocumentRevisionToken(parsed.expectedRevision);
        const actualRevision = parsed.actualRevision === null
            ? null
            : parseDocumentRevisionToken(parsed.actualRevision);
        return {
            code: parsed.code,
            message: typeof parsed.message === 'string' && parsed.message.length > 0
                ? parsed.message
                : fallbackMessage,
            ...(typeof parsed.documentRef === 'string' ? {documentRef: parsed.documentRef} : {}),
            ...(expectedRevision !== null || parsed.expectedRevision === null
                ? {expectedRevision}
                : {}),
            ...(actualRevision !== null || parsed.actualRevision === null
                ? {actualRevision}
                : {}),
        };
    } catch {
        return null;
    }
}

export function getDocumentMutationErrorPayload(error: unknown): IDocumentMutationErrorPayload | null {
    if (error instanceof DocumentMutationError) {
        return decodeDocumentMutationErrorMessage(error.message) ?? {
            code: error.code,
            message: getDefaultDocumentMutationErrorMessage(error.code),
            ...(error.documentRef !== undefined ? {documentRef: error.documentRef} : {}),
            ...(error.expectedRevision !== undefined ? {expectedRevision: error.expectedRevision} : {}),
            ...(error.actualRevision !== undefined ? {actualRevision: error.actualRevision} : {}),
        };
    }
    if (isRecord(error)) {
        if (
            (
                error.code === 'MISSING_REVISION'
                || error.code === 'STALE_REVISION'
                || error.code === 'WORKING_COPY_SYNC_REQUIRED'
            )
            && typeof error.message === 'string'
        ) {
            const expectedRevision = error.expectedRevision === null
                ? null
                : parseDocumentRevisionToken(error.expectedRevision);
            const actualRevision = error.actualRevision === null
                ? null
                : parseDocumentRevisionToken(error.actualRevision);
            return {
                code: error.code,
                message: error.message,
                ...(typeof error.documentRef === 'string' ? {documentRef: error.documentRef} : {}),
                ...(expectedRevision !== null || error.expectedRevision === null
                    ? {expectedRevision}
                    : {}),
                ...(actualRevision !== null || error.actualRevision === null
                    ? {actualRevision}
                    : {}),
            };
        }
        const causePayload = getDocumentMutationErrorPayload(error.cause);
        if (causePayload) {
            return causePayload;
        }
    }
    return decodeDocumentMutationErrorMessage(getErrorMessage(error));
}

export function isDocumentMutationErrorCode(error: unknown, code: TDocumentMutationErrorCode) {
    return getDocumentMutationErrorPayload(error)?.code === code;
}

function getDefaultDocumentMutationErrorMessage(code: TDocumentMutationErrorCode) {
    if (code === 'MISSING_REVISION') {
        return 'Document revision token is required';
    }
    if (code === 'STALE_REVISION') {
        return 'Document revision is stale';
    }
    return 'Working copy must be resynced before further edits';
}

export function isMissingRevisionError(error: unknown) {
    return isDocumentMutationErrorCode(error, 'MISSING_REVISION');
}

export function isStaleRevisionError(error: unknown) {
    return isDocumentMutationErrorCode(error, 'STALE_REVISION');
}

export function isWorkingCopySyncRequiredError(error: unknown) {
    return isDocumentMutationErrorCode(error, 'WORKING_COPY_SYNC_REQUIRED');
}

export function createStaleRevisionError(payload: {
    documentRef?: TDocumentRef;
    expectedRevision?: TDocumentRevisionToken | null;
    actualRevision?: TDocumentRevisionToken | null;
    message?: string;
}) {
    return new DocumentMutationError({
        code: 'STALE_REVISION',
        message: payload.message ?? 'Document changed while this edit was being prepared',
        ...(payload.documentRef !== undefined ? {documentRef: payload.documentRef} : {}),
        ...(payload.expectedRevision !== undefined ? {expectedRevision: payload.expectedRevision} : {}),
        ...(payload.actualRevision !== undefined ? {actualRevision: payload.actualRevision} : {}),
    });
}

export function createMissingRevisionError(payload: {
    documentRef?: TDocumentRef;
    message?: string;
}) {
    return new DocumentMutationError({
        code: 'MISSING_REVISION',
        message: payload.message ?? 'Document revision token is required',
        ...(payload.documentRef !== undefined ? {documentRef: payload.documentRef} : {}),
    });
}

export function createWorkingCopySyncRequiredError(payload: {
    documentRef?: TDocumentRef;
    message?: string;
}) {
    return new DocumentMutationError({
        code: 'WORKING_COPY_SYNC_REQUIRED',
        message: payload.message ?? 'Working copy must be resynced before further edits',
        ...(payload.documentRef !== undefined ? {documentRef: payload.documentRef} : {}),
    });
}
