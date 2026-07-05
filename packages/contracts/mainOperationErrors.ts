import { getErrorMessage } from '@contracts/getErrorMessage';
import { isRecord } from '@contracts/runtimeGuards';

export const MAIN_OPERATION_ERROR_PREFIX = 'EVB_MAIN_OPERATION_ERROR:';

export type TMainOperationErrorCode = 'shutting-down';

export interface IMainOperationErrorEnvelope {
    code: TMainOperationErrorCode;
    message: string;
}

export class MainOperationError extends Error {
    readonly errorEnvelope: IMainOperationErrorEnvelope;

    constructor(envelope: IMainOperationErrorEnvelope) {
        super(encodeMainOperationErrorEnvelope(envelope));
        this.name = 'MainOperationError';
        this.errorEnvelope = envelope;
    }
}

export function encodeMainOperationErrorEnvelope(envelope: IMainOperationErrorEnvelope) {
    return `${MAIN_OPERATION_ERROR_PREFIX}${JSON.stringify(envelope)}`;
}

function decodeMainOperationErrorMessage(message: string): IMainOperationErrorEnvelope | null {
    const markerIndex = message.indexOf(MAIN_OPERATION_ERROR_PREFIX);
    if (markerIndex < 0) {
        return null;
    }

    const encoded = message.slice(markerIndex + MAIN_OPERATION_ERROR_PREFIX.length).trim();
    try {
        const parsed: unknown = JSON.parse(encoded);
        if (!isRecord(parsed) || parsed.code !== 'shutting-down') {
            return null;
        }
        return {
            code: parsed.code,
            message: typeof parsed.message === 'string' && parsed.message.length > 0
                ? parsed.message
                : 'Main process is shutting down',
        };
    } catch {
        return null;
    }
}

export function getMainOperationErrorEnvelope(error: unknown): IMainOperationErrorEnvelope | null {
    if (error instanceof MainOperationError) {
        return error.errorEnvelope;
    }
    if (isRecord(error)) {
        if (
            isRecord(error.errorEnvelope)
            && error.errorEnvelope.code === 'shutting-down'
            && typeof error.errorEnvelope.message === 'string'
        ) {
            return {
                code: error.errorEnvelope.code,
                message: error.errorEnvelope.message,
            };
        }
        const causeEnvelope = getMainOperationErrorEnvelope(error.cause);
        if (causeEnvelope) {
            return causeEnvelope;
        }
    }
    return decodeMainOperationErrorMessage(getErrorMessage(error));
}

export function createMainOperationShuttingDownError(message = 'Main process is shutting down') {
    return new MainOperationError({
        code: 'shutting-down',
        message,
    });
}
