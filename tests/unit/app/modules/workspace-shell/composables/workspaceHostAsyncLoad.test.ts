import {
    describe,
    expect,
    it,
} from 'vitest';
import { getAsyncChunkLoadErrorMessage } from '@app/modules/workspace-shell/host/getAsyncChunkLoadErrorMessage';
import { isRecoverableAsyncChunkLoadError } from '@app/modules/workspace-shell/host/isRecoverableAsyncChunkLoadError';
import { shouldRetryAsyncChunkLoad } from '@app/modules/workspace-shell/host/shouldRetryAsyncChunkLoad';

describe('workspace async chunk load helpers', () => {
    it('extracts error messages from unknown values', () => {
        expect(getAsyncChunkLoadErrorMessage(new Error('boom'))).toBe('boom');
        expect(getAsyncChunkLoadErrorMessage('plain')).toBe('plain');
    });

    it('detects recoverable async chunk load errors', () => {
        expect(isRecoverableAsyncChunkLoadError(new Error('Failed to fetch dynamically imported module'))).toBe(true);
        expect(isRecoverableAsyncChunkLoadError(new Error('Importing a module script failed'))).toBe(true);
        expect(isRecoverableAsyncChunkLoadError(new Error('Outdated Optimize Dep'))).toBe(true);
        expect(isRecoverableAsyncChunkLoadError(new Error('Unexpected token'))).toBe(false);
    });

    it('retries only in development and within retry budget', () => {
        const recoverable = new Error('Failed to fetch dynamically imported module');

        expect(shouldRetryAsyncChunkLoad({
            attempts: 1,
            error: recoverable,
            isDev: true,
        })).toBe(true);

        expect(shouldRetryAsyncChunkLoad({
            attempts: 3,
            error: recoverable,
            isDev: true,
        })).toBe(false);

        expect(shouldRetryAsyncChunkLoad({
            attempts: 1,
            error: recoverable,
            isDev: false,
        })).toBe(false);
    });
});
