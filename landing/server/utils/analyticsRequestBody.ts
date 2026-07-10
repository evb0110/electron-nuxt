import {
    createError,
    getHeader,
    getRequestWebStream,
    type H3Event,
} from 'h3';

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

export function parseLandingAnalyticsContentLength(
    value: string | undefined,
    maxBytes: number,
) {
    if (value === undefined) {
        return null;
    }
    if (!/^(0|[1-9]\d*)$/u.test(value)) {
        throw createInvalidBodyError('Invalid Content-Length');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw createInvalidBodyError('Invalid Content-Length');
    }
    if (parsed > maxBytes) {
        throw createOversizedBodyError();
    }
    return parsed;
}

export async function decodeBoundedLandingAnalyticsJsonStream(
    stream: ReadableStream<unknown>,
    declaredLength: number | null,
    maxBytes: number,
) {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) {
                break;
            }
            if (!(result.value instanceof Uint8Array)) {
                throw createInvalidBodyError('Analytics request body contains invalid bytes');
            }
            totalBytes += result.value.byteLength;
            if (totalBytes > maxBytes) {
                throw createOversizedBodyError();
            }
            chunks.push(result.value);
        }
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    }

    if (declaredLength !== null && declaredLength !== totalBytes) {
        throw createInvalidBodyError('Content-Length does not match request body');
    }
    if (totalBytes === 0) {
        throw createInvalidBodyError('Analytics request body is empty');
    }

    const bodyBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        bodyBytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    try {
        return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bodyBytes)) as unknown;
    } catch {
        throw createInvalidBodyError('Analytics request body must be valid JSON');
    }
}

export async function readBoundedLandingAnalyticsJsonBody(
    event: H3Event,
    maxBytes: number,
) {
    const declaredLength = parseLandingAnalyticsContentLength(
        getHeader(event, 'content-length'),
        maxBytes,
    );
    const stream = getRequestWebStream(event);
    if (!stream) {
        throw createInvalidBodyError('Analytics request body is unavailable');
    }
    return decodeBoundedLandingAnalyticsJsonStream(stream, declaredLength, maxBytes);
}
