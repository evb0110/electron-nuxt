import type {
    ISearchErrorEnvelope,
    ISearchErrorEnvelopeCarrier,
    TSearchErrorCode,
} from '@contracts/search';
import { getErrorMessage } from '@electron/utils/error';

const SEARCH_ERROR_DETAILS_MAX_LENGTH = 1_000;

function trimSearchErrorDetails(details: string) {
    const trimmed = details.trim();
    if (trimmed.length <= SEARCH_ERROR_DETAILS_MAX_LENGTH) {
        return trimmed;
    }
    return `${trimmed.slice(0, SEARCH_ERROR_DETAILS_MAX_LENGTH - 3)}...`;
}

export class SearchIpcError extends Error implements ISearchErrorEnvelopeCarrier {
    readonly errorEnvelope: ISearchErrorEnvelope;
    readonly code: TSearchErrorCode;

    constructor(envelope: ISearchErrorEnvelope) {
        super(envelope.message);
        this.name = 'SearchIpcError';
        this.errorEnvelope = envelope;
        this.code = envelope.code;
    }
}

export function buildSearchErrorEnvelope(
    code: TSearchErrorCode,
    message: string,
    options: {
        retryable?: boolean;
        details?: string;
    } = {},
): ISearchErrorEnvelope {
    const envelope: ISearchErrorEnvelope = {
        code,
        message,
        retryable: options.retryable ?? false,
        timestamp: Date.now(),
    };
    if (options.details) {
        envelope.details = trimSearchErrorDetails(options.details);
    }
    return envelope;
}

export function toSearchIpcError(
    error: unknown,
    fallbackCode: TSearchErrorCode = 'SEARCH_INTERNAL',
    retryable = false,
) {
    if (error instanceof SearchIpcError) {
        return error;
    }
    return new SearchIpcError(buildSearchErrorEnvelope(
        fallbackCode,
        getErrorMessage(error) || 'Search failed',
        {retryable},
    ));
}
