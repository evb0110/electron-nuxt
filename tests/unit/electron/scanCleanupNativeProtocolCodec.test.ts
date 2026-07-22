import {
    describe,
    expect,
    it,
} from 'vitest';
import {decodeNativeScanCleanupEnvelope} from '@electron/features/scan-cleanup/native/protocolCodec';

describe('scan-cleanup native protocol codec', () => {
    it('decodes reconciliation diagnostics and the reusable document prior', () => {
        const documentPrior = {
            dominantLayout: 'two-page-spread',
            cutterRatioMedian: 0.535,
            clusterDims: {
                widthPx: 2203,
                heightPx: 1600,
            },
            agreementStrength: 0.885,
        };
        const decoded = decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 2,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 2,
                totalPages: 4,
                pageNumber: 2,
                outputPaths: [],
                classification: 'two-page-spread',
                confidence: 0.984,
                cutterXPx: 1180,
                tier1Verdict: 'single-uncut-page',
                reconciled: true,
                clusterAgreement: 0.885,
                documentPrior,
                textAxis: {
                    sideways: true,
                    confidence: 0.97,
                },
            },
        }));

        expect(decoded).toMatchObject({
            type: 'progress',
            progress: {
                tier1Verdict: 'single-uncut-page',
                reconciled: true,
                clusterAgreement: 0.885,
                documentPrior,
                textAxis: {
                    sideways: true,
                    confidence: 0.97,
                },
            },
        });
    });

    it('omits an absent text axis and rejects malformed axis confidence', () => {
        const withoutAxis = decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 2,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 1,
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
            },
        }));
        expect(withoutAxis.type === 'progress' && withoutAxis.progress).not.toHaveProperty('textAxis');

        expect(() => decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 2,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 1,
                pageNumber: 1,
                classification: 'single-uncut-page',
                confidence: 0.9,
                textAxis: {
                    sideways: true,
                    confidence: 1.1,
                },
            },
        }))).toThrow('text axis');
    });

    it('rejects an invalid spread prior without a cutter median', () => {
        expect(() => decodeNativeScanCleanupEnvelope(JSON.stringify({
            version: 2,
            type: 'progress',
            progress: {
                stage: 'page-complete',
                completedPages: 1,
                totalPages: 1,
                pageNumber: 1,
                classification: 'two-page-spread',
                confidence: 0.9,
                documentPrior: {
                    dominantLayout: 'two-page-spread',
                    cutterRatioMedian: null,
                    clusterDims: {
                        widthPx: 1200,
                        heightPx: 871,
                    },
                    agreementStrength: 0.8,
                },
            },
        }))).toThrow('document prior');
    });
});
