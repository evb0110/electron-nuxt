import {
    describe,
    expect,
    it,
} from 'vitest';
import { decodeWorkingCopyBackingStatus } from '@contracts/electronApiDocuments';

describe('working-copy backing status contract', () => {
    it('decodes and sanitizes renderer-visible backing status', () => {
        expect(decodeWorkingCopyBackingStatus({
            documentRef: '/tmp/managed.pdf',
            failure: {
                code: 'WORKING_COPY_MATERIALIZATION_NO_SPACE',
                retryable: true,
                originalPath: '/private/source.pdf',
            },
            originalPath: '/private/source.pdf',
            progress: 0.75,
            state: 'materializing',
        })).toEqual({
            documentRef: '/tmp/managed.pdf',
            failure: {
                code: 'WORKING_COPY_MATERIALIZATION_NO_SPACE',
                retryable: true,
            },
            progress: 0.75,
            state: 'materializing',
        });
    });

    it.each([
        {
            documentRef: '',
            failure: null,
            progress: 0,
            state: 'lazy-original',
        },
        {
            documentRef: '/tmp/a.pdf',
            failure: null,
            progress: -0.1,
            state: 'materializing',
        },
        {
            documentRef: '/tmp/a.pdf',
            failure: null,
            progress: 1.1,
            state: 'materializing',
        },
        {
            documentRef: '/tmp/a.pdf',
            failure: null,
            progress: 0.5,
            state: 'copied',
        },
        {
            documentRef: '/tmp/a.pdf',
            failure: {
                code: 'ENOSPC',
                retryable: true,
            },
            progress: 0.5,
            state: 'materializing',
        },
    ])('rejects malformed status %#', (status) => {
        expect(decodeWorkingCopyBackingStatus(status)).toBeNull();
    });
});
