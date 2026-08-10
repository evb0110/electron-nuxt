import {
    createError,
    getHeader,
    getRequestWebStream,
    type H3Event,
} from 'h3';
import {
    decodeBoundedAnalyticsJsonStream as decodeBoundedAnalyticsJsonStreamCore,
    parseBoundedAnalyticsContentLength,
} from '@contracts/analyticsRequestBody';

function createInvalidBodyError(message: string) {
    return createError({
        statusCode: 400,
        statusMessage: message,
    });
}

function createOversizedBodyError() {
    return createError({
        statusCode: 413,
        statusMessage: 'Analytics request body is too large',
    });
}

export function parseAnalyticsContentLength(
    value: string | undefined,
    maxBytes: number,
) {
    return parseBoundedAnalyticsContentLength(value, maxBytes, {
        createInvalidBodyError,
        createOversizedBodyError,
    });
}

export async function decodeBoundedAnalyticsJsonStream(
    stream: ReadableStream<unknown>,
    declaredLength: number | null,
    maxBytes: number,
) {
    return decodeBoundedAnalyticsJsonStreamCore(stream, declaredLength, maxBytes, {
        createInvalidBodyError,
        createOversizedBodyError,
    });
}

export async function readBoundedAnalyticsJsonBody(
    event: H3Event,
    maxBytes: number,
) {
    const declaredLength = parseAnalyticsContentLength(
        getHeader(event, 'content-length'),
        maxBytes,
    );
    const stream = getRequestWebStream(event);
    if (!stream) {
        throw createInvalidBodyError('Analytics request body is unavailable');
    }
    return decodeBoundedAnalyticsJsonStream(stream, declaredLength, maxBytes);
}
