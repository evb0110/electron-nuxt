import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodePdfPrintLayoutUtilityRequest,
    decodePdfPrintLayoutUtilityResult,
} from '@electron/features/documents/main/pdfPrintLayoutUtilityProtocol';

describe('PDF print layout utility protocol', () => {
    it('decodes a valid request and preserves page selection', () => {
        expect(decodePdfPrintLayoutUtilityRequest({
            inputPath: '/documents/source.pdf',
            outputPath: '/documents/printable.pdf',
            pageNumbers: [
                1,
                4,
                7,
            ],
            viewMode: 'facing-first-single',
            orientation: 'landscape',
        })).toEqual({
            inputPath: '/documents/source.pdf',
            outputPath: '/documents/printable.pdf',
            pageNumbers: [
                1,
                4,
                7,
            ],
            viewMode: 'facing-first-single',
            orientation: 'landscape',
        });
    });

    it.each([
        [
            'null',
            null,
        ],
        [
            'undefined',
            undefined,
        ],
        [
            'string',
            'request',
        ],
        [
            'number',
            42,
        ],
        [
            'array',
            [],
        ],
        [
            'unexpected property',
            {
                inputPath: '/in.pdf',
                outputPath: '/out.pdf',
                viewMode: 'single',
                orientation: 'auto',
                executable: '/tmp/untrusted',
            },
        ],
        [
            'missing input path',
            {
                outputPath: '/out.pdf',
                viewMode: 'single',
                orientation: 'auto',
            },
        ],
        [
            'empty output path',
            {
                inputPath: '/in.pdf',
                outputPath: '',
                viewMode: 'single',
                orientation: 'auto',
            },
        ],
        [
            'unknown view mode',
            {
                inputPath: '/in.pdf',
                outputPath: '/out.pdf',
                viewMode: 'continuous',
                orientation: 'auto',
            },
        ],
        [
            'unknown orientation',
            {
                inputPath: '/in.pdf',
                outputPath: '/out.pdf',
                viewMode: 'single',
                orientation: 'square',
            },
        ],
        [
            'zero page number',
            {
                inputPath: '/in.pdf',
                outputPath: '/out.pdf',
                pageNumbers: [0],
                viewMode: 'single',
                orientation: 'auto',
            },
        ],
        [
            'fractional page number',
            {
                inputPath: '/in.pdf',
                outputPath: '/out.pdf',
                pageNumbers: [1.5],
                viewMode: 'single',
                orientation: 'auto',
            },
        ],
        [
            'non-array page numbers',
            {
                inputPath: '/in.pdf',
                outputPath: '/out.pdf',
                pageNumbers: '1',
                viewMode: 'single',
                orientation: 'auto',
            },
        ],
        [
            'empty page numbers',
            {
                inputPath: '/in.pdf',
                outputPath: '/out.pdf',
                pageNumbers: [],
                viewMode: 'single',
                orientation: 'auto',
            },
        ],
    ] as const)('rejects %s', (_description, value) => {
        expect(decodePdfPrintLayoutUtilityRequest(value)).toBeNull();
    });

    it('decodes successful and failed utility results', () => {
        expect(decodePdfPrintLayoutUtilityResult({
            type: 'result',
            ok: true,
            bytes: 4_096,
        })).toEqual({
            type: 'result',
            ok: true,
            bytes: 4_096,
        });
        expect(decodePdfPrintLayoutUtilityResult({
            type: 'result',
            ok: false,
            error: 'PDF has no printable pages',
        })).toEqual({
            type: 'result',
            ok: false,
            error: 'PDF has no printable pages',
        });
    });

    it.each([
        [
            'unknown result type',
            {
                type: 'error',
                ok: false,
                error: 'failed',
            },
        ],
        [
            'zero output bytes',
            {
                type: 'result',
                ok: true,
                bytes: 0,
            },
        ],
        [
            'fractional output bytes',
            {
                type: 'result',
                ok: true,
                bytes: 1.5,
            },
        ],
        [
            'empty failure message',
            {
                type: 'result',
                ok: false,
                error: '',
            },
        ],
    ] as const)('rejects %s', (_description, value) => {
        expect(decodePdfPrintLayoutUtilityResult(value)).toBeNull();
    });
});
