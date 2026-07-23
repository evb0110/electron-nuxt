import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {
    INativeScanCleanupManifestV2,
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
import {resolveEffectiveScanCleanupOptions} from '@electron/features/scan-cleanup/policy/effectiveOptions';
import {
    describe,
    expect,
    it,
} from 'vitest';

const fixtureDirectory = resolve('native/scan-cleanup/tests/fixtures/protocol');

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'bw',
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
        name: 'preview-raster-v2.json',
        operation: 'render',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        withOutput: true,
    },
    {
        name: 'detect-all-v2.json',
        operation: 'analyze',
        renderMode: 'preview',
        canvasScope: 'page',
        qualityPath: 'raster',
        withOutput: false,
    },
    {
        name: 'raster-final-v2.json',
        operation: 'render',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'raster',
        withOutput: true,
    },
    {
        name: 'lossless-final-v2.json',
        operation: 'analyze',
        renderMode: 'final',
        canvasScope: 'document',
        qualityPath: 'lossless',
        withOutput: false,
    },
];

describe('native scan-cleanup manifest builder', () => {
    it.each(cases)('matches the shared $name golden', async testCase => {
        const golden = JSON.parse(await readFile(resolve(fixtureDirectory, testCase.name), 'utf8')) as INativeScanCleanupManifestV2;
        const manifest = buildNativeScanCleanupManifest({
            operation: testCase.operation,
            renderMode: testCase.renderMode,
            canvasScope: testCase.canvasScope,
            qualityPath: testCase.qualityPath,
            options,
            pages: [{
                inputPath: '/fixtures/input/page-1.png',
                pageNumber: 1,
                dpi: 300,
                pageMetadataPath: '/fixtures/output/page-1.json',
                outputs: testCase.withOutput ? [{
                    outputPath: '/fixtures/output/page-1.png',
                    metadataPath: '/fixtures/output/page-1-output.json',
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
});
