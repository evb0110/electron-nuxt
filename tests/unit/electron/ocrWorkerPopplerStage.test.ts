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
    renderPdfPageToPng,
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

describe('renderPdfPageToPng', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders OCR rasters against the PDF CropBox contract', async () => {
        const log = vi.fn();

        await renderPdfPageToPng(
            workerPaths,
            log,
            3,
            '/tmp/source.pdf',
            '/tmp/page-3.png',
            300,
        );

        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/pdftoppm',
            [
                '-png',
                '-cropbox',
                '-r',
                '300',
                '-f',
                '3',
                '-l',
                '3',
                '-singlefile',
                '/tmp/source.pdf',
                '/tmp/page-3',
            ],
            expect.objectContaining({commandLabel: 'pdftoppm(page=3,dpi=300)'}),
        );
    });

    it('renders only the requested positive pixel crop', async () => {
        const log = vi.fn();

        await renderPdfPageToPng(
            workerPaths,
            log,
            3,
            '/tmp/source.pdf',
            '/tmp/page-3.png',
            300,
            undefined,
            undefined,
            {
                x: 11,
                y: 22,
                width: 333,
                height: 444,
            },
        );

        expect(mocks.runOcrCommand).toHaveBeenCalledWith(
            '/bin/pdftoppm',
            [
                '-png',
                '-cropbox',
                '-r',
                '300',
                '-f',
                '3',
                '-l',
                '3',
                '-singlefile',
                '-x',
                '11',
                '-y',
                '22',
                '-W',
                '333',
                '-H',
                '444',
                '/tmp/source.pdf',
                '/tmp/page-3',
            ],
            expect.objectContaining({commandLabel: 'pdftoppm(page=3,dpi=300)'}),
        );
    });

    it.each([
        [
            'x',
            -1,
        ],
        [
            'y',
            -1,
        ],
        [
            'width',
            1.5,
        ],
        [
            'height',
            Number.MAX_SAFE_INTEGER + 1,
        ],
    ] as const)('rejects an invalid %s crop value', async (field, value) => {
        const crop = {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
            [field]: value,
        };

        await expect(renderPdfPageToPng(
            workerPaths,
            vi.fn(),
            3,
            '/tmp/source.pdf',
            '/tmp/page-3.png',
            300,
            undefined,
            undefined,
            crop,
        )).rejects.toThrow(
            `Poppler pixel crop ${field} must be a ${
                field === 'x' || field === 'y' ? 'non-negative' : 'positive'
            } safe integer`,
        );
        expect(mocks.runOcrCommand).not.toHaveBeenCalled();
    });
});
