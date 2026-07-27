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
        outputs: {full: {
            contentBox: {
                xNormalized: 0.1,
                yNormalized: 0.2,
                widthNormalized: 0.7,
                heightNormalized: 0.6,
                rotationDegrees: 0,
            },
            detectedSkewDegrees: -0.2,
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
    });
});
