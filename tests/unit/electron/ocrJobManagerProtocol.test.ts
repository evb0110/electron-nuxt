import {
    describe,
    expect,
    it,
} from 'vitest';
import { parseWorkerMessage } from '@electron/ocr/jobManagerProtocol';

describe('parseWorkerMessage', () => {
    it('preserves source revision tokens on successful completion messages', () => {
        expect(parseWorkerMessage({
            type: 'complete',
            jobId: 'job-1',
            result: {
                success: true,
                pdfPath: '/tmp/searchable.pdf',
                sourceDocumentRevisionToken: 'source-revision-token',
                requiresCleanupAck: true,
                errors: [],
            },
        })).toEqual({
            type: 'complete',
            jobId: 'job-1',
            result: {
                success: true,
                pdfPath: '/tmp/searchable.pdf',
                sourceDocumentRevisionToken: 'source-revision-token',
                requiresCleanupAck: true,
                errors: [],
            },
        });
    });

    it('rejects successful completion messages without a source revision token', () => {
        expect(parseWorkerMessage({
            type: 'complete',
            jobId: 'job-1',
            result: {
                success: true,
                pdfPath: '/tmp/searchable.pdf',
                requiresCleanupAck: true,
                errors: [],
            },
        })).toBeNull();
    });

    it('preserves valid worker error envelopes on failed completion messages', () => {
        const errorEnvelope = {
            code: 'OCR_INVALID_PAYLOAD',
            message: 'Invalid OCR worker start payload',
            retryable: false,
            timestamp: 123,
        };

        expect(parseWorkerMessage({
            type: 'complete',
            jobId: 'job-1',
            result: {
                success: false,
                errors: ['Invalid OCR worker start payload'],
                errorEnvelope,
            },
        })).toEqual({
            type: 'complete',
            jobId: 'job-1',
            result: {
                success: false,
                errors: ['Invalid OCR worker start payload'],
                errorEnvelope,
            },
        });
    });

    it('drops malformed worker error envelopes while preserving the failed completion', () => {
        expect(parseWorkerMessage({
            type: 'complete',
            jobId: 'job-1',
            result: {
                success: false,
                errors: ['failure'],
                errorEnvelope: {
                    code: 'NOT_A_CODE',
                    message: 'failure',
                    retryable: false,
                    timestamp: 123,
                },
            },
        })).toEqual({
            type: 'complete',
            jobId: 'job-1',
            result: {
                success: false,
                errors: ['failure'],
            },
        });
    });
});
