const RECOVERABLE_ASYNC_CHUNK_LOAD_PATTERNS = [
    'Failed to fetch dynamically imported module',
    'Importing a module script failed',
    'Outdated Optimize Dep',
];

interface IShouldRetryAsyncChunkLoadArgs {
    attempts: number;
    error: unknown;
    isDev: boolean;
    maxAttempts?: number;
}

export function getAsyncChunkLoadErrorMessage(error: unknown) {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error ?? '');
}

export function isRecoverableAsyncChunkLoadError(error: unknown) {
    const message = getAsyncChunkLoadErrorMessage(error);
    return RECOVERABLE_ASYNC_CHUNK_LOAD_PATTERNS.some(pattern => message.includes(pattern));
}

export function shouldRetryAsyncChunkLoad({
    attempts,
    error,
    isDev,
    maxAttempts = 3,
}: IShouldRetryAsyncChunkLoadArgs) {
    return isDev && attempts < maxAttempts && isRecoverableAsyncChunkLoadError(error);
}
