import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    decodeOpenPdfPaths,
    decodeScanCleanupPageOverrides,
    decodeStartArgs,
    SCAN_CLEANUP_IPC_IDENTIFIER_LENGTH_MAX,
    SCAN_CLEANUP_IPC_MANUAL_ZONE_POINT_MAX,
    SCAN_CLEANUP_IPC_MANUAL_ZONE_MAX,
    SCAN_CLEANUP_IPC_PAGE_COLLECTION_MAX,
    SCAN_CLEANUP_IPC_PATH_LENGTH_MAX,
    SCAN_CLEANUP_IPC_POLYGON_POINT_MAX,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {decodeScanCleanupSettingsUpdateRequest} from '@contracts/scanCleanupSettings';

const request = {
    sourcePdfPath: '/tmp/source.pdf',
    ownerId: 'owner-1',
    documentRevision: 'revision-1',
    options: {
        preserveOriginalQuality: false,
        layoutMode: 'auto',
        outputMode: 'bw',
        readingOrder: 'ltr',
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
        skipBlankPages: false,
        pageOverrides: {},
    },
    layoutByPage: {'12': 'single-uncut-page'},
    pagePlanEvidenceByPage: {'12': {
        pageNumber: 12,
        rotationDegrees: 0,
        layoutClassification: 'single-uncut-page',
        automaticSplit: {
            xNormalized: 0.48,
            rotationDegrees: 0,
        },
        outputs: {full: {
            contentBox: {
                xNormalized: 0.1,
                yNormalized: 0.2,
                widthNormalized: 0.7,
                heightNormalized: 0.6,
                rotationDegrees: 0,
            },
            detectedSkewDegrees: -0.2,
            textToneDiagnostics: {
                applied: true,
                rule: 'applied',
                textLineCount: 24,
                textInkPixels: 12_400,
                pictureFraction: 0,
                outsideMidtoneFraction: 0.04,
                outsideMidtoneLargestComponentFraction: 0.002,
                outsideMidtoneLargestComponentWidthFraction: 0.9,
                outsideMidtoneLargestComponentHeightFraction: 0.01,
                inkAnchor: 133,
                blackPoint: 96.05263157894737,
                slope: 1.623931623931624,
            },
        }},
    }},
};

const basePageOverride = {
    rotationDegrees: 0,
    layoutOverride: 'auto',
    excluded: false,
    manualSplit: null,
} as const;

const triangle = {
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
            xNormalized: 0.5,
            yNormalized: 0.9,
        },
    ],
    rotationDegrees: 0,
} as const;

