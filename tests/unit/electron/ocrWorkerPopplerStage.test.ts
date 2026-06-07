import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildPopplerEnv } from '@electron/ocr/worker/popplerStage';
import type { IWorkerPaths } from '@electron/ocr/worker/types';

const workerPaths: IWorkerPaths = {
    tesseractBinary: '/bin/tesseract',
    tessdataPath: '/share/tessdata',
    pdftoppmBinary: '/bin/pdftoppm',
    pdftotextBinary: '/bin/pdftotext',
    qpdfBinary: '/bin/qpdf',
    tempDir: '/tmp/ocr',
};

describe('buildPopplerEnv', () => {
    it('omits Poppler environment when no optional resource directories are configured', () => {
        expect(buildPopplerEnv(workerPaths)).toBeUndefined();
    });

    it('sets Poppler data and fontconfig paths when configured', () => {
        expect(buildPopplerEnv({
            ...workerPaths,
            popplerDataDir: '/share/poppler',
            popplerFontConfigDir: '/share/fontconfig',
        })).toEqual({
            POPPLER_DATADIR: '/share/poppler',
            FONTCONFIG_PATH: '/share/fontconfig',
            FONTCONFIG_FILE: '/share/fontconfig/fonts.conf',
        });
    });
});
