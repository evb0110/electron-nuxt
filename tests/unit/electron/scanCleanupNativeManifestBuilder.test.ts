import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {
    join,
    resolve,
} from 'node:path';
import {
    existsSync,
    realpathSync,
} from 'node:fs';
import type {
    INativeScanCleanupManifestV3,
    IScanCleanupNormalizedZonePolygon,
    IScanCleanupOptions,
    TNativeScanCleanupOperation,
    TNativeScanCleanupRenderMode,
    TScanCleanupCanvasScope,
} from '@contracts/electronApiScanCleanup';
import {
    buildGeometryOnlyNativeScanCleanupManifest,
    buildRunnableNativeScanCleanupManifest,
    serializeNativeScanCleanupOptions,
    type IScanCleanupManifestPageInput,
} from '@scan-cleanup-core/policy/buildNativeScanCleanupManifest';
import {assertNativeScanCleanupManifestGeometry} from '@scan-cleanup-core/policy/assertNativeScanCleanupManifestGeometry';
import {resolveEffectiveScanCleanupOptions} from '@scan-cleanup-core/policy/effectiveOptions';
import {ScanCleanupContractError} from '@scan-cleanup-core/errors';
import {
    afterAll,
    beforeAll,
    describe,
    expect,
    it,
} from 'vitest';

const fixtureDirectory = resolve('native/scan-cleanup/tests/fixtures/protocol');

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    thickness: 0,
    crop: true,
    matchPageSize: true,
    pageAlignment: 'top-center',
    marginsMm: {
        leftMm: 5,
        topMm: 5,
        rightMm: 5,
        bottomMm: 5,
    },
    despeckle: true,
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

interface IGoldenCase {
    name: string;
    operation: TNativeScanCleanupOperation;
    renderMode: TNativeScanCleanupRenderMode;
    canvasScope: TScanCleanupCanvasScope;
    qualityPath: 'raster' | 'lossless';
    withOutput: boolean;
}

const cases: IGoldenCase[] = [
    {
        name: 'preview-raster-v3.json',
        operation: 'render',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        withOutput: true,
    },
    {
        name: 'detect-all-v3.json',
        operation: 'analyze',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        withOutput: false,
    },
    {
        name: 'raster-final-v3.json',
        operation: 'render',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'raster',
        withOutput: true,
    },
    {
        name: 'lossless-final-v3.json',
        operation: 'analyze',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'lossless',
        withOutput: false,
    },
];

