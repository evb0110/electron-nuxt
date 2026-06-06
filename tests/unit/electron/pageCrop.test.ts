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

const mocks = vi.hoisted(() => ({ensureWorkingCopyDirectory: vi.fn()}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));
vi.mock('@electron/ipc/workingCopyCreation', () => ({ensureWorkingCopyDirectory: (...args: unknown[]) => mocks.ensureWorkingCopyDirectory(...args)}));

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
        mocks.ensureWorkingCopyDirectory.mockResolvedValue(true);
        tempDir = await mkdtemp(join(tmpdir(), 'page-crop-test-'));
        pdfPath = join(tempDir, 'sample.pdf');
    });

    afterEach(async () => {
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
