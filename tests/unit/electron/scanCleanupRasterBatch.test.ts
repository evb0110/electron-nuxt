import {
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createScanCleanupRasterBatchRenderer} from '@electron/features/scan-cleanup/renderScanCleanupRasterBatch';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, {
        force: true,
        recursive: true,
    })));
});

describe('scan cleanup raster batch renderer', () => {
    it('renders one contiguous window with one Poppler process and publishes every target', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scan-cleanup-raster-batch-test-'));
        roots.push(root);
        const runCommand = vi.fn(async (_binary: string, args: string[]) => {
            const prefix = args.at(-1)!;
            await Promise.all([
                writeFile(`${prefix}-0017.png`, PNG),
                writeFile(`${prefix}-0018.png`, PNG),
            ]);
            return {
                exitCode: 0,
                stderr: '',
                stdout: '',
            };
        });
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand);
        const targets = [
            17,
            18,
        ].map(pageNumber => ({
            limits: {
                expectedHeightPx: 3,
                expectedWidthPx: 3,
                maxDimensionPx: 100,
                maxPixels: 10_000,
            },
            outputPath: join(root, `page-${String(pageNumber)}.png`),
            pageNumber,
        }));

        const results = await renderBatch({
            dpi: 150,
            log: vi.fn(),
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: '/source.pdf',
            targets,
        });

        expect(runCommand).toHaveBeenCalledOnce();
        expect(runCommand.mock.calls[0]?.[1]).toEqual([
            '-png',
            '-cropbox',
            '-r',
            '150',
            '-f',
            '17',
            '-l',
            '18',
            '/source.pdf',
            expect.stringContaining('pdftoppm-batch-'),
        ]);
        expect(results).toEqual([
            {
                height: 1,
                pageNumber: 17,
                width: 1,
            },
            {
                height: 1,
                pageNumber: 18,
                width: 1,
            },
        ]);
        expect(await readFile(targets[0]!.outputPath)).toEqual(PNG);
        expect(await readFile(targets[1]!.outputPath)).toEqual(PNG);
        expect((await readdir(root)).sort()).toEqual([
            'page-17.png',
            'page-18.png',
        ]);
    });

    it('rejects non-contiguous windows before starting Poppler', async () => {
        const runCommand = vi.fn();
        const renderBatch = createScanCleanupRasterBatchRenderer(runCommand);

        await expect(renderBatch({
            dpi: 150,
            log: vi.fn(),
            pdftoppmBinary: '/pdftoppm',
            signal: new AbortController().signal,
            sourcePdfPath: '/source.pdf',
            targets: [
                1,
                3,
            ].map(pageNumber => ({
                limits: {
                    expectedHeightPx: 3,
                    expectedWidthPx: 3,
                    maxDimensionPx: 100,
                    maxPixels: 10_000,
                },
                outputPath: `/page-${String(pageNumber)}.png`,
                pageNumber,
            })),
        })).rejects.toThrow('contiguous');
        expect(runCommand).not.toHaveBeenCalled();
    });
});
