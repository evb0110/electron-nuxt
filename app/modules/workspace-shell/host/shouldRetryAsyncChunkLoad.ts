import { isRecoverableAsyncChunkLoadError } from '@app/modules/workspace-shell/host/isRecoverableAsyncChunkLoadError';

interface IShouldRetryAsyncChunkLoadArgs {
    attempts: number;
    error: unknown;
    isDev: boolean;
    maxAttempts?: number;
}

export function shouldRetryAsyncChunkLoad({
    attempts,
    error,
    isDev,
    maxAttempts = 3,
}: IShouldRetryAsyncChunkLoadArgs) {
    return isDev && attempts < maxAttempts && isRecoverableAsyncChunkLoadError(error);
}
