import {
    describe,
    expect,
    it,
} from 'vitest';
import { parseBrowserSearchWorkerRequest } from '@app/platform/browser-api/browserSearchWorker.types';
import { parseBrowserPdfCombineWorkerRequest } from '@app/platform/browser-api/browserPdfCombineWorker.types';
import { parseBrowserPageOpsWorkerRequest } from '@app/platform/browser-api/browserPageOpsWorker.types';

describe('browser worker request parsers', () => {
    it('parses and rejects browser search worker requests', () => {
        expect(parseBrowserSearchWorkerRequest({
            id: 1,
            type: 'extractDocumentText',
            payload: {pdfPath: '/tmp/file.pdf'},
        })).toEqual({
            id: 1,
            type: 'extractDocumentText',
            payload: {pdfPath: '/tmp/file.pdf'},
        });

        expect(parseBrowserSearchWorkerRequest({
            id: 2,
            type: 'cancel',
            payload: {requestId: 1},
        })).toEqual({
            id: 2,
            type: 'cancel',
            payload: {requestId: 1},
        });

        expect(parseBrowserSearchWorkerRequest({
            id: 3,
            type: 'extractDocumentText',
            payload: {pdfPath: ''},
        })).toBeNull();
    });

    it('parses and rejects browser PDF combine worker requests', () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);
        expect(parseBrowserPdfCombineWorkerRequest({
            id: 4,
            type: 'combinePdfs',
            payload: {inputs: [{
                fileName: 'a.pdf',
                data,
            }]},
        })).toEqual({
            id: 4,
            type: 'combinePdfs',
            payload: {inputs: [{
                fileName: 'a.pdf',
                data,
            }]},
        });

        expect(parseBrowserPdfCombineWorkerRequest({
            id: 5,
            type: 'combinePdfs',
            payload: {inputs: [{
                fileName: 'a.pdf',
                data: [
                    1,
                    2,
                    3,
                ],
            }]},
        })).toBeNull();
    });

    it('parses and rejects browser page operation worker requests', () => {
        const data = new Uint8Array([
            1,
            2,
            3,
        ]);
        expect(parseBrowserPageOpsWorkerRequest({
            id: 6,
            type: 'rotate',
            payload: {
                data,
                pages: [
                    1,
                    2,
                ],
                angle: 90,
            },
        })).toEqual({
            id: 6,
            type: 'rotate',
            payload: {
                data,
                pages: [
                    1,
                    2,
                ],
                angle: 90,
            },
        });

        expect(parseBrowserPageOpsWorkerRequest({
            id: 7,
            type: 'crop',
            payload: {
                data,
                pages: [1],
                margins: {
                    top: 1,
                    bottom: 2,
                    left: 3,
                    right: 4,
                },
            },
        })).toEqual({
            id: 7,
            type: 'crop',
            payload: {
                data,
                pages: [1],
                margins: {
                    top: 1,
                    bottom: 2,
                    left: 3,
                    right: 4,
                },
            },
        });

        expect(parseBrowserPageOpsWorkerRequest({
            id: 8,
            type: 'rotate',
            payload: {
                data,
                pages: [1],
                angle: 45,
            },
        })).toBeNull();
    });
});
