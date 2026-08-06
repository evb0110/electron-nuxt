import {
    describe,
    expect,
    it,
} from 'vitest';
import type {IScanCleanupOptions} from '@contracts/electronApiScanCleanup';
import {createScanCleanupPageOverride} from '@contracts/scanCleanupPageOverrides';
import {
    SCAN_CLEANUP_CORE_BUILD_ID,
    SCAN_CLEANUP_STAMP_SCHEMA_ID,
    ScanCleanupPageScopeError,
    assertScanCleanupProvenanceStamp,
    buildScanCleanupPagePlanDigest,
    buildScanCleanupProvenanceStamp,
    canonicalScanCleanupJson,
    decodeScanCleanupProvenanceStampHex,
    encodeScanCleanupProvenanceStampHex,
    materializeScanCleanupStampOptions,
    resolveEffectiveScanCleanupOptions,
    resolveScanCleanupPageScope,
    verifyScanCleanupProvenanceStampHex,
} from '@scan-cleanup-core/index';

const options: IScanCleanupOptions = {
    preserveOriginalQuality: false,
    layoutMode: 'auto',
    outputMode: 'auto',
    binarization: 'auto',
    normalizeIllumination: true,
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
    despeckleLevel: 'normal',
    autoDewarp: false,
    readingOrder: 'ltr',
    skipBlankPages: false,
    pageOverrides: {},
};

function effectiveOptions(pageNumber: number) {
    const resolved = resolveEffectiveScanCleanupOptions({
        options,
        pageOverride: createScanCleanupPageOverride(),
        dpi: 300,
        qualityPath: 'raster',
    });
    return {
        sourcePage: pageNumber,
        options: materializeScanCleanupStampOptions({
            nativeOptions: resolved,
            options,
            qualityPath: 'raster',
        }),
    };
}

