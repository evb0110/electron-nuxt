import {
    decodeNativeScanCleanupOutputMetadata,
    decodeNativeScanCleanupOutputMetadataJson,
    decodeNativeScanCleanupPageMetadata,
    decodeNativeScanCleanupPageMetadataJson,
    decodeNativeScanCleanupPreviewOutputMetadataJson,
    decodeNativeScanCleanupPreviewPageMetadataJson,
    InvalidScanCleanupNativeArtifactError,
} from '@contracts/scan-cleanup/nativeArtifactCodecs';
import {
    describe,
    expect,
    it,
} from 'vitest';

const rect = {
    xPx: 0,
    yPx: 0,
    widthPx: 100,
    heightPx: 200,
};
const appliedMargins = {
    leftPx: 0,
    topPx: 0,
    rightPx: 0,
    bottomPx: 0,
};

function pageMetadata() {
    return {
        sourcePageIndex: 0,
        layoutClassification: 'single-uncut-page',
        layoutConfidence: 0.9,
        cutterXPx: null,
        rotationDegrees: 0,
        canvasScope: 'page',
        excluded: false,
        blankOutputsSkipped: 0,
        outputCount: 1,
        outputs: [{
            half: 'full',
            sourceRegion: rect,
            contentBox: null,
            cropRect: rect,
            appliedMargins,
            inputWidthPx: 100,
            inputHeightPx: 200,
        }],
        tier1Verdict: 'single-uncut-page',
        reconciled: false,
        clusterAgreement: 0,
    };
}

function outputMetadata() {
    return {
        sourcePageIndex: 0,
        half: 'full',
        layoutClassification: 'single-uncut-page',
        layoutConfidence: 0.9,
        cutterXPx: null,
        sourceRegion: rect,
        contentBox: null,
        cropRect: rect,
        appliedMargins,
        outputWidthPx: 100,
        outputHeightPx: 200,
        canvasWidthPx: 100,
        canvasHeightPx: 200,
        inputWidthPx: 100,
        inputHeightPx: 200,
        skewApplied: false,
        placementOffsetXPx: 0,
        placementOffsetYPx: 0,
        forwardTransform: null,
        inverseTransform: null,
        dewarpModel: null,
        dewarpMapping: null,
        rotationDegrees: 0,
        canvasScope: 'page',
        resamplePasses: 0,
        warnings: [],
    };
}

