import {
    mkdtemp,
    readFile,
    writeFile,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IScanCleanupOptions } from '@contracts/electronApiScanCleanup';
import { classifyScanCleanupError } from '@electron/features/scan-cleanup/createScanCleanupService';
import {
    runScanCleanupPipeline,
    type IRunScanCleanupPipelineDependencies,
} from '@electron/features/scan-cleanup/worker/runScanCleanupPipeline';

const dirs: string[] = [];
interface ICleanupOutput {
    outputPath: string;
    metadataPath: string;
}

const options: IScanCleanupOptions = {
    layoutMode: 'auto',
    outputMode: 'bw',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: 5,
    despeckle: true,
};

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'scan-cleanup-test-'));
    dirs.push(dir);
    const sourcePdfPath = join(dir, 'original.pdf');
    const outputPdfPath = join(dir, 'cleaned.pdf');
    await writeFile(sourcePdfPath, 'ORIGINAL');
    return {
        dir,
        sourcePdfPath,
        outputPdfPath,
    };
}

function dependencies(
    runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'],
): IRunScanCleanupPipelineDependencies {
    return {
        getPageCount: vi.fn(async () => 2),
        detectSourceDpi: vi.fn(async () => ({
            documentDpi: 300,
            pageDpiByNumber: new Map([
                [
                    1,
                    300,
                ],
                [
                    2,
                    150,
                ],
            ]),
        })),
        preparePdf: vi.fn(async (_paths, _log, sourcePdfPath) => ({
            pdfPath: sourcePdfPath,
            warnings: [],
        })),
        renderPage: vi.fn(async (_paths, _log, pageNumber, _source, outputPath) => {
            await writeFile(outputPath, `PNG-${pageNumber}`);
        }),
        runSidecar,
        runCommand: vi.fn(async (_command, args) => {
            const outputIndex = args.indexOf('--output');
            await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        }),
    };
}

async function writeCleanupOutput(
    output: {
        outputPath: string;
        metadataPath: string
    },
    classification: string,
    skewApplied = true,
) {
    await writeFile(output.outputPath, 'PNG-CLEAN');
    await writeFile(output.metadataPath, JSON.stringify({
        outputWidth: 1000,
        outputHeight: 1400,
        layoutClassification: classification,
        skewApplied,
        contentBox: {
            x: 1,
            y: 1,
            width: 10,
            height: 10,
        },
        warnings: [],
    }));
}

afterEach(async () => {
    const {rm} = await import('fs/promises');
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        recursive: true,
        force: true,
    })));
});

describe('scan cleanup pipeline', () => {
    it('turns a spread into two pages, preserves the original, and publishes only the staged PDF', async () => {
        const fixture = await setup();
        let cleanupManifest: {pages: Array<{
            options: IScanCleanupOptions & Record<string, unknown>;
            outputs: ICleanupOutput[]
        }>} | null = null;
        let combineManifest = '';
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                options: IScanCleanupOptions & Record<string, unknown>;
                outputs: ICleanupOutput[]
            }>};
            cleanupManifest = manifest;
            await writeCleanupOutput(manifest.pages[0]!.outputs[0]!, 'two-page-spread');
            await writeCleanupOutput(manifest.pages[0]!.outputs[1]!, 'two-page-spread');
            await writeCleanupOutput(manifest.pages[1]!.outputs[0]!, 'single-uncut-page', false);
            onProgress({
                event: 'page-complete',
                page: 2,
                total: 2,
            });
        });
        const pipelineDependencies = dependencies(runSidecar);
        pipelineDependencies.runCommand = vi.fn(async (_command, args) => {
            const manifestIndex = args.indexOf('--compact-manifest');
            combineManifest = await readFile(args[manifestIndex + 1]!, 'utf8');
            const outputIndex = args.indexOf('--output');
            await writeFile(args[outputIndex + 1]!, '%PDF-1.7\n%%EOF\n');
            return {
                exitCode: 0,
                stdout: '',
                stderr: '',
            };
        });
        const progress = vi.fn();
        const summary = await runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            },
            {
                qpdfBinary: '/qpdf',
                pdftoppmBinary: '/pdftoppm',
                scanCleanupBinary: '/cleanup',
                pdfImageCombineBinary: '/combine',
                tempDir: fixture.dir,
            },
            new AbortController().signal,
            progress,
            undefined,
            pipelineDependencies,
        );
        expect(summary).toMatchObject({
            inputPages: 2,
            outputPages: 3,
            spreadsSplit: 1,
            deskewSkipped: 1,
        });
        expect(await readFile(fixture.sourcePdfPath, 'utf8')).toBe('ORIGINAL');
        expect(await readFile(fixture.outputPdfPath, 'utf8')).toContain('%PDF-1.7');
        expect(progress).toHaveBeenCalledWith(expect.objectContaining({
            phase: 'handoff',
            percent: 100,
        }));
        expect(cleanupManifest).not.toBeNull();
        expect(cleanupManifest!.pages[0]!.options).toMatchObject({
            matchPageSize: true,
            pageAlignment: 'top-center',
        });
        const pageSizes = combineManifest.trim().split('\n').map(line => line.split('\t').slice(1, 3));
        expect(new Set(pageSizes.map(size => size.join('x')))).toEqual(new Set(['240.000000x336.000000']));
    });

    it('kills work through the abort signal and leaves no partial final PDF', async () => {
        const fixture = await setup();
        const controller = new AbortController();
        const entered = Promise.withResolvers<undefined>();
        const runSidecar: IRunScanCleanupPipelineDependencies['runSidecar'] = vi.fn(async (_binary, _manifest, signal) => {
            entered.resolve(undefined);
            await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
        });
        const result = runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            },
            {
                qpdfBinary: '/qpdf',
                pdftoppmBinary: '/pdftoppm',
                scanCleanupBinary: '/cleanup',
                pdfImageCombineBinary: '/combine',
                tempDir: fixture.dir,
            },
            controller.signal,
            vi.fn(),
            undefined,
            dependencies(runSidecar),
        );
        await entered.promise;
        controller.abort(new DOMException('Canceled', 'AbortError'));
        await expect(result).rejects.toThrow('Canceled');
        await expect(readFile(fixture.outputPdfPath)).rejects.toMatchObject({code: 'ENOENT'});
        expect(await readFile(fixture.sourcePdfPath, 'utf8')).toBe('ORIGINAL');
    });

    it('surfaces a typed sidecar failure without touching source or final output', async () => {
        const fixture = await setup();
        const result = runScanCleanupPipeline(
            {
                sourcePdfPath: fixture.sourcePdfPath,
                outputPdfPath: fixture.outputPdfPath,
                options,
            },
            {
                qpdfBinary: '/qpdf',
                pdftoppmBinary: '/pdftoppm',
                scanCleanupBinary: '/cleanup',
                pdfImageCombineBinary: '/combine',
                tempDir: fixture.dir,
            },
            new AbortController().signal,
            vi.fn(),
            undefined,
            dependencies(vi.fn(async () => { throw new Error('evb-scan-cleanup failed: fixture'); })),
        );
        await expect(result).rejects.toThrow('evb-scan-cleanup failed');
        expect(classifyScanCleanupError(new Error('evb-scan-cleanup failed'), false)).toBe('sidecar-failed');
        expect(await readFile(fixture.sourcePdfPath, 'utf8')).toBe('ORIGINAL');
        await expect(readFile(fixture.outputPdfPath)).rejects.toMatchObject({code: 'ENOENT'});
    });
});
