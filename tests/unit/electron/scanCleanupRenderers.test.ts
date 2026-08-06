import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createScanCleanupRenderers} from '@scan-cleanup-adapters/createScanCleanupRenderers';

const mocks = vi.hoisted(() => ({
    readPpmRaster: vi.fn(),
    rm: vi.fn(),
    writeFile: vi.fn(),
}));

vi.mock('@scan-cleanup-core/rasterLayerDimensions', () => ({readPpmRaster: mocks.readPpmRaster}));
vi.mock('node:fs/promises', () => ({
    rm: mocks.rm,
    writeFile: mocks.writeFile,
}));

describe('createScanCleanupRenderers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.readPpmRaster.mockResolvedValue({
            width: 1,
            height: 1,
            isColor: true,
            pixels: Buffer.from([
                0x12,
                0x34,
                0x56,
            ]),
        });
        mocks.rm.mockResolvedValue(undefined);
        mocks.writeFile.mockResolvedValue(undefined);
    });

    it('materializes a bounded exact PPM payload and always cleans its scratch file', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined);
        const {renderPage} = createScanCleanupRenderers(runCommand);
        const controller = new AbortController();

        await renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page.png',
            300,
            undefined,
            controller.signal,
            undefined,
            {
                expectedWidthPx: 1,
                expectedHeightPx: 1,
                maxDimensionPx: 100,
                maxPixels: 100,
            },
        );

        expect(mocks.readPpmRaster).toHaveBeenCalledWith(
            '/tmp/page.png.source.ppm',
            {
                maxDimensionPx: 100,
                maxPixels: 100,
                signal: controller.signal,
            },
        );
        expect(mocks.writeFile).toHaveBeenCalledWith('/tmp/page.png', expect.any(Uint8Array));
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page.png.source.ppm', {force: true});
    });

    it('does not publish and still cleans scratch when exact PPM validation fails', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined);
        const {renderPage} = createScanCleanupRenderers(runCommand);
        mocks.readPpmRaster.mockRejectedValueOnce(new Error('Surplus PPM payload'));

        await expect(renderPage(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page.png',
            300,
        )).rejects.toThrow('Surplus PPM payload');

        expect(mocks.writeFile).not.toHaveBeenCalled();
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/page.png.source.ppm', {force: true});
    });
});
