import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveWorkerPaths } from '@electron/ocr/worker/resolveWorkerPaths';

const requiredWorkerPaths = {
    tesseractBinary: '/bin/tesseract',
    tessdataPath: '/share/tessdata',
    pdftoppmBinary: '/bin/pdftoppm',
    pdftotextBinary: '/bin/pdftotext',
    qpdfBinary: '/bin/qpdf',
    tempDir: '/tmp/ocr',
};

describe('resolveWorkerPaths', () => {
    it('accepts required and optional OCR worker paths', () => {
        expect(resolveWorkerPaths({
            ...requiredWorkerPaths,
            pdfimagesBinary: '/bin/pdfimages',
            popplerDataDir: '/share/poppler',
            popplerFontConfigDir: '/share/fontconfig',
            unpaperBinary: '/bin/unpaper',
        })).toEqual({
            ...requiredWorkerPaths,
            pdfimagesBinary: '/bin/pdfimages',
            popplerDataDir: '/share/poppler',
            popplerFontConfigDir: '/share/fontconfig',
            unpaperBinary: '/bin/unpaper',
        });
    });

    it('normalizes missing or blank optional paths to undefined', () => {
        expect(resolveWorkerPaths({
            ...requiredWorkerPaths,
            pdfimagesBinary: '',
            popplerDataDir: '   ',
        })).toEqual(requiredWorkerPaths);
    });

    it('rejects missing required OCR worker paths', () => {
        expect(() => resolveWorkerPaths({
            ...requiredWorkerPaths,
            qpdfBinary: '',
        })).toThrow('Invalid OCR workerData.qpdfBinary path');
    });
});
