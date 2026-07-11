const DEFAULT_WASM_LOAD_TIMEOUT_MS = 15_000;

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