describe('scan-cleanup IPC request codecs', () => {
    it('decodes typed automatic page-plan evidence', () => {
        expect(decodeStartArgs([request])[0].pagePlanEvidenceByPage).toEqual(
            request.pagePlanEvidenceByPage,
        );
    });

    it('rejects stale-key and out-of-bounds automatic evidence', () => {
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'11': request.pagePlanEvidenceByPage['12']},
        }])).toThrow('page-plan evidence');
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'12': {
                ...request.pagePlanEvidenceByPage['12'],
                outputs: {full: {contentBox: {
                    ...request.pagePlanEvidenceByPage['12'].outputs.full.contentBox,
                    widthNormalized: 1,
                }}},
            }},
        }])).toThrow('content box');
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'12': {
                ...request.pagePlanEvidenceByPage['12'],
                automaticSplit: {
                    xNormalized: 1.2,
                    rotationDegrees: 0,
                },
            }},
        }])).toThrow('automatic split');
    });

    it('rejects incomplete or internally inconsistent text-tone evidence', () => {
        const evidence = request.pagePlanEvidenceByPage['12'].outputs.full.textToneDiagnostics;
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'12': {
                ...request.pagePlanEvidenceByPage['12'],
                outputs: {full: {
                    ...request.pagePlanEvidenceByPage['12'].outputs.full,
                    textToneDiagnostics: {
                        ...evidence,
                        outsideMidtoneLargestComponentHeightFraction: 1.1,
                    },
                }},
            }},
        }])).toThrow('text tone');
        expect(() => decodeStartArgs([{
            ...request,
            pagePlanEvidenceByPage: {'12': {
                ...request.pagePlanEvidenceByPage['12'],
                outputs: {full: {
                    ...request.pagePlanEvidenceByPage['12'].outputs.full,
                    textToneDiagnostics: {
                        ...evidence,
                        applied: false,
                    },
                }},
            }},
        }])).toThrow('text tone');
    });

    it('bounds renderer-controlled strings before accepting a request', () => {
        expect(() => decodeStartArgs([{
            ...request,
            sourcePdfPath: 'p'.repeat(SCAN_CLEANUP_IPC_PATH_LENGTH_MAX + 1),
        }])).toThrow('request');
        expect(() => decodeStartArgs([{
            ...request,
            ownerId: 'o'.repeat(SCAN_CLEANUP_IPC_IDENTIFIER_LENGTH_MAX + 1),
        }])).toThrow('owner context');
        expect(() => decodeOpenPdfPaths([['p'.repeat(SCAN_CLEANUP_IPC_PATH_LENGTH_MAX + 1)]])).toThrow('open PDF paths');
    });

    it('bounds every page-scoped request map', () => {
        const oversizedOverrides = Object.fromEntries(Array.from(
            {length: SCAN_CLEANUP_IPC_PAGE_COLLECTION_MAX + 1},
            (_, index) => [
                String(index + 1),
                basePageOverride,
            ],
        ));
        expect(() => decodeScanCleanupPageOverrides(oversizedOverrides)).toThrow(
            'too many scan-cleanup page overrides',
        );
        expect(() => decodeStartArgs([{
            ...request,
            outputModeRecommendations: Object.fromEntries(Object.keys(oversizedOverrides).map(
                pageNumber => [
                    pageNumber,
                    'bw',
                ],
            )),
        }])).toThrow('too many scan-cleanup output-mode recommendations');
    });

    it('bounds manual-zone counts and polygon point counts', () => {
        expect(() => decodeScanCleanupPageOverrides({'1': {
            ...basePageOverride,
            manualZones: {
                picture: [],
                fill: Array.from({length: SCAN_CLEANUP_IPC_MANUAL_ZONE_MAX + 1}, () => triangle),
            },
        }})).toThrow('too many scan-cleanup manual zones');

        const oversizedPolygon = {
            points: Array.from(
                {length: SCAN_CLEANUP_IPC_POLYGON_POINT_MAX + 1},
                (_, index) => ({
                    xNormalized: index / SCAN_CLEANUP_IPC_POLYGON_POINT_MAX,
                    yNormalized: index % 2,
                }),
            ),
            rotationDegrees: 0,
        };
        expect(() => decodeScanCleanupPageOverrides({'1': {
            ...basePageOverride,
            manualZones: {
                picture: [],
                fill: [oversizedPolygon],
            },
        }})).toThrow('fill zone 0');

        const regularPolygon = {
            points: Array.from(
                {length: SCAN_CLEANUP_IPC_POLYGON_POINT_MAX},
                (_, index) => {
                    const angle = index / SCAN_CLEANUP_IPC_POLYGON_POINT_MAX * Math.PI * 2;
                    return {
                        xNormalized: 0.5 + Math.cos(angle) * 0.4,
                        yNormalized: 0.5 + Math.sin(angle) * 0.4,
                    };
                },
            ),
            rotationDegrees: 0,
        };
        const polygonCount = Math.floor(
            SCAN_CLEANUP_IPC_MANUAL_ZONE_POINT_MAX / SCAN_CLEANUP_IPC_POLYGON_POINT_MAX,
        ) + 1;
        expect(() => decodeScanCleanupPageOverrides({'1': {
            ...basePageOverride,
            manualZones: {
                picture: [],
                fill: Array.from({length: polygonCount}, () => regularPolygon),
            },
        }})).toThrow('too many scan-cleanup manual-zone points');
    });

    it('rejects degenerate and self-intersecting manual polygons but accepts concave polygons', () => {
        const decode = (points: Array<{
            xNormalized: number;
            yNormalized: number;
        }>) =>
            decodeScanCleanupPageOverrides({'1': {
                ...basePageOverride,
                manualZones: {
                    picture: [],
                    fill: [{
                        points,
                        rotationDegrees: 0,
                    }],
                },
            }});
        for (const points of [
            [
                {
                    xNormalized: 0.1,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.8,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.8,
                    yNormalized: 0.1,
                },
            ],
            [
                {
                    xNormalized: 0.1,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.5,
                    yNormalized: 0.5,
                },
                {
                    xNormalized: 0.9,
                    yNormalized: 0.9,
                },
            ],
            [
                {
                    xNormalized: 0.1,
                    yNormalized: 0.1,
                },
                {
                    xNormalized: 0.9,
                    yNormalized: 0.9,
                },
                {
                    xNormalized: 0.1,
                    yNormalized: 0.9,
                },
                {
                    xNormalized: 0.9,
                    yNormalized: 0.1,
                },
            ],
        ]) expect(() => decode(points)).toThrow('polygon geometry');

        expect(() => decode([
            {
                xNormalized: 0.1,
                yNormalized: 0.1,
            },
            {
                xNormalized: 0.9,
                yNormalized: 0.1,
            },
            {
                xNormalized: 0.5,
                yNormalized: 0.5,
            },
            {
                xNormalized: 0.9,
                yNormalized: 0.9,
            },
            {
                xNormalized: 0.1,
                yNormalized: 0.9,
            },
        ])).not.toThrow();
    });

    it('applies the same override limits to settings-update IPC', () => {
        expect(() => decodeScanCleanupSettingsUpdateRequest({document: {
            sourceSha256: 'a'.repeat(64),
            patch: {overrides: {'1': {
                ...basePageOverride,
                manualZones: {
                    picture: [],
                    fill: Array.from({length: SCAN_CLEANUP_IPC_MANUAL_ZONE_MAX + 1}, () => triangle),
                },
            }}},
        }})).toThrow('too many scan-cleanup manual zones');
    });
});