describe('native scan-cleanup manifest builder', () => {
    it('keeps manual crops out of automatic page-plan evidence but retains them for rendering', () => {
        const manualContentBoxes = {right: {
            xNormalized: 0.55,
            yNormalized: 0.1,
            widthNormalized: 0.35,
            heightNormalized: 0.8,
            rotationDegrees: 0 as const,
        }};
        const optionsWithManualCrop: IScanCleanupOptions = {
            ...options,
            pageOverrides: {'1': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                manualContentBoxes,
            }},
        };
        const page = {
            inputPath: '/fixtures/input/page-1.png',
            pageNumber: 1,
            dpi: 150,
            pageMetadataPath: '/fixtures/output/page-1.json',
        };
        const pagePlan = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'analyze',
            analysisPurpose: 'page-plan',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options: optionsWithManualCrop,
            pages: [page],
        });
        const preview = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options: optionsWithManualCrop,
            pages: [{
                ...page,
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        expect(pagePlan.pages[0]?.options.manualContentBoxes).toEqual({});
        expect(preview.pages[0]?.options.manualContentBoxes).toEqual(manualContentBoxes);
    });

    it('preflights a heterogeneous 392-page geometry ledger and names the exact bad page', () => {
        const rotations = [
            0,
            90,
            180,
            270,
        ] as const;
        const pageOverrides = Object.fromEntries(Array.from({length: 392}, (_, index) => {
            const pageNumber = index + 1;
            return [
                String(pageNumber),
                {
                    rotationDegrees: rotations[index % rotations.length]!,
                    layoutOverride: 'auto' as const,
                    excluded: false,
                    manualSplit: null,
                },
            ];
        }));
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options: {
                ...options,
                pageOverrides,
            },
            pages: Array.from({length: 392}, (_, index) => {
                const pageNumber = index + 1;
                const rotationDegrees = rotations[index % rotations.length]!;
                const xNormalized = (index % 7) / 100;
                const yNormalized = (index % 11) / 100;
                return {
                    inputPath: `/fixtures/input/page-${String(pageNumber)}.png`,
                    pageNumber,
                    dpi: 300,
                    automaticContentBoxes: {full: {
                        xNormalized,
                        yNormalized,
                        widthNormalized: 1 - xNormalized,
                        heightNormalized: 1 - yNormalized,
                        rotationDegrees,
                    }},
                    pageMetadataPath: `/fixtures/output/page-${String(pageNumber)}.json`,
                };
            }),
        });

        expect(() => assertNativeScanCleanupManifestGeometry(manifest)).not.toThrow();
        manifest.pages[336]!.options.automaticContentBoxes = {right: {
            xNormalized: 0.72,
            yNormalized: 0.1,
            widthNormalized: 0.29,
            heightNormalized: 0.8,
            rotationDegrees: manifest.pages[336]!.options.rotationDegrees,
        }};
        expect(() => assertNativeScanCleanupManifestGeometry(manifest))
            .toThrow('Scan cleanup page 337 has invalid automatic right content box geometry');
    });

    it('derives native layout and output mode from reusable detection evidence', () => {
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 150,
                observedLayout: 'single-uncut-page',
                resolvedOutputMode: 'bw',
                pageMetadataPath: '/fixtures/output/page-1.json',
            }],
        });

        expect(manifest.pages[0]?.options).toMatchObject({
            layout: 'force-single',
            outputMode: 'bw',
        });
    });

    it('clamps trusted native pixel limits to the engine guardrails', () => {
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                resolvedOptions: {
                    maxPixels: Number.MAX_SAFE_INTEGER,
                    maxDimensionPx: Number.MAX_SAFE_INTEGER,
                },
            }],
        });

        expect(manifest.pages[0]?.options).toMatchObject({
            maxPixels: 160_000_000,
            maxDimensionPx: 40_000,
        });
        expect(() => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                resolvedOptions: {maxPixels: Number.NaN},
            }],
        })).toThrow(ScanCleanupContractError);
    });

    it('rejects a soft-alpha output plane without a base layer', () => {
        expect(() => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                    foregroundAlphaOutputPath: '/fixtures/output/page-1-alpha.pgm',
                }],
            }],
        })).toThrow(ScanCleanupContractError);
    });

    it.each(cases)('matches the shared $name golden', async testCase => {
        const golden = JSON.parse(await readFile(resolve(fixtureDirectory, testCase.name), 'utf8')) as INativeScanCleanupManifestV3;
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: testCase.operation,
            renderMode: testCase.renderMode,
            canvasScope: testCase.canvasScope,
            ...(testCase.operation === 'render' && testCase.canvasScope === 'document'
                ? {documentCanvas: {
                    widthPx: 2_550,
                    heightPx: 3_300,
                    widthPoints: 612,
                    heightPoints: 792,
                }}
                : {}),
            qualityPath: testCase.qualityPath,
            ...(testCase.name === 'raster-final-v3.json'
                ? {documentCanvas: {
                    widthPoints: 612,
                    heightPoints: 792,
                    widthPx: 2_550,
                    heightPx: 3_300,
                }}
                : {}),
            options: testCase.name === 'preview-raster-v3.json'
                ? {
                    ...options,
                    matchPageSize: false,
                }
                : options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                ...(testCase.name === 'preview-raster-v3.json'
                    ? {renderCrop: {
                        xNormalized: 0.25,
                        yNormalized: 0.2,
                        widthNormalized: 0.5,
                        heightNormalized: 0.4,
                        rotationDegrees: 0 as const,
                    }}
                    : {}),
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: testCase.withOutput ? [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                    ...(testCase.renderMode === 'final'
                        ? {
                            bilevelOutputPath: '/fixtures/output/page-1.pbm',
                            backgroundOutputPath: '/fixtures/output/page-1-background.png',
                            foregroundMaskOutputPath: '/fixtures/output/page-1-mask.pbm',
                        }
                        : {}),
                }] : [],
            }],
        });
        expect(manifest).toEqual(golden);
    });

    it('omits additive option keys when they only repeat legacy-derived defaults', () => {
        for (const despeckle of [
            false,
            true,
        ]) {
            const manifest = buildGeometryOnlyNativeScanCleanupManifest({
                operation: 'analyze',
                renderMode: 'preview',
                canvasScope: 'page',
                qualityPath: 'raster',
                options: {
                    ...options,
                    despeckle,
                },
                pages: [{
                    inputPath: '/fixtures/input/page-1.png',
                    pageNumber: 1,
                    dpi: 300,
                    pageMetadataPath: '/fixtures/output/page-1.json',
                }],
            });

            expect(manifest.pages[0]?.options).not.toHaveProperty('despeckleLevel');
            expect(manifest.pages[0]?.options).not.toHaveProperty('manualZones');
        }
    });

    it('includes additive option keys when they carry new behavior', () => {
        const polygon: IScanCleanupNormalizedZonePolygon = {
            points: [
                {
                    xNormalized: 0.1,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.9,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.9,
                    yNormalized: 0.9,
                },
            ],
            rotationDegrees: 0,
        };
        const effective = resolveEffectiveScanCleanupOptions({
            options: {
                ...options,
                outputMode: 'mixed',
                pageOverrides: {'1': {
                    rotationDegrees: 0,
                    layoutOverride: 'auto',
                    excluded: false,
                    manualSplit: null,
                    manualZones: {
                        picture: [],
                        fill: [polygon],
                    },
                }},
            },
            pageOverride: {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                manualSkewDegrees: -2.3,
                manualZones: {
                    picture: [],
                    fill: [polygon],
                },
            },
            dpi: 300,
            qualityPath: 'raster',
            experimental: {
                autoDewarp: true,
                autoDewarpDepth: 1.8,
            },
        });
        const serialized = serializeNativeScanCleanupOptions({
            ...effective,
            despeckleLevel: 'aggressive',
        });

        expect(serialized.despeckleLevel).toBe('aggressive');
        expect(serialized.manualZones).toEqual({
            picture: [],
            fill: [polygon],
        });
        expect(serialized.outputMode).toBe('mixed');
        expect(serialized.manualSkewDegrees).toBe(-2.3);
        expect(serialized.experimental.autoDewarpDepth).toBe(1.8);
    });

    it('matches the populated shared manifest golden', async () => {
        const picturePolygon: IScanCleanupNormalizedZonePolygon = {
            points: [
                {
                    xNormalized: 0.1,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.9,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.9,
                    yNormalized: 0.9,
                },
            ],
            rotationDegrees: 0,
        };
        const fillPolygon: IScanCleanupNormalizedZonePolygon = {
            points: [
                {
                    xNormalized: 0.2,
                    yNormalized: 0.2,
                },
                {
                    xNormalized: 0.4,
                    yNormalized: 0.2,
                },
                {
                    xNormalized: 0.4,
                    yNormalized: 0.4,
                },
            ],
            rotationDegrees: 0,
        };
        const populatedOptions: IScanCleanupOptions = {
            ...options,
            outputMode: 'mixed',
            pageOverrides: {'1': {
                rotationDegrees: 0,
                layoutOverride: 'auto',
                excluded: false,
                manualSplit: null,
                manualZones: {
                    picture: [{
                        polygon: picturePolygon,
                        layer: 'painter2',
                    }],
                    fill: [fillPolygon],
                },
            }},
        };
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            documentCanvas: {
                widthPoints: 420.25,
                heightPoints: 612.5,
                widthPx: 1751,
                heightPx: 2552,
            },
            options: populatedOptions,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                    bilevelOutputPath: '/fixtures/output/page-1.pbm',
                    backgroundOutputPath: '/fixtures/output/page-1-background.png',
                    foregroundMaskOutputPath: '/fixtures/output/page-1-mask.pbm',
                }],
            }],
        });
        manifest.pages[0]!.options = serializeNativeScanCleanupOptions({
            ...resolveEffectiveScanCleanupOptions({
                options: populatedOptions,
                pageOverride: populatedOptions.pageOverrides['1']!,
                dpi: 300,
                qualityPath: 'raster',
            }),
            despeckleLevel: 'aggressive',
        });
        const golden = JSON.parse(await readFile(
            resolve(fixtureDirectory, 'populated-raster-v3.json'),
            'utf8',
        )) as INativeScanCleanupManifestV3;

        expect(manifest).toEqual(golden);
    });

    it('threads an optional document prior only onto its target preview page', () => {
        const documentPrior = {
            dominantLayout: 'two-page-spread' as const,
            cutterRatioMedian: 0.535,
            clusterDims: {
                widthPx: 1200,
                heightPx: 871,
            },
            agreementStrength: 0.88,
        };
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'analyze',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options,
            pages: [
                {
                    inputPath: '/fixtures/input/page-1.png',
                    pageNumber: 1,
                    dpi: 150,
                    pageMetadataPath: '/fixtures/output/page-1.json',
                    documentPrior,
                },
                {
                    inputPath: '/fixtures/input/page-2.png',
                    pageNumber: 2,
                    dpi: 150,
                    pageMetadataPath: '/fixtures/output/page-2.json',
                },
            ],
        });

        expect(manifest.pages[0]?.documentPrior).toEqual(documentPrior);
        expect(manifest.pages[1]).not.toHaveProperty('documentPrior');
    });

    it('carries an explicit physical document canvas while canvas scope stays page-local', () => {
        const manifest = buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'preview',
            canvasScope: 'page',
            documentCanvas: {
                widthPoints: 420.25,
                heightPoints: 612.5,
                widthPx: 1751,
                heightPx: 2552,
            },
            qualityPath: 'raster',
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 150,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        expect(manifest).toMatchObject({
            canvasScope: 'page',
            documentCanvas: {
                widthPoints: 420.25,
                heightPoints: 612.5,
                widthPx: 1751,
                heightPx: 2552,
            },
        });
    });

    it('ships resolved ink anchors per page and names the page whose anchor is unusable', () => {
        const build = (anchorY: number) => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options: {
                ...options,
                matchPageSize: true,
                pageAlignment: 'ink',
            },
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 4,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                placementAnchors: {
                    full: {yNormalized: anchorY},
                    left: {yNormalized: 0.1},
                },
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        const manifest = build(0.125);
        expect(manifest.pages[0]?.options.placementAnchors).toEqual({
            full: {yNormalized: 0.125},
            left: {yNormalized: 0.1},
        });
        expect(() => assertNativeScanCleanupManifestGeometry(manifest)).not.toThrow();
        expect(() => assertNativeScanCleanupManifestGeometry(build(1.5)))
            .toThrow('Scan cleanup page 4 has invalid full placement anchor');
        expect(() => assertNativeScanCleanupManifestGeometry(build(Number.NaN)))
            .toThrow('Scan cleanup page 4 has invalid full placement anchor');
    });

    it('reports the host memory the sidecar cannot read for itself, and omits it when unknown', () => {
        const build = (hostMemoryBytes?: number) => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            ...(hostMemoryBytes === undefined ? {} : {hostMemoryBytes}),
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        expect(build(34_359_738_368).hostMemoryBytes).toBe(34_359_738_368);
        expect(build()).not.toHaveProperty('hostMemoryBytes');
        expect(build(0)).not.toHaveProperty('hostMemoryBytes');
    });

    it('bounds an explicit streamed-raster lookahead and omits it for replayable inputs', () => {
        const build = (rasterWindow?: number) => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            ...(rasterWindow === undefined ? {} : {rasterWindow}),
            pages: [{
                inputPath: '/fixtures/input/page-1.ppm',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
                }],
            }],
        });

        expect(build(3).rasterWindow).toBe(3);
        expect(build(99).rasterWindow).toBe(16);
        expect(build()).not.toHaveProperty('rasterWindow');
    });
});

