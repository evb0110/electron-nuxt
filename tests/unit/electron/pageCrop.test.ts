import {
    mkdtemp,
    readFile,
    rm,
    truncate,
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
import {
    cropPagesLocal,
    removeCropFromPagesLocal,
} from '@electron/features/page-ops/main/cropLocal';
import { PdfPageOpsCapabilityError } from '@electron/features/page-ops/main/pageOpsErrors';

const mocks = vi.hoisted(() => ({
    ensureWorkingCopyDirectory: vi.fn(),
    readFileCount: 0,
    runNativeToolCommand: vi.fn(),
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));
vi.mock('fs/promises', async () => {
    const actual = await vi.importActual('fs/promises') as {
        [key: string]: unknown;
        readFile: typeof readFile;
    };
    return {
        ...actual,
        readFile: (...args: Parameters<typeof actual.readFile>) => {
            mocks.readFileCount += 1;
            return actual.readFile(...args);
        },
    };
});
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
        mocks.readFileCount = 0;
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

    it('uses native page geometry without loading the PDF in JavaScript', async () => {
        await createPdf(pdfPath, { inheritedCropBox: [
            20,
            10,
            180,
            90,
        ] });
        const nativeBinaryPath = join(tempDir, process.platform === 'win32' ? 'evb-pdf-page-ops.exe' : 'evb-pdf-page-ops');
        await writeFile(nativeBinaryPath, '');
        process.env.EVB_PDF_PAGE_OPS_ENABLE = '1';
        process.env.EVB_PDF_PAGE_OPS_PATH = nativeBinaryPath;
        mocks.runNativeToolCommand.mockImplementation(async (_binaryPath: string, args: string[]) => {
            expect(args.slice(0, 1)).toEqual(['page-geometry']);
            await writeFile(args[args.indexOf('--output') + 1]!, JSON.stringify({
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
            }));
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const loadSpy = vi.spyOn(PDFDocument, 'load');

        try {
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
        } finally {
            expect(loadSpy).not.toHaveBeenCalled();
            loadSpy.mockRestore();
        }
    });

    it('fails closed for a large path when native page geometry fails', async () => {
        await createPdf(pdfPath);
        await truncate(pdfPath, 2 * 1024 * 1024 * 1024 + 1);
        const nativeBinaryPath = join(tempDir, process.platform === 'win32' ? 'evb-pdf-page-ops.exe' : 'evb-pdf-page-ops');
        await writeFile(nativeBinaryPath, '');
        process.env.EVB_PDF_PAGE_OPS_ENABLE = '1';
        process.env.EVB_PDF_PAGE_OPS_PATH = nativeBinaryPath;
        mocks.runNativeToolCommand.mockRejectedValue(new Error('native geometry unavailable'));
        const loadSpy = vi.spyOn(PDFDocument, 'load');

        try {
            await expect(getPageGeometry(pdfPath, 1)).rejects.toMatchObject({
                name: 'PdfPageOpsCapabilityError',
                code: 'native-failure',
                operation: 'get-page-geometry',
            });
            expect(mocks.readFileCount).toBe(0);
            expect(loadSpy).not.toHaveBeenCalled();
        } finally {
            loadSpy.mockRestore();
        }
    });

    it('fails closed for large local crop compatibility calls', async () => {
        await createPdf(pdfPath);
        await truncate(pdfPath, 16 * 1024 * 1024 + 1);
        process.env.EVB_PDF_PAGE_OPS_DISABLE = '1';
        const loadSpy = vi.spyOn(PDFDocument, 'load');

        try {
            await expect(cropPagesLocal(pdfPath, [1], {
                top: 1,
                bottom: 1,
                left: 1,
                right: 1,
            })).rejects.toBeInstanceOf(PdfPageOpsCapabilityError);
            await expect(removeCropFromPagesLocal(pdfPath, [1])).rejects.toMatchObject({
                name: 'PdfPageOpsCapabilityError',
                code: 'native-unavailable',
            });
            expect(mocks.readFileCount).toBe(0);
            expect(loadSpy).not.toHaveBeenCalled();
        } finally {
            loadSpy.mockRestore();
        }
    });

    it('propagates cancellation while native page geometry is running', async () => {
        await createPdf(pdfPath);
        const nativeBinaryPath = join(tempDir, process.platform === 'win32' ? 'evb-pdf-page-ops.exe' : 'evb-pdf-page-ops');
        await writeFile(nativeBinaryPath, '');
        process.env.EVB_PDF_PAGE_OPS_ENABLE = '1';
        process.env.EVB_PDF_PAGE_OPS_PATH = nativeBinaryPath;
        mocks.runNativeToolCommand.mockImplementation(async (
            _binaryPath: string,
            _args: string[],
            options: {signal?: AbortSignal},
        ) => {
            await new Promise<never>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => {
                    const error = new Error('Operation aborted');
                    error.name = 'AbortError';
                    reject(error);
                }, {once: true});
            });
            throw new Error('unreachable');
        });
        const controller = new AbortController();
        const request = getPageGeometry(pdfPath, 1, undefined, controller.signal);
        controller.abort();

        await expect(request).rejects.toMatchObject({name: 'AbortError'});
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
