import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    buildPopplerEnv,
    preparePdfForPoppler,
} from '@electron/ocr/worker/popplerStage';
import type { IWorkerPaths } from '@electron/ocr/worker/types';

const mocks = vi.hoisted(() => ({
    runOcrCommand: vi.fn(),
    stat: vi.fn(),
}));

vi.mock('@electron/ocr/worker/runOcrCommand', () => ({ runOcrCommand: mocks.runOcrCommand }));

vi.mock('fs/promises', () => ({ stat: mocks.stat }));

const workerPaths: IWorkerPaths = {
    tesseractBinary: '/bin/tesseract',
    tessdataPath: '/share/tessdata',
    pdftoppmBinary: '/bin/pdftoppm',
    pdftotextBinary: '/bin/pdftotext',
    qpdfBinary: '/bin/qpdf',
    tempDir: '/tmp/ocr',
};

describe('buildPopplerEnv', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

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

describe('preparePdfForPoppler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.stat.mockResolvedValue({ size: 1024 });
    });

    it('returns surfaced warnings when qpdf preflight falls back to the original PDF', async () => {
        mocks.runOcrCommand.mockRejectedValueOnce(new Error('qpdf failed'));
        const log = vi.fn();
        const trackTempFile = vi.fn((path: string) => path);

        const result = await preparePdfForPoppler(
            workerPaths,
            log,
            '/tmp/source.pdf',
            'session',
            trackTempFile,
        );

        expect(result).toEqual({
            pdfPath: '/tmp/source.pdf',
            warnings: ['qpdf preflight failed; falling back to original PDF for Poppler commands: qpdf failed'],
        });
        expect(log).toHaveBeenCalledWith('warn', result.warnings[0]);
    });
});
