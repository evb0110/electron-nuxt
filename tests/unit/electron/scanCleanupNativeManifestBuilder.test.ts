import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {
    INativeScanCleanupManifestV3,
    IScanCleanupNormalizedZonePolygon,
    IScanCleanupOptions,
    TNativeScanCleanupOperation,
    TNativeScanCleanupRenderMode,
    TScanCleanupCanvasScope,
} from '@contracts/electronApiScanCleanup';
import {
    buildNativeScanCleanupManifest,
    serializeNativeScanCleanupOptions,
} from '@electron/features/scan-cleanup/policy/buildNativeScanCleanupManifest';
import {assertNativeScanCleanupManifestGeometry} from '@electron/features/scan-cleanup/policy/assertNativeScanCleanupManifestGeometry';
import {resolveEffectiveScanCleanupOptions} from '@electron/features/scan-cleanup/policy/effectiveOptions';
import {ScanCleanupContractError} from '@scan-cleanup-core/errors';
import {
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
        const pagePlan = buildNativeScanCleanupManifest({
            operation: 'analyze',
            analysisPurpose: 'page-plan',
            renderMode: 'preview',
            canvasScope: 'page',
            qualityPath: 'raster',
            options: optionsWithManualCrop,
            pages: [page],
        });
        const preview = buildNativeScanCleanupManifest({
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
        const manifest = buildNativeScanCleanupManifest({
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
        const manifest = buildNativeScanCleanupManifest({
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
        const manifest = buildNativeScanCleanupManifest({
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
        expect(() => buildNativeScanCleanupManifest({
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

    it('rejects manifest paths that escape the native work root', () => {
        expect(() => buildNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            allowedPathRoot: '/tmp/scan-cleanup-boundary',
            pages: [{
                inputPath: '/tmp/scan-cleanup-boundary/../outside.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/tmp/scan-cleanup-boundary/page-1.json',
            }],
        })).toThrow(ScanCleanupContractError);

        expect(() => buildNativeScanCleanupManifest({
            operation: 'render',
            renderMode: 'final',
            canvasScope: 'document',
            qualityPath: 'raster',
            options,
            allowedPathRoot: '/tmp/scan-cleanup-boundary',
            pages: [{
                inputPath: '/tmp/scan-cleanup-boundary/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/tmp/scan-cleanup-boundary/page-1.json',
                outputs: [{
                    outputPath: '/tmp/scan-cleanup-boundary/../outside.png',
                    metadataPath: '/tmp/scan-cleanup-boundary/page-1-output.json',
                }],
            }],
        })).toThrow(ScanCleanupContractError);
    });

    it('rejects a soft-alpha output plane without a base layer', () => {
        expect(() => buildNativeScanCleanupManifest({
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
        const manifest = buildNativeScanCleanupManifest({
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
            const manifest = buildNativeScanCleanupManifest({
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
        const manifest = buildNativeScanCleanupManifest({
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
        const manifest = buildNativeScanCleanupManifest({
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
        const manifest = buildNativeScanCleanupManifest({
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

    it('reports the host memory the sidecar cannot read for itself, and omits it when unknown', () => {
        const build = (hostMemoryBytes?: number) => buildNativeScanCleanupManifest({
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
        const build = (rasterWindow?: number) => buildNativeScanCleanupManifest({
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
