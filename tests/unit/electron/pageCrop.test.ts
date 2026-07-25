import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    cropPages,
    getPageGeometry,
    removeCropFromPages,
} from '@electron/features/page-ops/main/crop';

const mocks = vi.hoisted(() => ({
    ensureWorkingCopyDirectory: vi.fn(),
    runNativeToolCommand: vi.fn(),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));
vi.mock('@electron/native-tools/runNativeToolCommand', () => ({runNativeToolCommand: (...args: unknown[]) => mocks.runNativeToolCommand(...args)}));

const originalEnv = { ...process.env };

async function createPdf(path: string, options?: { inheritedCropBox?: [number, number, number, number] }) {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([
        200,
        100,
    ]);

    if (options?.inheritedCropBox) {
        page.node.Parent()?.set(PDFName.of('CropBox'), pdfDoc.context.obj(options.inheritedCropBox));
    }

    await writeFile(path, await pdfDoc.save());
}

describe('page crop operations', () => {
    let tempDir = '';
    let pdfPath = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        process.env = { ...originalEnv };
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        tempDir = await mkdtemp(join(tmpdir(), 'page-crop-test-'));
        pdfPath = join(tempDir, 'sample.pdf');
    });

    afterEach(async () => {
        process.env = { ...originalEnv };
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('reports inherited crop boxes in page geometry', async () => {
        await createPdf(pdfPath, { inheritedCropBox: [
            20,
            10,
            180,
            90,
        ] });

        await expect(getPageGeometry(pdfPath, 1)).resolves.toEqual({
            mediaBox: {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            cropBox: {
                x: 20,
                y: 10,
                width: 160,
                height: 80,
            },
            rotation: 0,
        });
    });

    it('reports the PDF.js effective crop box when CropBox extends outside MediaBox', async () => {
        await createPdf(pdfPath, { inheritedCropBox: [
            -20,
            10,
            180,
            120,
        ] });

        await expect(getPageGeometry(pdfPath, 1)).resolves.toEqual({
            mediaBox: {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            cropBox: {
                x: 0,
                y: 10,
                width: 180,
                height: 90,
            },
            rotation: 0,
        });
    });

    it('removes inherited crop boxes by restoring the media box', async () => {
        await createPdf(pdfPath, { inheritedCropBox: [
            20,
            10,
            180,
            90,
        ] });

        await removeCropFromPages(pdfPath, [1]);

        const reloaded = await PDFDocument.load(await readFile(pdfPath));
        const page = reloaded.getPage(0);

        expect(page.getCropBox()).toEqual(page.getMediaBox());
        await expect(getPageGeometry(pdfPath, 1)).resolves.toEqual({
            mediaBox: {
                x: 0,
                y: 0,
                width: 200,
                height: 100,
            },
            cropBox: null,
            rotation: 0,
        });
    });

    it('rejects non-finite crop margins before writing the document', async () => {
        await createPdf(pdfPath);

        await expect(cropPages(pdfPath, [1], {
            top: Number.NaN,
            bottom: 0,
            left: 0,
            right: 0,
        })).rejects.toThrow('Invalid crop margins');
    });

    it('rejects crop margins that consume the selected page and leaves the document untouched', async () => {
        await createPdf(pdfPath);
        const originalBytes = await readFile(pdfPath);

        await expect(cropPages(pdfPath, [1], {
            top: 0,
            bottom: 0,
            left: 120,
            right: 80,
        })).rejects.toThrow('Crop margins consume page 1');

        await expect(readFile(pdfPath)).resolves.toEqual(originalBytes);
    });

    it('rejects pages outside the document range and leaves the document untouched', async () => {
        await createPdf(pdfPath);
        const originalBytes = await readFile(pdfPath);

        await expect(cropPages(pdfPath, [5], {
            top: 1,
            bottom: 1,
            left: 1,
            right: 1,
        })).rejects.toThrow('Page 5 is outside the document page range 1-1');

        await expect(readFile(pdfPath)).resolves.toEqual(originalBytes);
    });

    it('publishes the native crop without parsing the document in JavaScript', async () => {
        await createPdf(pdfPath);
        const nativeBinaryPath = join(tempDir, process.platform === 'win32' ? 'evb-pdf-page-ops.exe' : 'evb-pdf-page-ops');
        await writeFile(nativeBinaryPath, '');
        process.env.EVB_PDF_PAGE_OPS_ENABLE = '1';
        process.env.EVB_PDF_PAGE_OPS_PATH = nativeBinaryPath;
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            await writeFile(args[args.indexOf('--output') + 1]!, '%PDF-1.7\nnative crop');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const loadSpy = vi.spyOn(PDFDocument, 'load');
        let javaScriptParseCount = 0;

        try {
            await cropPages(pdfPath, [1], {
                top: 10,
                bottom: 10,
                left: 10,
                right: 10,
            });
        } finally {
            javaScriptParseCount = loadSpy.mock.calls.length;
            loadSpy.mockRestore();
        }

        expect(javaScriptParseCount).toBe(0);
        await expect(readFile(pdfPath, 'utf8')).resolves.toBe('%PDF-1.7\nnative crop');
    });

    it('recovers the working-copy directory before local crop reads', async () => {
        await createPdf(pdfPath);

        await cropPages(pdfPath, [1], {
            top: 1,
            bottom: 1,
            left: 1,
            right: 1,
        }, 17);

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith(pdfPath, 17);
        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledTimes(1);
    });

    it('recovers the working-copy directory before local page geometry reads', async () => {
        await createPdf(pdfPath);

        await getPageGeometry(pdfPath, 1, 17);

        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledWith(pdfPath, 17);
        expect(mocks.ensureWorkingCopyDirectory).toHaveBeenCalledTimes(1);
    });
});