describe('runnable native scan-cleanup manifest path containment', () => {
    let temporaryDirectory = '';
    let siblingSentinel = '';
    let root = '';
    let canonicalRoot = '';
    let outside = '';

    const runnable = (pages: Parameters<typeof buildRunnableNativeScanCleanupManifest>[0]['pages'], allowedPathRoot = root) => buildRunnableNativeScanCleanupManifest({
        operation: 'render',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'raster',
        options,
        allowedPathRoot,
        pages,
    });

    const page = (inputPath: string, outputPath: string) => ({
        inputPath,
        pageNumber: 1,
        dpi: 300,
        pageMetadataPath: join(root, 'page-1.json'),
        outputs: [{
            outputPath,
            metadataPath: join(root, 'page-1-output.json'),
        }],
    });

    beforeAll(async () => {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'scan-cleanup-root-boundary-'));
        // A sibling of the minted directory. Teardown that walks up from a path
        // inside the fixture instead of removing the minted directory itself
        // would take this too, and with it whatever else lives in the OS temp
        // root.
        siblingSentinel = await mkdtemp(join(tmpdir(), 'scan-cleanup-root-boundary-sentinel-'));
        root = join(temporaryDirectory, 'root');
        outside = join(temporaryDirectory, 'outside');
        await mkdir(root);
        await mkdir(outside);
        await mkdir(join(root, 'nested'));
        canonicalRoot = realpathSync(root);
        await writeFile(join(root, 'input.png'), 'input');
        await writeFile(join(outside, 'secret.png'), 'secret');
        await symlink(join(outside, 'secret.png'), join(root, 'input-link.png'));
        await symlink(join(root, 'input.png'), join(root, 'inside-link.png'));
        await symlink(outside, join(root, 'escape-dir'));
        await symlink(join(outside, 'missing.png'), join(root, 'dangling.png'));
    });

    afterAll(async () => {
        if (temporaryDirectory !== '') {
            await rm(temporaryDirectory, {
                recursive: true,
                force: true,
            });
            expect(existsSync(temporaryDirectory)).toBe(false);
        }
        if (siblingSentinel !== '') {
            expect(existsSync(siblingSentinel)).toBe(true);
            await rm(siblingSentinel, {
                recursive: true,
                force: true,
            });
        }
    });

    it('accepts an existing input and a missing output below a real directory', () => {
        expect(() => runnable([page(join(root, 'input.png'), join(root, 'nested/output.png'))])).not.toThrow();
    });

    it('accepts a symlink that resolves back inside the root', () => {
        expect(() => runnable([page(join(root, 'inside-link.png'), join(root, 'nested/output.png'))])).not.toThrow();
    });

    it('rejects an existing input symlink that points outside the root', () => {
        expect(() => runnable([page(join(root, 'input-link.png'), join(root, 'nested/output.png'))]))
            .toThrow(ScanCleanupContractError);
    });

    it('rejects a missing output below a directory symlinked outside the root', () => {
        expect(() => runnable([page(join(root, 'input.png'), join(root, 'escape-dir/output.png'))]))
            .toThrow(ScanCleanupContractError);
    });

    it('rejects a dangling symlink segment', () => {
        expect(() => runnable([page(join(root, 'dangling.png'), join(root, 'nested/output.png'))]))
            .toThrow(/unresolved symlink/u);
    });

    it('rejects a lexical parent-directory escape', () => {
        expect(() => runnable([page(join(root, 'input.png'), join(root, '../outside/output.png'))]))
            .toThrow(ScanCleanupContractError);
    });

    it('rejects a relative candidate path and a relative root', () => {
        expect(() => runnable([page('input.png', join(root, 'nested/output.png'))]))
            .toThrow(/must be an absolute path/u);
        expect(() => runnable(
            [page(join(root, 'input.png'), join(root, 'nested/output.png'))],
            'relative-root',
        )).toThrow(/must be an absolute path/u);
    });

    it('rejects a root that does not exist or is not a directory', () => {
        expect(() => runnable(
            [page(join(root, 'input.png'), join(root, 'nested/output.png'))],
            join(root, 'no-such-root'),
        )).toThrow(/allowed root does not exist/u);
        expect(() => runnable(
            [page(join(root, 'input.png'), join(root, 'nested/output.png'))],
            join(root, 'input.png'),
        )).toThrow(/allowed root is not a directory/u);
    });

    it('treats a canonical root alias such as /var and /private/var as the same root', () => {
        // On macOS the OS temp directory is reached through a symlinked /var.
        // The uncanonicalized spelling and its canonical form describe the same
        // directory, and both must accept the same paths.
        expect(() => runnable(
            [page(join(root, 'input.png'), join(root, 'nested/output.png'))],
            canonicalRoot,
        )).not.toThrow();
        expect(() => runnable(
            [page(join(canonicalRoot, 'input.png'), join(canonicalRoot, 'nested/output.png'))],
            root,
        )).not.toThrow();
    });

    // The builder names every path field it checks by hand, so each auxiliary
    // slot is exercised directly: a symlink resolving back inside the root is
    // accepted, and the same slot holding a symlink that resolves outside it is
    // rejected. A field dropped from the builder's list fails here.
    const region = {
        xPx: 0,
        yPx: 0,
        widthPx: 16,
        heightPx: 16,
    };
    const detailPlan = (
        baseMetadataPath: string,
        baseRasterPath: string,
        baseCleanedRasterPath: string,
    ) => ({
        baseMetadataPath,
        baseRasterPath,
        baseCleanedRasterPath,
        sourceCrop: region,
        fullSourceWidthPx: 32,
        fullSourceHeightPx: 32,
        scale: 1,
        renderRegion: region,
        sampledRegion: region,
    });

    type TAuxiliarySlot = (target: IScanCleanupManifestPageInput, path: string) => void;

    const auxiliarySlots: Array<[string, TAuxiliarySlot]> = [
        [
            'analysisInputPath',
            (target, path) => {
                target.analysisInputPath = path;
                target.analysisDpi = 150;
            },
        ],
        [
            'trustedForegroundMaskPath',
            (target, path) => void (target.trustedForegroundMaskPath = path),
        ],
        [
            'trustedMrcBackgroundPath',
            (target, path) => void (target.trustedMrcBackgroundPath = path),
        ],
        [
            'detailRenderPlan.baseMetadataPath',
            (target, path) => void (target.detailRenderPlan = detailPlan(
                path,
                join(root, 'inside-link.png'),
                join(root, 'inside-link.png'),
            )),
        ],
        [
            'detailRenderPlan.baseRasterPath',
            (target, path) => void (target.detailRenderPlan = detailPlan(
                join(root, 'inside-link.png'),
                path,
                join(root, 'inside-link.png'),
            )),
        ],
        [
            'detailRenderPlan.baseCleanedRasterPath',
            (target, path) => void (target.detailRenderPlan = detailPlan(
                join(root, 'inside-link.png'),
                join(root, 'inside-link.png'),
                path,
            )),
        ],
        [
            'pageMetadataPath',
            (target, path) => void (target.pageMetadataPath = path),
        ],
        [
            'outputs.metadataPath',
            (target, path) => void (target.outputs![0]!.metadataPath = path),
        ],
        [
            'outputs.bilevelOutputPath',
            (target, path) => void (target.outputs![0]!.bilevelOutputPath = path),
        ],
        [
            'outputs.backgroundOutputPath',
            (target, path) => void (target.outputs![0]!.backgroundOutputPath = path),
        ],
        [
            'outputs.foregroundMaskOutputPath',
            (target, path) => {
                target.outputs![0]!.backgroundOutputPath = join(root, 'inside-link.png');
                target.outputs![0]!.foregroundMaskOutputPath = path;
            },
        ],
        [
            'outputs.foregroundAlphaOutputPath',
            (target, path) => {
                target.outputs![0]!.backgroundOutputPath = join(root, 'inside-link.png');
                target.outputs![0]!.foregroundAlphaOutputPath = path;
            },
        ],
        [
            'outputs.pictureMaskOutputPath',
            (target, path) => void (target.outputs![0]!.pictureMaskOutputPath = path),
        ],
        [
            'outputs.tonePreservationAlphaOutputPath',
            (target, path) => void (target.outputs![0]!.tonePreservationAlphaOutputPath = path),
        ],
    ];

    const pageWithSlot = (fill: TAuxiliarySlot, path: string) => {
        const target: IScanCleanupManifestPageInput = page(
            join(root, 'input.png'),
            join(root, 'nested/output.png'),
        );
        fill(target, path);
        return target;
    };

    it.each(auxiliarySlots)('judges %s by the same root as the page input', (_label, fill) => {
        expect(() => runnable([pageWithSlot(fill, join(root, 'inside-link.png'))])).not.toThrow();
        expect(() => runnable([pageWithSlot(fill, join(root, 'input-link.png'))]))
            .toThrow(ScanCleanupContractError);
    });

    it('keeps geometry-only placeholders out of path validation and matches the runnable assembly', () => {
        const placeholderPages = [{
            inputPath: '',
            pageNumber: 1,
            dpi: 300,
            pageMetadataPath: '',
        }];
        expect(() => buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: placeholderPages,
        })).not.toThrow();

        const realPages = [page(join(root, 'input.png'), join(root, 'nested/output.png'))];
        expect(runnable(realPages)).toEqual(buildGeometryOnlyNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            pages: realPages,
        }));
    });
});
