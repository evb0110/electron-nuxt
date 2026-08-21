const DEFAULT_WASM_LOAD_TIMEOUT_MS = 15_000;
const WASM_CONTENT_TYPE = 'application/wasm';

function servesWasmContentType(response: Response) {
    const contentType = response.headers.get('content-type') ?? '';
    return contentType.split(';', 1)[0]?.trim().toLowerCase() === WASM_CONTENT_TYPE;
}

function createWasmLoadTimeoutError(timeoutMs: number) {
    const error = new Error(`WASM module load timed out after ${timeoutMs}ms`);
    error.name = 'TimeoutError';
    return error;
}

export async function loadWasmWithDeadline(
    url: string,
    imports: WebAssembly.Imports = {},
    timeoutMs = DEFAULT_WASM_LOAD_TIMEOUT_MS,
) {
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
            abortController.abort(createWasmLoadTimeoutError(timeoutMs));
            reject(createWasmLoadTimeoutError(timeoutMs));
        }, timeoutMs);
    });

    try {
        return await Promise.race([
            (async () => {
                const response = await fetch(url, {signal: abortController.signal});
                if (!response.ok) {
                    throw new Error(`WASM module request failed with status ${response.status}`);
                }
                // Streaming compilation requires the wasm MIME type anyway, so branching
                // on it up front avoids a doomed streaming attempt whose failure could
                // otherwise leave the body consumed before the buffered fallback reads it.
                if (typeof WebAssembly.instantiateStreaming === 'function' && servesWasmContentType(response)) {
                    return WebAssembly.instantiateStreaming(response, imports);
                }
                const bytes = await response.arrayBuffer();
                return WebAssembly.instantiate(bytes, imports);
            })(),
            timeout,
        ]);
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
