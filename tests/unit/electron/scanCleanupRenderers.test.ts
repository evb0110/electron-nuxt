import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createScanCleanupRenderers} from '@scan-cleanup-adapters/createScanCleanupRenderers';

describe('createScanCleanupRenderers', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('asks pdftoppm for PNG output without a main-process conversion pass', async () => {
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

        expect(runCommand).toHaveBeenCalledWith(
            '/bin/pdftoppm',
            [
                '-png',
                '-cropbox',
                '-r',
                '300',
                '-f',
                '1',
                '-l',
                '1',
                '-singlefile',
                '/tmp/source.pdf',
                '/tmp/page',
            ],
            expect.objectContaining({signal: controller.signal}),
        );
    });

    it('keeps the PPM route available for sidecar-only handoffs', async () => {
        const runCommand = vi.fn().mockResolvedValue(undefined);
        const {renderPagePpm} = createScanCleanupRenderers(runCommand);

        await renderPagePpm(
            {pdftoppmBinary: '/bin/pdftoppm'},
            vi.fn(),
            1,
            '/tmp/source.pdf',
            '/tmp/page.ppm',
            300,
        );

        expect(runCommand).toHaveBeenCalledWith(
            '/bin/pdftoppm',
            [
                '-cropbox',
                '-r',
                '300',
                '-f',
                '1',
                '-l',
                '1',
                '-singlefile',
                '/tmp/source.pdf',
                '/tmp/page',
            ],
            expect.any(Object),
        );
    });
});
