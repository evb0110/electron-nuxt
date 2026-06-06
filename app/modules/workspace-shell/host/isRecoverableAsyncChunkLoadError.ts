import { getAsyncChunkLoadErrorMessage } from '@app/modules/workspace-shell/host/getAsyncChunkLoadErrorMessage';

const RECOVERABLE_ASYNC_CHUNK_LOAD_PATTERNS = [
    'Failed to fetch dynamically imported module',
    'Importing a module script failed',
    'Outdated Optimize Dep',
];

export function isRecoverableAsyncChunkLoadError(error: unknown) {
    const message = getAsyncChunkLoadErrorMessage(error);
    return RECOVERABLE_ASYNC_CHUNK_LOAD_PATTERNS.some(pattern => message.includes(pattern));
}
