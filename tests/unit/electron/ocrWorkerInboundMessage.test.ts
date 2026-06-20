import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    parseOcrWorkerInboundMessage,
    parseOcrWorkerStartPayload,
} from '@electron/ocr/worker/inboundMessage';

describe('OCR worker inbound message parsing', () => {
    it('parses start payloads with normalized source path and optional render DPI', () => {
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: ' /tmp/source.pdf ',
            pages: [{
                pageNumber: 2,
                languages: ['eng'],
            }],
            renderDpi: 240,
        })).toEqual({
            sourcePdfPath: '/tmp/source.pdf',
            pages: [{
                pageNumber: 2,
                languages: ['eng'],
            }],
            renderDpi: 240,
        });
    });

    it('parses searchable PDF options while keeping render DPI compatibility', () => {
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '/tmp/source.pdf',
            pages: [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            options: {
                renderDpi: 360,
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 6,
            },
        })).toEqual({
            sourcePdfPath: '/tmp/source.pdf',
            pages: [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            renderDpi: 360,
            options: {
                renderDpi: 360,
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 6,
            },
        });
    });

    it('rejects malformed start payloads', () => {
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '',
            pages: [],
        })).toBeNull();
        expect(parseOcrWorkerStartPayload({
            sourcePdfPath: '/tmp/source.pdf',
            pages: [{
                pageNumber: 1,
                languages: [1],
            }],
        })).toBeNull();
    });

    it('parses worker control messages', () => {
        expect(parseOcrWorkerInboundMessage({
            type: 'cancel',
            jobId: 'job-1',
        })).toEqual({
            type: 'cancel',
            jobId: 'job-1',
        });
        expect(parseOcrWorkerInboundMessage({
            type: 'resource-acquired',
            jobId: 'job-1',
            requestId: 'resource-1',
            token: 'token',
            effectiveDpi: 180,
        })).toEqual({
            type: 'resource-acquired',
            jobId: 'job-1',
            requestId: 'resource-1',
            token: 'token',
            effectiveDpi: 180,
        });
    });

    it('rejects unknown or incomplete worker messages', () => {
        expect(parseOcrWorkerInboundMessage({
            type: 'start',
            jobId: 'job-1',
        })).toBeNull();
        expect(parseOcrWorkerInboundMessage({
            type: 'resource-acquired',
            jobId: 'job-1',
        })).toBeNull();
        expect(parseOcrWorkerInboundMessage({
            type: 'unknown',
            jobId: 'job-1',
        })).toBeNull();
    });
});
