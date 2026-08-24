import {
    mkdtemp,
    readFile,
    rename,
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
import {
    runScanCleanupDetection,
    type IScanCleanupDetectionRetention,
} from '@scan-cleanup-core/detection';
import type {IScanCleanupDetectionRequest} from '@contracts/electronApiScanCleanup';
import type {
    INativeScanCleanupManifestV3,
    INativeScanCleanupPageV3,
    INativeScanCleanupSplitDiagnosticsV3,
    TNativeScanCleanupProgressV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {decodeNativeScanCleanupPageMetadata} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {decodeScanCleanupDetectionJobState} from '@contracts/scan-cleanup/ipcResultCodecs';
import {compactScanCleanupDetectionVerdicts} from '@scripts/scanCleanupCliAdapters';
import {isPathWithinRoot} from '@tests/helpers/isPathWithinRoot';

const dirs: string[] = [];
const MIB = 1024 * 1024;

function splitDiagnostics(): INativeScanCleanupSplitDiagnosticsV3 {
    return {
        analysisDpi: 150,
        deskewAngleDegrees: 0,
        deskewConfidence: 1,
        cutterSlope: 0,
        leftDeskewAngleDegrees: 0,
        rightDeskewAngleDegrees: 0,
        leftDeskewConfidence: 1,
        rightDeskewConfidence: 1,
        whitespaceX: 1075,
        foldX: 1142,
        decisionX: 1198,
        whitespaceScore: 0.98,
        bilateralScore: 1,
        leftPageScore: 1,
        rightPageScore: 1,
        leftContentScore: 1,
        rightContentScore: 1,
        leftSurfaceScore: 1,
        rightSurfaceScore: 1,
        leftInkPixels: 31_717,
        rightInkPixels: 20_784,
        outerMarginScore: 1,
        gutterScore: 1,
        agreementScore: 1,
        foldScore: 0.086,
        gutterDarknessScore: 0,
        softGutterScore: 0,
        softGutterCoverage: 0,
        softGutterContinuity: 0,
        softGutterMeanDepression: 0,
        sparseGutterScore: 1,
        sparseGutterCoverage: 1,
        sparseGutterContinuity: 1,
        sparseGutterMeanDepression: 24.64,
        aspectRatio: 1.4,
        aspectSpreadScore: 1,
        aspectSingleScore: 0,
        independentSpreadCues: 3,
        offcutBoundaryScore: 0,
        offcutEmptyScore: 0,
        offcutPopulatedScore: 0,
        offcutWidthScore: 0,
        offcutNoTextRowsScore: 0,
        alternativeProduct: 0,
        evidenceProduct: 0.699,
        whitespaceGatePassed: true,
        centralPositionGatePassed: true,
        bilateralGatePassed: true,
        outerMarginGatePassed: true,
        gutterGatePassed: true,
        independentGutterGatePassed: true,
        aspectSupportGatePassed: true,
        evidenceAgreementGatePassed: true,
        sparseSpreadRecovered: true,
        abstained: false,
        foldBand: {
            status: 'unmeasured',
            reason: 'fold-evidence-unquantified',
            nominalHalfWidthPx: 6,
        },
    };
}

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

interface IStagedManifestPages {pages: Array<Pick<INativeScanCleanupPageV3, 'inputPath' | 'sourcePageIndex' | 'pageMetadataPath'>>;}

/**
 * The part of the real manifest this fake reads, derived from the protocol type
 * so a renamed field fails to compile here instead of silently parsing as
 * `undefined` and taking the fallback path.
 */
type TStagedManifest = Pick<INativeScanCleanupManifestV3, 'stagedInputWindow' | 'stagedInputPeakPixels'> & IStagedManifestPages;

/**
 * A sidecar that speaks the staged-input lease protocol.
 *
 * It mirrors what the Rust binary does: announce `page-input-required`, block
 * until the producer publishes that raster, read it, classify, then announce
 * `page-input-released`. Nothing here is allowed to read an input it has not
 * leased, which is what makes the residency assertions meaningful.
 */
function createStagedSidecar(options: {
    /** Pages leased at once. Never more than the declared window. */
    concurrency?: number;
    /** Extra lease taken after every page, as document reconciliation does. */
    reconcilePages?: readonly number[];
    onManifest?: (manifest: TStagedManifest) => void;
    onLease?: (event: 'acquired' | 'released', pageNumber: number) => void;
} = {}) {
    const leaseHistory: Array<{
        event: 'acquired' | 'released';
        pageNumber: number
    }> = [];
    const readInputs = new Map<number, string>();
    const runSidecar = vi.fn(async (
        _binary: string,
        manifestPath: string,
        signal: AbortSignal,
        _log: unknown,
        onProgress: (progress: TNativeScanCleanupProgressV3) => void,
    ) => {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as TStagedManifest;
        options.onManifest?.(manifest);
        const totalPages = manifest.pages.length;
        const lease = async (pageNumber: number, inputPath: string) => {
            leaseHistory.push({
                event: 'acquired',
                pageNumber,
            });
            options.onLease?.('acquired', pageNumber);
            onProgress({
                stage: 'page-input-required' as const,
                completedPages: 0,
                totalPages,
                pageNumber,
            });
            const deadline = Date.now() + 5_000;
            for (;;) {
                signal.throwIfAborted();
                try {
                    readInputs.set(pageNumber, (await readFile(inputPath)).toString('base64'));
                    return;
                } catch (error) {
                    if (Date.now() > deadline) throw error;
                    await new Promise(resolve => setTimeout(resolve, 1));
                }
            }
        };
        const release = (pageNumber: number) => {
            leaseHistory.push({
                event: 'released',
                pageNumber,
            });
            options.onLease?.('released', pageNumber);
            onProgress({
                stage: 'page-input-released' as const,
                completedPages: 0,
                totalPages,
                pageNumber,
            });
        };
        let completedPages = 0;
        let nextIndex = 0;
        const workers = Array.from(
            {length: Math.min(options.concurrency ?? 1, manifest.stagedInputWindow ?? 1, totalPages)},
            async () => {
                while (nextIndex < totalPages) {
                    const page = manifest.pages[nextIndex]!;
                    nextIndex += 1;
                    await lease(page.sourcePageIndex + 1, page.inputPath);
                    await writeFile(page.pageMetadataPath, JSON.stringify({
                        layoutClassification: 'single-uncut-page',
                        cutterXPx: null,
                        rotationDegrees: 0,
                        canvasScope: 'page',
                        excluded: false,
                        blankOutputsSkipped: 0,
                        outputCount: 0,
                    }));
                    completedPages += 1;
                    onProgress({
                        stage: 'page-analyzed' as const,
                        completedPages,
                        totalPages,
                        pageNumber: page.sourcePageIndex + 1,
                        classification: 'single-uncut-page',
                        confidence: 0.9,
                    });
                    release(page.sourcePageIndex + 1);
                }
            },
        );
        await Promise.all(workers);
        // Document reconciliation revisits pages the window may already have
        // dropped, which is exactly the replay the lease protocol exists for.
        for (const pageNumber of options.reconcilePages ?? []) {
            const page = manifest.pages.find(candidate => candidate.sourcePageIndex + 1 === pageNumber)!;
            await lease(pageNumber, page.inputPath);
            release(pageNumber);
        }
        for (const page of manifest.pages) {
            onProgress({
                stage: 'page-complete' as const,
                completedPages: totalPages,
                totalPages,
                pageNumber: page.sourcePageIndex + 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
                reconciled: true,
                clusterAgreement: 1,
            });
        }
    });
    return {
        runSidecar,
        leaseHistory,
        readInputs,
    };
}

function createRequest(): IScanCleanupDetectionRequest {
    return {
        ownerId: 'owner',
        sourcePdfPath: '/tmp/input.pdf',
        documentRevision: 'revision',
        options: {
            preserveOriginalQuality: false,
            layoutMode: 'auto',
            outputMode: 'auto',
            readingOrder: 'ltr',
            thickness: 0,
            crop: true,
            matchPageSize: true,
            pageAlignment: 'top-center',
            marginsMm: {
                leftMm: 0,
                topMm: 0,
                rightMm: 0,
                bottomMm: 0,
            },
            skipBlankPages: false,
            pageOverrides: {},
        },
    };
}

afterEach(async () => {
    await Promise.all(dirs.splice(0).map(dir => rm(dir, {
        force: true,
        recursive: true,
    })));
});

describe('runScanCleanupDetection non-stream raster admission', () => {
    /* Legacy FIFO Analyze transport coverage was removed when Analyze became
     * retained-PNG-only; Render conversion keeps its independent stream path. */

    it.each([
        [
            'low scratch',
            1_024 * MIB,
        ],
        [
            'high scratch',
            4_096 * MIB,
        ],
    ])('uses retained PNG Analyze inputs under $0 regardless of scratch capacity', async (_label, availableScratchBytes) => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const pageCount = 2;
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
        );
        const createRasterPipes = vi.fn(async () => undefined);
        const publish = vi.fn();
        const sidecarRoots: Array<string | undefined> = [];
        const manifests: Array<{
            rasterWindow?: number;
            pages: Array<{
                inputPath: string;
                pageMetadataPath: string;
            }>;
        }> = [];
        const renderPage = vi.fn(async (_paths, _log, _pageNumber, _source, outputPath) => {
            await writeFile(outputPath, png);
        });
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => pageCount),
            pageSizes: vi.fn(async () => Array.from({length: pageCount}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 72,
                heightPoints: 72,
                rotation: 0,
            }))),
            rasterPages: vi.fn(async () => ({
                detected: false,
                pages: new Set<number>(),
            })),
            retainedPaths: vi.fn(async () => new Map()),
            rasterScratchPath: vi.fn(async (_document, pageNumber) => join(tempDir, `analysis-${String(pageNumber)}.part.png`)),
            stagedRasterPath: vi.fn(async (_document, pageNumber) => join(tempDir, `analysis-${String(pageNumber)}.png`)),
            // Publication is a rename, exactly as production retention does it:
            // the sidecar only ever sees a complete raster at the input path.
            retain: vi.fn(async input => {
                const path = join(tempDir, `analysis-${String(input.pageNumber)}.png`);
                await rename(input.scratchPath, path);
                return {
                    dpi: input.dpi,
                    height: input.height,
                    pageNumber: input.pageNumber,
                    path,
                    sizeBytes: input.sizeBytes,
                    width: input.width,
                };
            }),
            releaseRaster: vi.fn(async (_document, pageNumber) => {
                await rm(join(tempDir, `analysis-${String(pageNumber)}.png`), {force: true});
            }),
            release: vi.fn(async () => undefined),
        };
        const result = await runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            retention,
            {
                getAvailableScratchBytes: vi.fn(async () => availableScratchBytes),
                getTempDir: () => tempDir,
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage,
                renderPagePpm: vi.fn(),
                createRasterPipes,
                runSidecar: vi.fn(async (_binary, manifestPath, _signal, _log, onProgress, sidecarOptions) => {
                    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as typeof manifests[number];
                    manifests.push(manifest);
                    sidecarRoots.push(sidecarOptions?.allowedPathRoot);
                    expect(manifest.rasterWindow).toBeUndefined();
                    await Promise.all(manifest.pages.map(page => writeFile(
                        page.pageMetadataPath,
                        JSON.stringify({
                            layoutClassification: 'single-uncut-page',
                            cutterXPx: null,
                            rotationDegrees: 0,
                            canvasScope: 'page',
                            excluded: false,
                            blankOutputsSkipped: 0,
                            outputCount: 0,
                        }),
                    )));
                    for (const [index] of manifest.pages.entries()) {
                        onProgress({
                            stage: 'page-analyzed',
                            completedPages: index,
                            totalPages: pageCount,
                            pageNumber: index + 1,
                            classification: 'single-uncut-page',
                            confidence: 0.9,
                        });
                        onProgress({
                            stage: 'page-complete',
                            completedPages: index + 1,
                            totalPages: pageCount,
                            pageNumber: index + 1,
                            classification: 'single-uncut-page',
                            confidence: 0.9,
                        });
                    }
                }),
            },
            {rasterConcurrency: 2},
            publish,
        );

        expect(result.results).toHaveLength(pageCount);
        expect(manifests).toHaveLength(1);
        expect(manifests[0]!.pages.every(page => page.inputPath.endsWith('.png'))).toBe(true);
        // The Analyze manifest and the native invocation that consumes it are
        // constrained to the same injected temp root.
        expect(sidecarRoots).toEqual([tempDir]);
        expect(manifests[0]!.pages
            .flatMap(page => [
                page.inputPath,
                page.pageMetadataPath,
            ])
            .filter(path => !isPathWithinRoot(path, tempDir))).toEqual([]);
        expect(renderPage).toHaveBeenCalledTimes(pageCount);
        expect(createRasterPipes).not.toHaveBeenCalled();
        expect(retention.release).toHaveBeenCalledOnce();
        expect(publish.mock.calls
            .map(([
                ,
                progress,
            ]) => progress)
            .filter(progress => progress.stage === 'detecting')).toEqual([
            {
                stage: 'detecting',
                completedUnits: 0,
                totalUnits: 2,
                percent: 0,
                completedPageNumbers: [1],
            },
            {
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 2,
                percent: 50,
                completedPageNumbers: [1],
            },
            {
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 2,
                percent: 50,
                completedPageNumbers: [
                    1,
                    2,
                ],
            },
            {
                stage: 'detecting',
                completedUnits: 2,
                totalUnits: 2,
                percent: 100,
                completedPageNumbers: [
                    1,
                    2,
                ],
            },
        ]);
    });

    it('classifies malformed native page metadata as a native protocol failure', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => 1),
            pageSizes: vi.fn(async () => [{
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 100,
                heightPoints: 200,
                rotation: 0,
            }]),
            rasterPages: vi.fn(async () => ({
                detected: true,
                pages: new Set([1]),
            })),
            retainedPaths: vi.fn(async () => new Map([[
                1,
                {
                    dpi: 150,
                    height: 200,
                    pageNumber: 1,
                    path: join(tempDir, 'retained.png'),
                    sizeBytes: 100,
                    width: 100,
                },
            ]])),
            rasterScratchPath: vi.fn(async () => join(tempDir, 'unexpected.png')),
            stagedRasterPath: vi.fn(async (_document, pageNumber, dpi) => join(
                tempDir,
                `staged-${String(pageNumber)}-${String(dpi)}.png`,
            )),
            releaseRaster: vi.fn(async () => undefined),
            retain: vi.fn(),
            release: vi.fn(async () => undefined),
        };
        const request: IScanCleanupDetectionRequest = {
            ownerId: 'owner',
            sourcePdfPath: '/tmp/input.pdf',
            documentRevision: 'revision',
            options: {
                preserveOriginalQuality: false,
                layoutMode: 'auto',
                outputMode: 'auto',
                readingOrder: 'ltr',
                thickness: 0,
                crop: true,
                matchPageSize: false,
                pageAlignment: 'top-center',
                marginsMm: {
                    leftMm: 0,
                    topMm: 0,
                    rightMm: 0,
                    bottomMm: 0,
                },
                skipBlankPages: false,
                pageOverrides: {},
            },
        };

        await expect(runScanCleanupDetection(
            request,
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage: vi.fn(),
                renderPagePpm: vi.fn(),
                runSidecar: vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
                    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>;};
                    await writeFile(manifest.pages[0]!.pageMetadataPath, JSON.stringify({
                        layoutClassification: 42,
                        cutterXPx: null,
                        rotationDegrees: 0,
                        canvasScope: 'page',
                        excluded: false,
                        blankOutputsSkipped: 0,
                        outputCount: 0,
                    }));
                    onProgress({
                        stage: 'page-analyzed',
                        completedPages: 1,
                        totalPages: 1,
                        pageNumber: 1,
                        classification: 'single-uncut-page',
                        confidence: 0.9,
                    });
                }),
            },
            {rasterConcurrency: 1},
            () => undefined,
        )).rejects.toMatchObject({
            code: 'native-failure',
            artifact: 'page metadata',
        });

        expect(retention.release).toHaveBeenCalledOnce();
    });

    it('normalizes real pre-fold-band persisted detection diagnostics', async () => {
        const artifact = JSON.parse(await readFile(
            new URL('../../fixtures/scan-cleanup/protocol-v3-page-before-fold-band.json', import.meta.url),
            'utf8',
        )) as {
            layoutClassification: 'two-page-spread';
            layoutConfidence: number;
            cutterXPx: number;
            splitDiagnostics: Record<string, unknown>;
        };
        const decoded = decodeScanCleanupDetectionJobState({
            jobId: 'legacy-protocol-v3',
            status: 'completed',
            progress: {
                stage: 'detecting',
                completedUnits: 1,
                totalUnits: 1,
                percent: 100,
                completedPageNumbers: [1],
            },
            results: [{
                pageNumber: 1,
                classification: artifact.layoutClassification,
                confidence: artifact.layoutConfidence,
                cutterXPx: artifact.cutterXPx,
                splitDiagnostics: artifact.splitDiagnostics,
            }],
            updatedAtMs: 1,
        });

        expect(decoded?.results[0]?.splitDiagnostics?.foldBand).toEqual({
            status: 'unmeasured',
            reason: 'legacy-protocol-v3',
            nominalHalfWidthPx: 0,
        });
    });

    it('retains native split diagnostics through detection, IPC decoding, and compact evidence', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const diagnostics = splitDiagnostics();
        const nativeMetadata = {
            layoutClassification: 'two-page-spread' as const,
            layoutConfidence: 0.71,
            cutterXPx: 100,
            rotationDegrees: 0 as const,
            canvasScope: 'page' as const,
            excluded: false,
            blankOutputsSkipped: 0,
            outputCount: 2,
            outputs: [
                {
                    half: 'left' as const,
                    sourceRegion: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 100,
                        heightPx: 120,
                    },
                    cropRect: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 100,
                        heightPx: 120,
                    },
                    inputWidthPx: 200,
                    inputHeightPx: 120,
                },
                {
                    half: 'right' as const,
                    sourceRegion: {
                        xPx: 100,
                        yPx: 0,
                        widthPx: 100,
                        heightPx: 120,
                    },
                    cropRect: {
                        xPx: 0,
                        yPx: 0,
                        widthPx: 100,
                        heightPx: 120,
                    },
                    inputWidthPx: 200,
                    inputHeightPx: 120,
                },
            ],
            splitDiagnostics: diagnostics,
        };
        expect(decodeNativeScanCleanupPageMetadata(nativeMetadata).splitDiagnostics)
            .toEqual(diagnostics);
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...nativeMetadata,
            splitDiagnostics: {
                ...diagnostics,
                sparseGutterCoverage: 'complete',
            },
        })).toThrow('splitDiagnostics.sparseGutterCoverage must be finite');

        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => 1),
            pageSizes: vi.fn(async () => [{
                pageNumber: 1,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 200,
                heightPoints: 120,
                rotation: 0,
            }]),
            rasterPages: vi.fn(async () => ({
                detected: true,
                pages: new Set([1]),
            })),
            retainedPaths: vi.fn(async () => new Map([[
                1,
                {
                    dpi: 150,
                    height: 120,
                    pageNumber: 1,
                    path: join(tempDir, 'retained.png'),
                    sizeBytes: 100,
                    width: 200,
                },
            ]])),
            rasterScratchPath: vi.fn(async () => join(tempDir, 'unexpected.png')),
            stagedRasterPath: vi.fn(async (_document, pageNumber, dpi) => join(
                tempDir,
                `staged-${String(pageNumber)}-${String(dpi)}.png`,
            )),
            releaseRaster: vi.fn(async () => undefined),
            retain: vi.fn(),
            release: vi.fn(async () => undefined),
        };
        const detection = await runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage: vi.fn(),
                renderPagePpm: vi.fn(),
                runSidecar: vi.fn(async (_binary, manifestPath, _signal, _log, onProgress) => {
                    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {pages: Array<{pageMetadataPath: string}>;};
                    await writeFile(
                        manifest.pages[0]!.pageMetadataPath,
                        JSON.stringify(nativeMetadata),
                    );
                    onProgress({
                        stage: 'page-complete',
                        completedPages: 1,
                        totalPages: 1,
                        pageNumber: 1,
                        classification: 'two-page-spread',
                        confidence: 0.71,
                        cutterXPx: 100,
                        tier1Verdict: 'single-uncut-page',
                        reconciled: true,
                        clusterAgreement: 0.94,
                    });
                }),
            },
            {rasterConcurrency: 1},
            () => undefined,
        );
        expect(detection.results[0]!.splitDiagnostics).toEqual(diagnostics);

        const state = {
            jobId: 'split-diagnostics',
            status: 'completed' as const,
            progress: {
                stage: 'detecting' as const,
                completedUnits: 1,
                totalUnits: 1,
                percent: 100,
                completedPageNumbers: [1],
            },
            results: detection.results,
            updatedAtMs: 1,
        };
        const decoded = decodeScanCleanupDetectionJobState(state);
        expect(decoded?.results[0]!.splitDiagnostics).toEqual(diagnostics);
        expect(compactScanCleanupDetectionVerdicts(decoded!.results)[0]!.splitDiagnostics)
            .toEqual(diagnostics);

        const malformedState = structuredClone(state);
        malformedState.results[0]!.splitDiagnostics!.gutterGatePassed = 'yes' as never;
        expect(() => decodeScanCleanupDetectionJobState(malformedState))
            .toThrow('invalid scan-cleanup split diagnostics');

        const malformedFoldState = structuredClone(state);
        malformedFoldState.results[0]!.splitDiagnostics!.foldBand = {
            status: 'unmeasured',
            reason: 'unknown',
            nominalHalfWidthPx: 6,
        } as never;
        expect(() => decodeScanCleanupDetectionJobState(malformedFoldState))
            .toThrow('invalid scan-cleanup split diagnostics');
    });

    it('refuses only when not even one page raster fits, with the figures to act on', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const pageCount = 30;
        const renderPage = vi.fn();
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => pageCount),
            pageSizes: vi.fn(async () => Array.from({length: pageCount}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                // 3,000 × 3,000 at 150 DPI. One byte of free scratch cannot
                // hold a single one of them, which is the only condition left
                // that refuses a document outright.
                widthPoints: 1_440,
                heightPoints: 1_440,
                rotation: 0,
            }))),
            rasterPages: vi.fn(async () => ({
                detected: false,
                pages: new Set<number>(),
            })),
            retainedPaths: vi.fn(async () => new Map()),
            rasterScratchPath: vi.fn(async () => join(tempDir, 'unexpected.png')),
            stagedRasterPath: vi.fn(async (_document, pageNumber, dpi) => join(
                tempDir,
                `staged-${String(pageNumber)}-${String(dpi)}.png`,
            )),
            releaseRaster: vi.fn(async () => undefined),
            retain: vi.fn(),
            release: vi.fn(async () => undefined),
        };
        await expect(runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                // The fallback branch is selected by omitting createRasterPipes.
                getAvailableScratchBytes: vi.fn(async () => 1),
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage,
                renderPagePpm: vi.fn(),
                runSidecar: vi.fn(),
            },
            {rasterConcurrency: 2},
            () => undefined,
        )).rejects.toMatchObject({
            code: 'insufficient-scratch',
            availableBytes: 1,
            // One 3,000 × 3,000 page costs a producer copy and a native copy.
            // Below the 512-MiB floor the binding constraint is the reserve
            // the run refuses to spend, so that is what the figure asks for.
            requiredBytes: 2 * (3_000 * 3_000 * 3 + Math.ceil(3_000 * 3_000 * 3 * 0.01)) + 512 * MIB,
        });

        expect(renderPage).not.toHaveBeenCalled();
        expect(retention.retain).not.toHaveBeenCalled();
        expect(retention.release).toHaveBeenCalledOnce();
    });

    it('never charges an already-retained raster to the staged window', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const retainedPath = join(tempDir, 'retained-page-1.png');
        await writeFile(retainedPath, PNG_1X1);
        const retainedRaster = {
            dpi: 150,
            height: 1_000,
            pageNumber: 1,
            path: retainedPath,
            sizeBytes: 6 * MIB,
            width: 1_000,
        };
        const stagedPath = (pageNumber: number) => join(tempDir, `staged-${String(pageNumber)}.png`);
        const renderPage = vi.fn(async (_paths, _log, _pageNumber, _source, outputPath: string) => {
            await writeFile(outputPath, PNG_1X1);
        });
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => 2),
            pageSizes: vi.fn(async () => Array.from({length: 2}, (_, index) => ({
                pageNumber: index + 1,
                xPoints: 0,
                yPoints: 0,
                // 1,000 × 1,000 pixels at the 150-DPI detection ceiling.
                widthPoints: 480,
                heightPoints: 480,
                rotation: 0,
            }))),
            rasterPages: vi.fn(async () => ({
                detected: false,
                pages: new Set<number>(),
            })),
            retainedPaths: vi.fn(async () => new Map([[
                1,
                retainedRaster,
            ]])),
            rasterScratchPath: vi.fn(async (_document, pageNumber) => `${stagedPath(pageNumber)}.part`),
            stagedRasterPath: vi.fn(async (_document, pageNumber) => stagedPath(pageNumber)),
            retain: vi.fn(async input => {
                await rename(input.scratchPath, stagedPath(input.pageNumber));
                return {
                    dpi: input.dpi,
                    height: input.height,
                    pageNumber: input.pageNumber,
                    path: stagedPath(input.pageNumber),
                    sizeBytes: input.sizeBytes,
                    width: input.width,
                };
            }),
            releaseRaster: vi.fn(async (_document, pageNumber) => {
                await rm(stagedPath(pageNumber), {force: true});
            }),
            release: vi.fn(async () => undefined),
        };
        const sidecar = createStagedSidecar();

        const detection = await runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                // 520 MiB free leaves an 8-MiB budget after the reserve. One
                // staged page and its native copy fit; the retained page was
                // already on disk when that space was measured, so charging it
                // again would refuse a document that fits.
                getAvailableScratchBytes: vi.fn(async () => 520 * MIB),
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage,
                renderPagePpm: vi.fn(),
                runSidecar: sidecar.runSidecar,
            },
            {rasterConcurrency: 2},
            () => undefined,
        );

        expect(detection.results.map(result => result.pageNumber)).toEqual([
            1,
            2,
        ]);
        // Page 1 is read straight from the cache entry and never re-rendered;
        // only page 2 occupies the one-page window.
        expect(renderPage).toHaveBeenCalledOnce();
        expect(retention.releaseRaster).not.toHaveBeenCalledWith(
            expect.anything(),
            1,
            expect.anything(),
        );
        expect(sidecar.leaseHistory.filter(entry => entry.event === 'acquired').map(entry => entry.pageNumber))
            .toEqual([
                1,
                2,
            ]);
        expect(retention.release).toHaveBeenCalledOnce();
    });

    it('rejects retained page geometry that is not in document order', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'scan-cleanup-detection-test-'));
        dirs.push(tempDir);
        const renderPage = vi.fn();
        const retention: IScanCleanupDetectionRetention<{id: string}> = {
            openDocument: vi.fn(async () => ({id: 'document'})),
            pageCount: vi.fn(async () => 3),
            // Full-length geometry for the same document, in the wrong order:
            // detection reads a native page number as a source page number, so
            // page 2 would be classified against page 3's paper.
            pageSizes: vi.fn(async () => [
                3,
                1,
                2,
            ].map(pageNumber => ({
                pageNumber,
                xPoints: 0,
                yPoints: 0,
                widthPoints: 480,
                heightPoints: 480,
                rotation: 0,
            }))),
            rasterPages: vi.fn(async () => ({
                detected: false,
                pages: new Set<number>(),
            })),
            retainedPaths: vi.fn(async () => new Map()),
            rasterScratchPath: vi.fn(async () => join(tempDir, 'unexpected.png')),
            stagedRasterPath: vi.fn(async (_document, pageNumber, dpi) => join(
                tempDir,
                `staged-${String(pageNumber)}-${String(dpi)}.png`,
            )),
            releaseRaster: vi.fn(async () => undefined),
            retain: vi.fn(),
            release: vi.fn(async () => undefined),
        };

        await expect(runScanCleanupDetection(
            createRequest(),
            new AbortController().signal,
            retention,
            {
                getTempDir: () => tempDir,
                getAvailableScratchBytes: vi.fn(async () => null),
                getPdftoppmBinary: () => 'pdftoppm',
                resolveBinary: () => 'evb-scan-cleanup',
                renderPage,
                renderPagePpm: vi.fn(),
                runSidecar: vi.fn(),
            },
            {rasterConcurrency: 2},
            () => undefined,
        )).rejects.toThrow(
            'Scan cleanup detection received page geometry out of document order: expected page 1 at index 0, received page 3',
        );

        expect(retention.rasterPages).not.toHaveBeenCalled();
        expect(renderPage).not.toHaveBeenCalled();
        expect(retention.retain).not.toHaveBeenCalled();
        expect(retention.release).toHaveBeenCalledOnce();
    });
});
