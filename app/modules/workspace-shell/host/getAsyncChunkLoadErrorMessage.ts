import { getErrorMessage } from '@app/utils/error';

export function getAsyncChunkLoadErrorMessage(error: unknown) {
    return getErrorMessage(error ?? '');
}
