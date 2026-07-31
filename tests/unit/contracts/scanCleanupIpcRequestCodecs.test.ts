import {
    describe,
    expect,
    it,
} from 'vitest';
import {decodeStartArgs} from '@contracts/scan-cleanup/ipcRequestCodecs';

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
});
