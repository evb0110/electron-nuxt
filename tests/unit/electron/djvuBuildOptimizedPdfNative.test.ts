import {
    mkdtemp,
    rm,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';

const mocks = vi.hoisted(() => ({nativeBuild: vi.fn()}));

vi.mock('@electron/image/tryCreatePdfWithNativeImageCombiner', () => ({tryBuildOptimizedPdfWithNativeImageCombiner: (...args: unknown[]) => mocks.nativeBuild(...args)}));

describe('DjVu optimized PDF native fast path', () => {
    let tempDir = '';

    beforeEach(async () => {
        vi.clearAllMocks();
        tempDir = await mkdtemp(join(tmpdir(), 'djvu-native-pdf-test-'));
    });

    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, {
                recursive: true,
                force: true,
            });
        }
    });

    it('returns the native PDF when the Netpbm helper accepts the input', async () => {
        const nativeBytes = new Uint8Array([
            1,
            2,
            3,
        ]);
        mocks.nativeBuild.mockResolvedValueOnce(nativeBytes);

        const { buildOptimizedPdf } = await import('@electron/djvu/buildOptimizedPdf');
        const onPageProcessed = vi.fn();

        await expect(buildOptimizedPdf([
            '/tmp/page-1.pgm',
            '/tmp/page-2.pgm',
        ], 300, onPageProcessed)).resolves.toBe(nativeBytes);

        expect(mocks.nativeBuild).toHaveBeenCalledWith([
            '/tmp/page-1.pgm',
            '/tmp/page-2.pgm',
        ], 300, onPageProcessed);
    });

    it('falls back to the TypeScript Netpbm builder when native output is unavailable', async () => {
        mocks.nativeBuild.mockResolvedValueOnce(null);
        const imagePath = join(tempDir, 'page.pgm');
        await writeFile(imagePath, Buffer.from([
            ...Buffer.from('P5\n2 1\n255\n', 'ascii'),
            10,
            20,
        ]));

        const { buildOptimizedPdf } = await import('@electron/djvu/buildOptimizedPdf');
        const pdfBytes = await buildOptimizedPdf([imagePath], 200);
        const pdf = await PDFDocument.load(pdfBytes);

        expect(pdf.getPageCount()).toBe(1);
        expect(pdf.getPage(0).getMediaBox()).toMatchObject({
            width: 0.72,
            height: 0.36,
        });
    });
});