describe('scan-cleanup provenance stamp contract', () => {
    it('canonicalizes sorted-key JSON and materializes stripped defaults', () => {
        expect(canonicalScanCleanupJson({
            z: 1,
            a: {
                d: 2,
                c: 3,
            },
        })).toBe(
            '{"a":{"c":3,"d":2},"z":1}',
        );
        expect(effectiveOptions(1).options).toMatchObject({
            sourceBackgroundDpi: null,
            renderCrop: null,
            despeckle: true,
            despeckleLevel: 'normal',
            manualZones: {
                picture: [],
                fill: [],
            },
            experimental: {
                autoDewarp: false,
                autoDewarpDepth: null,
            },
        });
    });

    it('round-trips the schema payload and verifies its source and plan', () => {
        const perSourcePage = [
            effectiveOptions(1),
            effectiveOptions(2),
        ];
        const outputMappings = [
            {
                sourcePage: 1,
                half: 'full' as const,
                outputOrdinal: 1,
                rotationDegrees: 0 as const,
                excluded: false,
                blank: false,
            },
            {
                sourcePage: 2,
                half: 'full' as const,
                outputOrdinal: null,
                rotationDegrees: 0 as const,
                excluded: true,
                blank: false,
            },
        ];
        const stamp = buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: perSourcePage,
            outputMappings,
            pagePlanDigests: perSourcePage.map(record => buildScanCleanupPagePlanDigest(
                record.sourcePage,
                record.options,
                {sourcePage: record.sourcePage},
            )),
            buildIds: {
                coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
                coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
                nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
                assemblerBackend: 'source-preserved',
                transportMode: 'source-preserved',
            },
        });
        const hex = encodeScanCleanupProvenanceStampHex(stamp);
        expect(hex).toMatch(/^[0-9a-f]+$/u);
        expect(decodeScanCleanupProvenanceStampHex(hex)).toEqual(stamp);
        expect(verifyScanCleanupProvenanceStampHex(hex, {expectedSourceSha256: 'a'.repeat(64)})).toMatchObject({status: 'valid'});
        expect(verifyScanCleanupProvenanceStampHex(hex, {expectedSourceSha256: 'c'.repeat(64)})).toMatchObject({status: 'invalid'});
        expect(verifyScanCleanupProvenanceStampHex(null)).toMatchObject({status: 'unstamped'});
        expect(() => decodeScanCleanupProvenanceStampHex(hex.toUpperCase())).toThrow(
            'lowercase hexadecimal',
        );
    });

    it('centralizes page-scope errors and rejects malformed mapping ordinals', () => {
        expect(resolveScanCleanupPageScope(undefined, 3)).toEqual([
            1,
            2,
            3,
        ]);
        expect(resolveScanCleanupPageScope([
            3,
            1,
            2,
        ], 3)).toEqual([
            1,
            2,
            3,
        ]);
        let error: unknown;
        try {
            resolveScanCleanupPageScope([
                1,
                2,
                2,
            ], 3);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(ScanCleanupPageScopeError);
        expect((error as ScanCleanupPageScopeError).code).toBe('SCAN_CLEANUP_INVALID_PAGE_SCOPE');

        const record = effectiveOptions(1);
        const malformed = buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: [record],
            outputMappings: [{
                sourcePage: 1,
                half: 'full',
                outputOrdinal: 1,
                rotationDegrees: 0,
                excluded: false,
                blank: false,
            }],
            pagePlanDigests: [buildScanCleanupPagePlanDigest(1, record.options, {})],
            buildIds: {
                coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
                coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
                nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
                assemblerBackend: 'source-preserved',
                transportMode: 'source-preserved',
            },
        });
        expect(() => assertScanCleanupProvenanceStamp({
            ...malformed,
            outputMappings: [{
                ...malformed.outputMappings[0]!,
                outputOrdinal: 2,
            }],
        })).toThrow('out-of-order output ordinals');
        expect(() => resolveScanCleanupPageScope([0], 3)).toThrow(ScanCleanupPageScopeError);
    });

    it('rejects non-simple manual-zone polygons in provenance options', () => {
        const record = effectiveOptions(1);
        record.options.manualZones.fill = [{
            points: [
                {
                    xNormalized: 0,
                    yNormalized: 0,
                },
                {
                    xNormalized: 1,
                    yNormalized: 1,
                },
                {
                    xNormalized: 0,
                    yNormalized: 1,
                },
                {
                    xNormalized: 0.8,
                    yNormalized: 0,
                },
            ],
            rotationDegrees: 0,
        }];

        expect(() => buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: [record],
            outputMappings: [{
                sourcePage: 1,
                half: 'full',
                outputOrdinal: 1,
                rotationDegrees: 0,
                excluded: false,
                blank: false,
            }],
            pagePlanDigests: [buildScanCleanupPagePlanDigest(1, record.options, {})],
            buildIds: {
                coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
                coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
                nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
                assemblerBackend: 'source-preserved',
                transportMode: 'source-preserved',
            },
        })).toThrow('intersecting');
    });

    it('rejects non-finite and internally inconsistent nested provenance diagnostics', () => {
        const nonFiniteRecord = effectiveOptions(1);
        nonFiniteRecord.options.automaticSkewDegrees = {full: Number.POSITIVE_INFINITY};
        expect(() => buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: [nonFiniteRecord],
            outputMappings: [{
                sourcePage: 1,
                half: 'full',
                outputOrdinal: 1,
                rotationDegrees: 0,
                excluded: false,
                blank: false,
            }],
            pagePlanDigests: [buildScanCleanupPagePlanDigest(1, nonFiniteRecord.options, {})],
            buildIds: {
                coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
                coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
                nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
                assemblerBackend: 'source-preserved',
                transportMode: 'source-preserved',
            },
        })).toThrow('Cannot canonicalize non-finite number');

        const inconsistentRecord = effectiveOptions(1);
        inconsistentRecord.options.resolvedTextToneDiagnostics = {full: {
            applied: false,
            rule: 'applied',
            textLineCount: 1,
            textInkPixels: 10,
            pictureFraction: 0,
            outsideMidtoneFraction: 0,
            outsideMidtoneLargestComponentFraction: 0,
            outsideMidtoneLargestComponentWidthFraction: 0,
            outsideMidtoneLargestComponentHeightFraction: 0,
            inkAnchor: 120,
            blackPoint: null,
            slope: null,
        }};
        expect(() => buildScanCleanupProvenanceStamp({
            sourceSha256: 'a'.repeat(64),
            effectiveOptions: [inconsistentRecord],
            outputMappings: [{
                sourcePage: 1,
                half: 'full',
                outputOrdinal: 1,
                rotationDegrees: 0,
                excluded: false,
                blank: false,
            }],
            pagePlanDigests: [buildScanCleanupPagePlanDigest(1, inconsistentRecord.options, {})],
            buildIds: {
                coreSchemaId: SCAN_CLEANUP_STAMP_SCHEMA_ID,
                coreBuildId: SCAN_CLEANUP_CORE_BUILD_ID,
                nativeBinarySha256s: {scanCleanup: 'b'.repeat(64)},
                assemblerBackend: 'source-preserved',
                transportMode: 'source-preserved',
            },
        })).toThrow('resolvedTextToneDiagnostics is invalid');
    });
});
