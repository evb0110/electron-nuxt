import {toSearchIpcError} from '@electron/features/search/main/searchErrors';
import {
    describe,
    expect,
    it,
} from 'vitest';

describe('native search error mapping', () => {
    it.each([
        [
            'invalid-request',
            'SEARCH_INVALID_PAYLOAD',
            false,
        ],
        [
            'too-large',
            'SEARCH_WORKER_LIMIT',
            false,
        ],
        [
            'corrupt-xref',
            'SEARCH_WORKER_ERROR',
            false,
        ],
        [
            'unsupported-filter',
            'SEARCH_WORKER_ERROR',
            false,
        ],
        [
            'io',
            'SEARCH_WORKER_ERROR',
            true,
        ],
        [
            'native-failure',
            'SEARCH_WORKER_ERROR',
            true,
        ],
    ] as const)('maps %s exclusively by code', (nativeCode, searchCode, retryable) => {
        const error = Object.assign(new Error('translated detail'), {code: nativeCode});
        expect(toSearchIpcError(error).errorEnvelope).toMatchObject({
            code: searchCode,
            retryable,
        });
    });
});
