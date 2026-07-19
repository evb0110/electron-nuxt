import {
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {IScanCleanupPreviewRequest} from '@contracts/electronApiScanCleanup';
import {
    createScanCleanupPreviewService,
    type IScanCleanupPreviewDependencies,
} from '@electron/features/scan-cleanup/createScanCleanupPreviewService';
import {decodeScanCleanupPreviewResult} from '@electron/features/scan-cleanup/scanCleanupIpcCodecs';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const dirs: string[] = [];
const request: IScanCleanupPreviewRequest = {
    sourcePdfPath: '/document.pdf',
    pageNumber: 1,
    options: {
        layoutMode: 'auto',
        outputMode: 'bw',
        readingOrder: 'ltr',
        thickness: 0,
        crop: true,
        matchPageSize: true,
        pageAlignment: 'top-center',
        marginsMm: 5,
        despeckle: true,
        skipBlankPages: false,
        straightenCurvedLines: false,
        pageOverrides: {},
    },
};

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'scan-cleanup-preview-test-'));
    dirs.push(dir);
    return dir;
}

function dependencies(dir: string): IScanCleanupPreviewDependencies {
    return {
        getPageCount: vi.fn(async () => 3),
        renderPage: vi.fn(async (_paths, _log, _page, _source, outputPath) => {
            await writeFile(outputPath, PNG);
        }),
        runSidecar: vi.fn(async (_binary, manifestPath) => {
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{
                pageMetadataPath: string;
                outputs: Array<{
                    outputPath: string;
                    metadataPath: string
                }>
            }>};
            const page = manifest.pages[0]!;
            const output = page.outputs[0]!;
            await writeFile(page.pageMetadataPath, JSON.stringify({
                layoutClassification: 'single-uncut-page',
                cutterX: null,
                rotation: 0,
                excluded: false,
                blankOutputsSkipped: 0,
                outputCount: 1,
            }));
            await writeFile(output.outputPath, PNG);
            await writeFile(output.metadataPath, JSON.stringify({
                half: 'full',
                layoutClassification: 'single-uncut-page',
                sourceRegion: {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                },
                contentBox: {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                },
                appliedMargins: [
                    0,
                    0,
                    0,
                    0,
                ],
                outputWidth: 1,
                outputHeight: 1,
                cutterX: null,
                inputWidth: 1,
                inputHeight: 1,
                rotation: 0,
                resamplePasses: 1,
                forwardTransform: {matrix: [
                    [
                        1,
                        0,
                        0,
                    ],
                    [
                        0,
                        1,
                        0,
                    ],
                    [
                        0,
                        0,
                        1,
                    ],
                ]},
                warnings: [],
            }));
        }),
        resolveBinary: () => '/cleanup',
        getTempDir: () => dir,
        getPdftoppmBinary: () => '/pdftoppm',
    };
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        recursive: true,
        force: true,
    })));
});

describe('scan cleanup preview', () => {
    it('returns real sidecar bytes and validated metadata', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const result = await createScanCleanupPreviewService(deps).preview(request);
        expect(deps.runSidecar).toHaveBeenCalledOnce();
        expect(decodeScanCleanupPreviewResult(result)).toMatchObject({
            pageNumber: 1,
            totalPages: 3,
            rawWidth: 1,
            rawHeight: 1,
            outputs: [{metadata: {half: 'full'}}],
        });
    });

    it('supersedes an older request before running the latest one', async () => {
        const dir = await setup();
        const deps = dependencies(dir);
        const entered = Promise.withResolvers<undefined>();
        let calls = 0;
        deps.renderPage = vi.fn(async (_paths, _log, _page, _source, outputPath, _dpi, _env, signal) => {
            calls += 1;
            if (calls === 1) {
                entered.resolve(undefined);
                await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), {once: true}));
                return;
            }
            await writeFile(outputPath, PNG);
        });
        const service = createScanCleanupPreviewService(deps);
        const older = service.preview(request);
        await entered.promise;
        const newer = service.preview({
            ...request,
            options: {
                ...request.options,
                thickness: 1,
            },
        });
        await expect(older).rejects.toMatchObject({name: 'AbortError'});
        await expect(newer).resolves.toMatchObject({pageNumber: 1});
        expect(deps.runSidecar).toHaveBeenCalledOnce();
    });

    it('rejects oversized encoded image responses at the IPC boundary', () => {
        expect(() => decodeScanCleanupPreviewResult({
            pageNumber: 1,
            totalPages: 1,
            rawWidth: 1,
            rawHeight: 1,
            rawImageData: PNG,
            outputs: [{
                imageData: new Uint8Array(32 * 1024 * 1024 + 1),
                metadata: {
                    half: 'full',
                    layoutClassification: 'single-uncut-page',
                    outputWidth: 1,
                    outputHeight: 1,
                },
            }],
        })).toThrow('invalid scan-cleanup preview output image');
    });
});
