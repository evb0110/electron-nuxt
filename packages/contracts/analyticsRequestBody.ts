export interface IAnalyticsRequestBodyErrorFactory {
    createInvalidBodyError: (message: string) => Error;
    createOversizedBodyError: () => Error;
}

export function parseBoundedAnalyticsContentLength(
    value: string | undefined,
    maxBytes: number,
    errorFactory: IAnalyticsRequestBodyErrorFactory,
) {
    if (value === undefined) {
        return null;
    }
    if (!/^(0|[1-9]\d*)$/u.test(value)) {
        throw errorFactory.createInvalidBodyError('Invalid Content-Length');
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw errorFactory.createInvalidBodyError('Invalid Content-Length');
    }
    if (parsed > maxBytes) {
        throw errorFactory.createOversizedBodyError();
    }
    return parsed;
}

export async function decodeBoundedAnalyticsJsonStream(
    stream: ReadableStream<unknown>,
    declaredLength: number | null,
    maxBytes: number,
    errorFactory: IAnalyticsRequestBodyErrorFactory,
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
                throw errorFactory.createInvalidBodyError('Analytics request body contains invalid bytes');
            }
            totalBytes += result.value.byteLength;
            if (totalBytes > maxBytes) {
                throw errorFactory.createOversizedBodyError();
            }
            chunks.push(result.value);
        }
    } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
    }

    if (declaredLength !== null && declaredLength !== totalBytes) {
        throw errorFactory.createInvalidBodyError('Content-Length does not match request body');
    }
    if (totalBytes === 0) {
        throw errorFactory.createInvalidBodyError('Analytics request body is empty');
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
        throw errorFactory.createInvalidBodyError('Analytics request body must be valid JSON');
    }
}