describe('scan-cleanup native artifact codecs', () => {
    it('decodes page and output artifacts while preserving additive fields', () => {
        const page = {
            ...pageMetadata(),
            futurePageDiagnostic: {producer: 'vNext'},
        };
        const output = {
            ...outputMetadata(),
            futureOutputDiagnostic: {producer: 'vNext'},
        };

        expect(decodeNativeScanCleanupPageMetadata(page)).toBe(page);
        expect(decodeNativeScanCleanupOutputMetadata(output)).toBe(output);
        expect(decodeNativeScanCleanupPreviewPageMetadataJson(JSON.stringify(page))).toMatchObject({
            futurePageDiagnostic: {producer: 'vNext'},
            tier1Verdict: 'single-uncut-page',
        });
        expect(decodeNativeScanCleanupPreviewOutputMetadataJson(JSON.stringify(output))).toMatchObject({futureOutputDiagnostic: {producer: 'vNext'}});
    });

    it('rejects malformed JSON and unsupported artifact versions as native failures', () => {
        for (const decode of [
            () => decodeNativeScanCleanupPageMetadataJson('{'),
            () => decodeNativeScanCleanupOutputMetadataJson(JSON.stringify({
                ...outputMetadata(),
                version: 4,
            })),
        ]) {
            expect(decode).toThrow(InvalidScanCleanupNativeArtifactError);
            try {
                decode();
            } catch (error) {
                expect(error).toMatchObject({code: 'native-failure'});
            }
        }
    });

    it('rejects invalid discriminants, non-finite numbers, and oversized page collections', () => {
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            layoutClassification: 'future-layout',
        })).toThrow('unknown discriminant');
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            layoutConfidence: Number.NaN,
        })).toThrow('must be finite');
        expect(() => decodeNativeScanCleanupPageMetadata({
            ...pageMetadata(),
            outputCount: 3,
            outputs: [
                pageMetadata().outputs[0],
                pageMetadata().outputs[0],
                pageMetadata().outputs[0],
            ],
        })).toThrow('protocol limit');
    });

    it('rejects malformed nested output geometry before a consumer can use it', () => {
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            forwardTransform: {matrix: [[
                1,
                0,
                0,
            ]]},
        })).toThrow('must be 3x3');
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            dewarpMapping: {
                columns: 2,
                rows: 2,
                outputOrigin: {
                    x: 0,
                    y: 0,
                },
                outputWidth: 100,
                outputHeight: 200,
                outputToSource: [],
                sourceToOutput: [],
            },
        })).toThrow('length does not match its grid');
    });

    it('validates persisted spread binarization decisions', () => {
        const output = {
            ...outputMetadata(),
            binarizationMode: 'otsu',
            binarizationDiagnostics: {
                route: 'otsu',
                robustContrast: 80,
                illuminationDeviation: 4,
                edgeDensity: 0.12,
                estimatedStrokeWidthPx: 3,
                darkBorderCoverage: 0,
                otsuAdaptiveAgreement: 0.98,
                spreadPlan: {
                    route: 'otsu',
                    thresholdAnchor: 127,
                    thresholdRadius: 27,
                    strokeWidthAnchorPx: 2.5,
                    xHeightAnchorPx: 18,
                    documentAnchor: true,
                    jointCandidateRoute: 'otsu',
                    leftCandidateRoute: 'wolf',
                    rightCandidateRoute: 'otsu',
                    decision: 'perLeafRouteMismatch',
                },
            },
        };

        expect(decodeNativeScanCleanupOutputMetadata(output)).toBe(output);
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...output,
            binarizationDiagnostics: {
                ...output.binarizationDiagnostics,
                spreadPlan: {
                    ...output.binarizationDiagnostics.spreadPlan,
                    thresholdAnchor: 256,
                },
            },
        })).toThrow('thresholdAnchor must be <= 255');
    });

    it('accepts a recorded left white-tail overhang when the optical box stays bounded', () => {
        const output = {
            ...outputMetadata(),
            matchedCanvasContentWidthPx: 1000,
            matchedCanvasContentHeightPx: 500,
            intrinsicRasterWidthPx: 1000,
            intrinsicRasterHeightPx: 500,
            canvasWidthPx: 1000,
            canvasHeightPx: 500,
            matchedCanvasOpticalPlacement: true,
            matchedCanvasOpticalContentLeftPx: 300,
            matchedCanvasOpticalContentRightPx: 950,
            matchedCanvasIntrinsicOverflowLeftPx: 125,
            softMarginsPx: [
                0,
                0,
                0,
                0,
            ],
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
        };

        expect(decodeNativeScanCleanupOutputMetadata(output)).toBe(output);
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...output,
            matchedCanvasIntrinsicOverflowLeftPx: 1001,
        })).toThrow('intrinsic content placement exceeds its canvas');
    });

    it('rejects inconsistent or fully off-canvas intrinsic overflow intervals', () => {
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            matchedCanvasContentWidthPx: 200,
            canvasWidthPx: 100,
            matchedCanvasIntrinsicOverflowLeftPx: 200,
            placementOffsetXPx: 0,
        })).toThrow('intrinsic content placement exceeds its canvas');
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            matchedCanvasIntrinsicOverflowLeftPx: 10,
            placementOffsetXPx: 5,
        })).toThrow('intrinsic content placement exceeds its canvas');
        expect(() => decodeNativeScanCleanupOutputMetadata({
            ...outputMetadata(),
            matchedCanvasIntrinsicOverflowTopPx: 201,
            placementOffsetYPx: 0,
        })).toThrow('intrinsic content placement exceeds its canvas');
    });

    it('accepts a bounded top headroom trim that still intersects the canvas', () => {
        const output = {
            ...outputMetadata(),
            matchedCanvasIntrinsicOverflowTopPx: 80,
            placementOffsetYPx: 0,
        };

        expect(decodeNativeScanCleanupOutputMetadata(output)).toBe(output);
    });

    it('enforces preview-only required metadata at the native preview boundary', () => {
        const page = pageMetadata();
        delete (page.outputs[0] as Partial<typeof page.outputs[number]>).appliedMargins;
        expect(() => decodeNativeScanCleanupPreviewPageMetadataJson(JSON.stringify(page)))
            .toThrow('appliedMargins is required for preview');

        const output = outputMetadata();
        delete (output as Partial<typeof output>).sourceRegion;
        expect(() => decodeNativeScanCleanupPreviewOutputMetadataJson(JSON.stringify(output)))
            .toThrow('sourceRegion is required for preview');
    });
});
