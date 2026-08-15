import { isRecord } from '@contracts/runtimeGuards';
import {
    SCAN_CLEANUP_ERROR_CODES,
    SCAN_CLEANUP_SUMMARY_SCHEMA,
} from '@contracts/scan-cleanup/ipc';
import {SCAN_CLEANUP_PROGRESS_SCHEMA} from '@contracts/scan-cleanup/progress';
import type {
    IScanCleanupPreviewMetadata,
    IScanCleanupRawPreviewEvent,
    IScanCleanupPreviewResult,
    TScanCleanupPreviewWireResult,
    TScanCleanupErrorCode,
    TScanCleanupDetectionJobState,
    TScanCleanupJobState,
} from '@contracts/scan-cleanup/ipc';
import {
    decodeDocumentPrior,
    decodeFiniteNumber,
    decodeScanCleanupPagePlanEvidence,
    decodeSourcePageMetadata,
    isLayoutClassification,
} from '@contracts/scan-cleanup/ipcRequestCodecs';
import {
    isNativeScanCleanupFoldBandV3,
    legacyNativeScanCleanupFoldBandV3,
} from '@contracts/scan-cleanup/nativeProtocolV3';
import {
    isScanCleanupOutputMode,
    isScanCleanupOutputModeRecommendationReason,
} from '@contracts/scan-cleanup/outputModeGuards';

const PREVIEW_MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PREVIEW_MAX_TOTAL_BYTES = 96 * 1024 * 1024;

function decodePreviewBytes(value: unknown, label: string) {
    if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > PREVIEW_MAX_IMAGE_BYTES) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function decodePositiveInteger(value: unknown, label: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`invalid scan-cleanup preview ${label}`);
    }
    return value;
}

function decodePositiveFiniteNumber(value: unknown, label: string) {
    const decoded = decodeFiniteNumber(value, label);
    if (decoded <= 0) throw new Error(`invalid scan-cleanup preview ${label}`);
    return decoded;
}

function decodeNonNegativeFiniteNumber(value: unknown, label: string) {
    const decoded = decodeFiniteNumber(value, label);
    if (decoded < 0) throw new Error(`invalid scan-cleanup preview ${label}`);
    return decoded;
}

function decodePreviewRect(value: unknown, label: string) {
    if (!isRecord(value)) throw new Error(`invalid scan-cleanup preview ${label}`);
    const rect = {
        xPx: decodeFiniteNumber(value.xPx, `${label} x`),
        yPx: decodeFiniteNumber(value.yPx, `${label} y`),
        widthPx: decodeFiniteNumber(value.widthPx, `${label} width`),
        heightPx: decodeFiniteNumber(value.heightPx, `${label} height`),
    };
    if (rect.widthPx < 0 || rect.heightPx < 0) throw new Error(`invalid scan-cleanup preview ${label}`);
    return rect;
}

function decodePreviewAffine(value: unknown) {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || !Array.isArray(value.matrix)
        || value.matrix.length !== 3
        || value.matrix.some(row => !Array.isArray(row)
            || row.length !== 3
            || row.some(item => typeof item !== 'number' || !Number.isFinite(item)))
    ) throw new Error('invalid scan-cleanup preview affine');
    const rows = value.matrix as unknown[];
    return {matrix: rows.map((row, rowIndex) => (row as unknown[]).map((item, columnIndex) => (
        decodeFiniteNumber(item, `affine ${rowIndex}:${columnIndex}`)
    )))};
}

function decodeContentDiagnostics(
    value: unknown,
): NonNullable<IScanCleanupPreviewMetadata['contentDiagnostics']> {
    if (!isRecord(value) || !isRecord(value.sideConfidence) || !isRecord(value.textMask)) {
        throw new Error('invalid scan-cleanup preview content diagnostics');
    }
    const textMask = value.textMask;
    const decodeBlockEvidence = (block: unknown, label: string) => {
        if (
            !isRecord(block)
            || typeof block.headingEvidence !== 'boolean'
            || typeof block.grayscaleEvidence !== 'boolean'
            || (block.textEvidence !== undefined && typeof block.textEvidence !== 'boolean')
        ) {
            throw new Error(`invalid scan-cleanup preview ${label}`);
        }
        return {
            bounds: decodePreviewRect(block.bounds, `${label} bounds`),
            pictureMaskOverlapPixels: decodeNonNegativeInteger(
                block.pictureMaskOverlapPixels,
                `${label} picture-mask overlap`,
            ),
            headingEvidence: block.headingEvidence,
            grayscaleEvidence: block.grayscaleEvidence,
            ...(block.textEvidence === undefined ? {} : {textEvidence: block.textEvidence}),
        };
    };
    const acceptedTrims = value.acceptedTrims === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(value.acceptedTrims)) {
                throw new Error('invalid scan-cleanup preview accepted trims');
            }
            return value.acceptedTrims.map((trim, index) => {
                if (
                    !isRecord(trim)
                    || ![
                        'left',
                        'top',
                        'right',
                        'bottom',
                    ].includes(String(trim.side))
                    || !Array.isArray(trim.removedBlocks)
                ) {
                    throw new Error(`invalid scan-cleanup preview accepted trim ${index}`);
                }
                return {
                    side: trim.side as 'left' | 'top' | 'right' | 'bottom',
                    iteration: decodePositiveInteger(trim.iteration, `accepted trim ${index} iteration`),
                    score: decodeUnitInterval(trim.score, `accepted trim ${index} score`),
                    threshold: decodeUnitInterval(trim.threshold, `accepted trim ${index} threshold`),
                    contentDistanceSum: decodeNonNegativeFiniteNumber(
                        trim.contentDistanceSum,
                        `accepted trim ${index} content distance`,
                    ),
                    garbageDistanceSum: decodeNonNegativeFiniteNumber(
                        trim.garbageDistanceSum,
                        `accepted trim ${index} garbage distance`,
                    ),
                    removedBlocks: trim.removedBlocks.map((block, blockIndex) => (
                        decodeBlockEvidence(block, `accepted trim ${index} block ${blockIndex}`)
                    )),
                };
            });
        })();
    const protectedBlocks = value.protectedBlocks === undefined
        ? undefined
        : (() => {
            if (!Array.isArray(value.protectedBlocks)) {
                throw new Error('invalid scan-cleanup preview protected blocks');
            }
            return value.protectedBlocks.map((block, index) => (
                decodeBlockEvidence(block, `protected block ${index}`)
            ));
        })();
    const shippedBounds = value.shippedBounds === undefined
        ? undefined
        : decodePreviewRect(value.shippedBounds, 'shipped content bounds');
    return {
        sideConfidence: decodeContentSideConfidence(value.sideConfidence),
        textMask: {
            analysisWidthPx: decodePositiveInteger(textMask.analysisWidthPx, 'text-mask analysis width'),
            analysisHeightPx: decodePositiveInteger(textMask.analysisHeightPx, 'text-mask analysis height'),
            inkPixels: decodeNonNegativeInteger(textMask.inkPixels, 'text-mask ink pixels'),
            lineCount: decodeNonNegativeInteger(textMask.lineCount, 'text-mask line count'),
            ...(textMask.bounds === undefined
                ? {}
                : {bounds: decodePreviewRect(textMask.bounds, 'text-mask bounds')}),
        },
        ...(shippedBounds === undefined ? {} : {shippedBounds}),
        ...(acceptedTrims === undefined ? {} : {acceptedTrims}),
        ...(protectedBlocks === undefined ? {} : {protectedBlocks}),
    };
}

function decodeContentSideConfidence(value: unknown) {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup preview content side confidence');
    return {
        left: decodeUnitInterval(value.left, 'content left confidence'),
        top: decodeUnitInterval(value.top, 'content top confidence'),
        right: decodeUnitInterval(value.right, 'content right confidence'),
        bottom: decodeUnitInterval(value.bottom, 'content bottom confidence'),
    };
}

function decodeBinarizationDiagnostics(
    value: unknown,
): NonNullable<IScanCleanupPreviewMetadata['binarizationDiagnostics']> {
    if (
        !isRecord(value)
        || ![
            'auto',
            'otsu',
            'sauvola',
            'wolf',
        ].includes(String(value.route))
    ) throw new Error('invalid scan-cleanup preview binarization diagnostics');
    const decodeRoute = (candidate: unknown, label: string) => {
        if (![
            'auto',
            'otsu',
            'sauvola',
            'wolf',
        ].includes(String(candidate))) {
            throw new Error(`invalid scan-cleanup preview ${label}`);
        }
        return candidate as NonNullable<IScanCleanupPreviewMetadata['binarizationMode']>;
    };
    const spreadPlan = value.spreadPlan === undefined
        ? undefined
        : (() => {
            if (!isRecord(value.spreadPlan)) throw new Error('invalid scan-cleanup preview spread plan');
            const plan = value.spreadPlan;
            const thresholdAnchor = decodeNonNegativeInteger(plan.thresholdAnchor, 'spread threshold anchor');
            if (thresholdAnchor > 255) throw new Error('invalid scan-cleanup preview spread threshold anchor');
            if (typeof plan.documentAnchor !== 'boolean') throw new Error('invalid scan-cleanup preview spread document anchor');
            if (![
                'sharedJoint',
                'perLeafRouteMismatch',
                'perLeafAnchorDrift',
                'perLeafRadiusDrift',
                'perLeafFaintInkDrift',
            ].includes(String(plan.decision))) {
                throw new Error('invalid scan-cleanup preview spread decision');
            }
            return {
                route: decodeRoute(plan.route, 'spread route'),
                thresholdAnchor,
                thresholdRadius: decodePositiveInteger(plan.thresholdRadius, 'spread threshold radius'),
                strokeWidthAnchorPx: decodePositiveFiniteNumber(plan.strokeWidthAnchorPx, 'spread stroke width anchor'),
                xHeightAnchorPx: decodePositiveFiniteNumber(plan.xHeightAnchorPx, 'spread x-height anchor'),
                documentAnchor: plan.documentAnchor,
                jointCandidateRoute: decodeRoute(plan.jointCandidateRoute, 'spread joint candidate route'),
                leftCandidateRoute: decodeRoute(plan.leftCandidateRoute, 'spread left candidate route'),
                rightCandidateRoute: decodeRoute(plan.rightCandidateRoute, 'spread right candidate route'),
                decision: plan.decision as 'sharedJoint' | 'perLeafRouteMismatch' | 'perLeafAnchorDrift' | 'perLeafRadiusDrift' | 'perLeafFaintInkDrift',
            };
        })();
    return {
        route: value.route as NonNullable<IScanCleanupPreviewMetadata['binarizationMode']>,
        robustContrast: decodeFiniteNumber(value.robustContrast, 'binarization robust contrast'),
        illuminationDeviation: decodeFiniteNumber(value.illuminationDeviation, 'binarization illumination deviation'),
        edgeDensity: decodeFiniteNumber(value.edgeDensity, 'binarization edge density'),
        estimatedStrokeWidthPx: decodeFiniteNumber(value.estimatedStrokeWidthPx, 'binarization stroke width'),
        darkBorderCoverage: decodeFiniteNumber(value.darkBorderCoverage, 'binarization border coverage'),
        otsuAdaptiveAgreement: decodeFiniteNumber(value.otsuAdaptiveAgreement, 'binarization agreement'),
        ...(spreadPlan === undefined ? {} : {spreadPlan}),
    };
}

function decodeTextToneDiagnostics(
    value: unknown,
): NonNullable<IScanCleanupPreviewMetadata['textToneDiagnostics']> {
    if (
        !isRecord(value)
        || typeof value.applied !== 'boolean'
        || ![
            'applied',
            'picture-evidence',
            'insufficient-text',
            'tonal-mass-outside-text',
            'already-dark',
        ].includes(String(value.rule))
    ) throw new Error('invalid scan-cleanup preview text-tone diagnostics');
    const inkAnchor = value.inkAnchor === null
        ? null
        : decodeNonNegativeInteger(value.inkAnchor, 'text-tone ink anchor');
    if (inkAnchor !== null && inkAnchor > 255) {
        throw new Error('invalid scan-cleanup preview text-tone ink anchor');
    }
    const blackPoint = value.blackPoint === null
        ? null
        : decodeNonNegativeFiniteNumber(value.blackPoint, 'text-tone black point');
    const slope = value.slope === null
        ? null
        : decodePositiveFiniteNumber(value.slope, 'text-tone slope');
    if (
        value.applied !== (value.rule === 'applied')
        || value.applied !== (blackPoint !== null && slope !== null)
    ) throw new Error('inconsistent scan-cleanup preview text-tone diagnostics');
    return {
        applied: value.applied,
        rule: value.rule as NonNullable<IScanCleanupPreviewMetadata['textToneDiagnostics']>['rule'],
        textLineCount: decodeNonNegativeInteger(value.textLineCount, 'text-tone line count'),
        textInkPixels: decodeNonNegativeInteger(value.textInkPixels, 'text-tone ink pixels'),
        pictureFraction: decodeUnitInterval(value.pictureFraction, 'text-tone picture fraction'),
        outsideMidtoneFraction: decodeUnitInterval(
            value.outsideMidtoneFraction,
            'text-tone outside midtone fraction',
        ),
        outsideMidtoneLargestComponentFraction: decodeUnitInterval(
            value.outsideMidtoneLargestComponentFraction,
            'text-tone outside midtone largest component fraction',
        ),
        outsideMidtoneLargestComponentWidthFraction: decodeUnitInterval(
            value.outsideMidtoneLargestComponentWidthFraction,
            'text-tone outside midtone largest component width fraction',
        ),
        outsideMidtoneLargestComponentHeightFraction: decodeUnitInterval(
            value.outsideMidtoneLargestComponentHeightFraction,
            'text-tone outside midtone largest component height fraction',
        ),
        inkAnchor,
        blackPoint,
        slope,
    };
}

function decodeSplitSeam(value: unknown) {
    if (!isRecord(value) || !Array.isArray(value.points) || value.points.length < 2) {
        throw new Error('invalid scan-cleanup preview split seam');
    }
    return {points: value.points.map((point, index) => {
        if (!isRecord(point)) throw new Error(`invalid scan-cleanup preview split seam point ${index}`);
        return {
            x: decodeFiniteNumber(point.x, `split seam point ${index} x`),
            y: decodeFiniteNumber(point.y, `split seam point ${index} y`),
        };
    })};
}

function decodePreviewMetadata(value: unknown): IScanCleanupPreviewMetadata {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup preview metadata');
    if (
        ![
            'full',
            'left',
            'right',
        ].includes(String(value.half))
        || ![
            'single-uncut-page',
            'page-with-offcut',
            'two-page-spread',
        ].includes(String(value.layoutClassification))
        || !isRecord(value.appliedMargins)
        || !Array.isArray(value.warnings)
        || value.warnings.some(item => typeof item !== 'string')
        || ![
            0,
            90,
            180,
            270,
        ].includes(Number(value.rotationDegrees))
        || (value.canvasPolicy !== undefined && ![
            'intrinsic',
            'strict-maximum',
        ].includes(String(value.canvasPolicy)))
        || (value.canvasOverflow !== undefined && typeof value.canvasOverflow !== 'boolean')
        || (value.matchedCanvasOpticalPlacement !== undefined && typeof value.matchedCanvasOpticalPlacement !== 'boolean')
        || (value.intrinsicRasterWidthPx !== undefined && (!Number.isSafeInteger(value.intrinsicRasterWidthPx) || Number(value.intrinsicRasterWidthPx) < 1))
        || (value.intrinsicRasterHeightPx !== undefined && (!Number.isSafeInteger(value.intrinsicRasterHeightPx) || Number(value.intrinsicRasterHeightPx) < 1))
        || (value.matchedCanvasOpticalContentLeftPx !== undefined && value.matchedCanvasOpticalContentLeftPx !== null && (!Number.isFinite(Number(value.matchedCanvasOpticalContentLeftPx)) || Number(value.matchedCanvasOpticalContentLeftPx) < 0))
        || (value.matchedCanvasOpticalContentRightPx !== undefined && value.matchedCanvasOpticalContentRightPx !== null && (!Number.isFinite(Number(value.matchedCanvasOpticalContentRightPx)) || Number(value.matchedCanvasOpticalContentRightPx) < 0))
        || (value.matchedCanvasIntrinsicOverflowLeftPx !== undefined && (!Number.isSafeInteger(value.matchedCanvasIntrinsicOverflowLeftPx) || Number(value.matchedCanvasIntrinsicOverflowLeftPx) < 0))
        || (value.matchedCanvasIntrinsicOverflowRightPx !== undefined && (!Number.isSafeInteger(value.matchedCanvasIntrinsicOverflowRightPx) || Number(value.matchedCanvasIntrinsicOverflowRightPx) < 0))
        || (value.matchedCanvasIntrinsicOverflowTopPx !== undefined && (!Number.isSafeInteger(value.matchedCanvasIntrinsicOverflowTopPx) || Number(value.matchedCanvasIntrinsicOverflowTopPx) < 0))
        || (value.foldClipLeftPx !== undefined && (!Number.isSafeInteger(value.foldClipLeftPx) || Number(value.foldClipLeftPx) < 0))
        || (value.foldClipRightPx !== undefined && (!Number.isSafeInteger(value.foldClipRightPx) || Number(value.foldClipRightPx) < 0))
        || (value.illuminationNormalized !== undefined && typeof value.illuminationNormalized !== 'boolean')
        || (value.outputMode !== undefined && !isScanCleanupOutputMode(value.outputMode))
        || (value.despeckleFallback !== undefined && typeof value.despeckleFallback !== 'boolean')
        || (value.skewApplied !== undefined && typeof value.skewApplied !== 'boolean')
        || (value.manualSkew !== undefined && typeof value.manualSkew !== 'boolean')
        || (value.splitAbstained !== undefined && typeof value.splitAbstained !== 'boolean')
        || (value.dewarpApplied !== undefined && typeof value.dewarpApplied !== 'boolean')
        || (value.binarizationMode !== undefined
            && value.binarizationMode !== null
            && ![
                'auto',
                'otsu',
                'sauvola',
                'wolf',
            ].includes(String(value.binarizationMode)))
        || (value.rasterScaleLimited !== undefined && typeof value.rasterScaleLimited !== 'boolean')
    ) throw new Error('invalid scan-cleanup preview metadata');
    const metadata: IScanCleanupPreviewMetadata = {
        half: value.half as IScanCleanupPreviewMetadata['half'],
        layoutClassification: value.layoutClassification as IScanCleanupPreviewMetadata['layoutClassification'],
        layoutConfidence: value.layoutConfidence === undefined
            ? 0
            : decodeUnitInterval(value.layoutConfidence, 'layout confidence'),
        ...(value.detectedSkewDegrees === undefined
            ? {}
            : {detectedSkewDegrees: decodeFiniteNumber(value.detectedSkewDegrees, 'detected skew')}),
        ...(value.skewConfidence === undefined
            ? {}
            : {skewConfidence: decodeNonNegativeFiniteNumber(value.skewConfidence, 'skew confidence')}),
        ...(value.skewApplied === undefined ? {} : {skewApplied: value.skewApplied}),
        ...(value.manualSkew === undefined ? {} : {manualSkew: value.manualSkew}),
        sourceRegion: decodePreviewRect(value.sourceRegion, 'source region'),
        contentBox: value.contentBox === null ? null : decodePreviewRect(value.contentBox, 'content box'),
        cropRect: value.cropRect === undefined
            ? {
                xPx: 0,
                yPx: 0,
                widthPx: decodePositiveInteger(value.outputWidthPx, 'output width'),
                heightPx: decodePositiveInteger(value.outputHeightPx, 'output height'),
            }
            : decodePreviewRect(value.cropRect, 'crop rect'),
        ...(value.contentDiagnostics === undefined
            ? {}
            : {contentDiagnostics: decodeContentDiagnostics(value.contentDiagnostics)}),
        appliedMargins: {
            leftPx: decodeNonNegativeFiniteNumber(value.appliedMargins.leftPx, 'applied left margin'),
            topPx: decodeNonNegativeFiniteNumber(value.appliedMargins.topPx, 'applied top margin'),
            rightPx: decodeNonNegativeFiniteNumber(value.appliedMargins.rightPx, 'applied right margin'),
            bottomPx: decodeNonNegativeFiniteNumber(value.appliedMargins.bottomPx, 'applied bottom margin'),
        },
        outputWidthPx: decodePositiveInteger(value.outputWidthPx, 'output width'),
        outputHeightPx: decodePositiveInteger(value.outputHeightPx, 'output height'),
        ...(value.intrinsicRasterWidthPx === undefined
            ? {}
            : {intrinsicRasterWidthPx: decodePositiveInteger(value.intrinsicRasterWidthPx, 'intrinsic raster width')}),
        ...(value.intrinsicRasterHeightPx === undefined
            ? {}
            : {intrinsicRasterHeightPx: decodePositiveInteger(value.intrinsicRasterHeightPx, 'intrinsic raster height')}),
        ...(value.renderRegion === undefined
            ? {}
            : {renderRegion: decodePreviewRect(value.renderRegion, 'render region')}),
        canvasWidthPx: decodePositiveInteger(value.canvasWidthPx, 'canvas width'),
        canvasHeightPx: decodePositiveInteger(value.canvasHeightPx, 'canvas height'),
        canvasPolicy: (value.canvasPolicy ?? 'intrinsic') as NonNullable<
            IScanCleanupPreviewMetadata['canvasPolicy']
        >,
        canvasOverflow: value.canvasOverflow === true,
        matchedCanvasTargetWidthPx: value.matchedCanvasTargetWidthPx === null
            || value.matchedCanvasTargetWidthPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasTargetWidthPx, 'matched canvas target width'),
        matchedCanvasTargetHeightPx: value.matchedCanvasTargetHeightPx === null
            || value.matchedCanvasTargetHeightPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasTargetHeightPx, 'matched canvas target height'),
        matchedCanvasTargetWidthPoints: value.matchedCanvasTargetWidthPoints === null
            || value.matchedCanvasTargetWidthPoints === undefined
            ? null
            : decodePositiveFiniteNumber(value.matchedCanvasTargetWidthPoints, 'matched canvas target width points'),
        matchedCanvasTargetHeightPoints: value.matchedCanvasTargetHeightPoints === null
            || value.matchedCanvasTargetHeightPoints === undefined
            ? null
            : decodePositiveFiniteNumber(value.matchedCanvasTargetHeightPoints, 'matched canvas target height points'),
        matchedCanvasContentWidthPx: value.matchedCanvasContentWidthPx === null
            || value.matchedCanvasContentWidthPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasContentWidthPx, 'matched canvas content width'),
        matchedCanvasContentHeightPx: value.matchedCanvasContentHeightPx === null
            || value.matchedCanvasContentHeightPx === undefined
            ? null
            : decodePositiveInteger(value.matchedCanvasContentHeightPx, 'matched canvas content height'),
        ...(value.matchedCanvasOpticalPlacement === undefined
            ? {}
            : {matchedCanvasOpticalPlacement: value.matchedCanvasOpticalPlacement}),
        matchedCanvasOpticalContentLeftPx: value.matchedCanvasOpticalContentLeftPx === null
            || value.matchedCanvasOpticalContentLeftPx === undefined
            ? null
            : decodeNonNegativeFiniteNumber(value.matchedCanvasOpticalContentLeftPx, 'optical content left'),
        matchedCanvasOpticalContentRightPx: value.matchedCanvasOpticalContentRightPx === null
            || value.matchedCanvasOpticalContentRightPx === undefined
            ? null
            : decodeNonNegativeFiniteNumber(value.matchedCanvasOpticalContentRightPx, 'optical content right'),
        ...(value.matchedCanvasIntrinsicOverflowLeftPx === undefined
            ? {}
            : {matchedCanvasIntrinsicOverflowLeftPx: decodeNonNegativeInteger(value.matchedCanvasIntrinsicOverflowLeftPx, 'intrinsic overflow left')}),
        ...(value.matchedCanvasIntrinsicOverflowRightPx === undefined
            ? {}
            : {matchedCanvasIntrinsicOverflowRightPx: decodeNonNegativeInteger(value.matchedCanvasIntrinsicOverflowRightPx, 'intrinsic overflow right')}),
        ...(value.matchedCanvasIntrinsicOverflowTopPx === undefined
            ? {}
            : {matchedCanvasIntrinsicOverflowTopPx: decodeNonNegativeInteger(value.matchedCanvasIntrinsicOverflowTopPx, 'intrinsic overflow top')}),
        ...(value.foldClipLeftPx === undefined
            ? {}
            : {foldClipLeftPx: decodeNonNegativeInteger(value.foldClipLeftPx, 'fold clip left')}),
        ...(value.foldClipRightPx === undefined
            ? {}
            : {foldClipRightPx: decodeNonNegativeInteger(value.foldClipRightPx, 'fold clip right')}),
        placementOffsetXPx: decodeNonNegativeInteger(value.placementOffsetXPx, 'placement offset x'),
        placementOffsetYPx: decodeNonNegativeInteger(value.placementOffsetYPx, 'placement offset y'),
        forwardTransform: decodePreviewAffine(value.forwardTransform),
        cutterXPx: value.cutterXPx === null ? null : decodeFiniteNumber(value.cutterXPx, 'cutter x'),
        ...(value.splitSeam === undefined ? {} : {splitSeam: decodeSplitSeam(value.splitSeam)}),
        ...(value.splitAbstained === undefined ? {} : {splitAbstained: value.splitAbstained}),
        inputWidthPx: decodePositiveInteger(value.inputWidthPx, 'input width'),
        inputHeightPx: decodePositiveInteger(value.inputHeightPx, 'input height'),
        rotationDegrees: value.rotationDegrees as IScanCleanupPreviewMetadata['rotationDegrees'],
        canvasScope: value.canvasScope === 'document' ? 'document' : value.canvasScope === 'page'
            ? 'page'
            : (() => { throw new Error('invalid scan-cleanup preview canvas scope'); })(),
        resamplePasses: decodeNonNegativeInteger(value.resamplePasses, 'resample passes'),
        ...(value.illuminationNormalized === undefined
            ? {}
            : {illuminationNormalized: value.illuminationNormalized}),
        ...(value.textToneDiagnostics === undefined
            ? {}
            : {textToneDiagnostics: decodeTextToneDiagnostics(value.textToneDiagnostics)}),
        ...(value.outputMode === undefined
            ? {}
            : {outputMode: value.outputMode}),
        ...(value.binarizationMode === undefined
            ? {}
            : {binarizationMode: value.binarizationMode as NonNullable<
                IScanCleanupPreviewMetadata['binarizationMode']
            > | null}),
        ...(value.binarizationDiagnostics === undefined
            ? {}
            : {binarizationDiagnostics: value.binarizationDiagnostics === null
                ? null
                : decodeBinarizationDiagnostics(value.binarizationDiagnostics)}),
        ...(value.despeckleFallback === undefined
            ? {}
            : {despeckleFallback: value.despeckleFallback}),
        ...(value.dewarpConfidence === undefined
            ? {}
            : {dewarpConfidence: value.dewarpConfidence === null
                ? null
                : decodeUnitInterval(value.dewarpConfidence, 'dewarp confidence')}),
        ...(value.dewarpApplied === undefined ? {} : {dewarpApplied: value.dewarpApplied}),
        ...(value.sourceDpi === undefined
            ? {}
            : {sourceDpi: decodePositiveFiniteNumber(value.sourceDpi, 'source dpi')}),
        ...(value.renderDpi === undefined
            ? {}
            : {renderDpi: decodePositiveFiniteNumber(value.renderDpi, 'render dpi')}),
        ...(value.requestedRenderDpi === undefined
            ? {}
            : {requestedRenderDpi: decodePositiveFiniteNumber(value.requestedRenderDpi, 'requested render dpi')}),
        rasterScaleLimited: value.rasterScaleLimited === true,
        warnings: value.warnings as string[],
    };
    // What is placed on the canvas is the *content* box: the size the intrinsic
    // raster takes once the page has been normalized to the document's scale. A
    // matched preview keeps the raster it rendered — the renderer scales it —
    // so its intrinsic dimensions are the page's own pixels and say nothing
    // about whether it fits the canvas. A page nothing normalized carries no
    // content box, and there the two are the same thing.
    const contentWidthPx = metadata.matchedCanvasContentWidthPx ?? metadata.outputWidthPx;
    const contentHeightPx = metadata.matchedCanvasContentHeightPx ?? metadata.outputHeightPx;
    const intrinsicWidthPx = metadata.intrinsicRasterWidthPx ?? metadata.outputWidthPx;
    const opticalScaleX = contentWidthPx / intrinsicWidthPx;
    const opticalLeft = metadata.matchedCanvasOpticalContentLeftPx;
    const opticalRight = metadata.matchedCanvasOpticalContentRightPx;
    const recordedIntrinsicOverflowLeft = metadata.matchedCanvasIntrinsicOverflowLeftPx ?? 0;
    const recordedIntrinsicOverflowRight = metadata.matchedCanvasIntrinsicOverflowRightPx ?? 0;
    const recordedIntrinsicOverflowTop = metadata.matchedCanvasIntrinsicOverflowTopPx ?? 0;
    const foldClipLeft = metadata.foldClipLeftPx ?? 0;
    const foldClipRight = metadata.foldClipRightPx ?? 0;
    const effectivePlacementOffsetX = metadata.placementOffsetXPx - recordedIntrinsicOverflowLeft;
    const effectivePlacementOffsetY = metadata.placementOffsetYPx - recordedIntrinsicOverflowTop;
    const actualIntrinsicOverflowLeft = Math.max(0, -effectivePlacementOffsetX);
    const actualIntrinsicOverflowRight = Math.max(
        0,
        effectivePlacementOffsetX + contentWidthPx - metadata.canvasWidthPx,
    );
    const actualIntrinsicOverflowTop = Math.max(0, -effectivePlacementOffsetY);
    if (
        metadata.canvasHeightPx < contentHeightPx
        || recordedIntrinsicOverflowLeft > contentWidthPx
        || foldClipLeft + foldClipRight >= contentWidthPx
        || recordedIntrinsicOverflowTop > contentHeightPx
        || actualIntrinsicOverflowLeft !== recordedIntrinsicOverflowLeft
        || actualIntrinsicOverflowRight !== recordedIntrinsicOverflowRight
        || actualIntrinsicOverflowTop !== recordedIntrinsicOverflowTop
        || effectivePlacementOffsetX >= metadata.canvasWidthPx
        || effectivePlacementOffsetX + contentWidthPx <= 0
        || effectivePlacementOffsetY >= metadata.canvasHeightPx
        || effectivePlacementOffsetY + contentHeightPx <= 0
        || (metadata.matchedCanvasOpticalPlacement === true && (
            opticalLeft === null
            || opticalLeft === undefined
            || opticalRight === null
            || opticalRight === undefined
            || opticalLeft >= opticalRight
            || effectivePlacementOffsetX + opticalLeft * opticalScaleX < metadata.appliedMargins.leftPx
            || effectivePlacementOffsetX + opticalRight * opticalScaleX > metadata.canvasWidthPx - metadata.appliedMargins.rightPx
        ))
        || effectivePlacementOffsetY + contentHeightPx > metadata.canvasHeightPx
    ) {
        throw new Error('invalid scan-cleanup preview intrinsic/canvas placement');
    }
    if (
        metadata.renderRegion
        && (
            metadata.renderRegion.xPx < 0
            || metadata.renderRegion.yPx < 0
            || metadata.renderRegion.widthPx <= 0
            || metadata.renderRegion.heightPx <= 0
            || metadata.renderRegion.xPx + metadata.renderRegion.widthPx > metadata.outputWidthPx
            || metadata.renderRegion.yPx + metadata.renderRegion.heightPx > metadata.outputHeightPx
        )
    ) {
        throw new Error(
            `invalid scan-cleanup preview render region ${JSON.stringify({
                outputHeightPx: metadata.outputHeightPx,
                outputWidthPx: metadata.outputWidthPx,
                renderRegion: metadata.renderRegion,
            })}`,
        );
    }
    return metadata;
}

function decodeUnitInterval(value: unknown, label: string) {
    const decoded = decodeFiniteNumber(value, label);
    if (decoded < 0 || decoded > 1) throw new Error(`invalid scan-cleanup preview ${label}`);
    return decoded;
}

export function decodeScanCleanupPreviewResult(value: unknown): TScanCleanupPreviewWireResult {
    if (isRecord(value) && value.canceled === true) {
        return {canceled: true};
    }
    if (
        !isRecord(value)
        || (value.requestId !== undefined
            && (typeof value.requestId !== 'string' || value.requestId.trim().length === 0))
        || !Array.isArray(value.outputs)
        || value.outputs.length > 2
    ) throw new Error('invalid scan-cleanup preview result');
    // Absent exactly when the request streamed the raster ahead of this result.
    const rawImageData = value.rawImageData === undefined
        ? undefined
        : decodePreviewBytes(value.rawImageData, 'raw image');
    let totalBytes = rawImageData?.byteLength ?? 0;
    const outputs = value.outputs.map(output => {
        if (!isRecord(output) || !isRecord(output.metadata)) throw new Error('invalid scan-cleanup preview output');
        const imageData = decodePreviewBytes(output.imageData, 'output image');
        totalBytes += imageData.byteLength;
        return {
            imageData,
            metadata: decodePreviewMetadata(output.metadata),
        };
    });
    if (totalBytes > PREVIEW_MAX_TOTAL_BYTES) throw new Error('invalid scan-cleanup preview total image bytes');
    const pageNumber = decodePositiveInteger(value.pageNumber, 'page number');
    const totalPages = decodePositiveInteger(value.totalPages, 'total pages');
    if (pageNumber > totalPages) throw new Error('invalid scan-cleanup preview page number');
    return {
        ...(value.requestId === undefined ? {} : {requestId: value.requestId}),
        pageNumber,
        totalPages,
        ...(rawImageData === undefined ? {} : {rawImageData}),
        rawWidthPx: decodePositiveInteger(value.rawWidthPx, 'raw width'),
        rawHeightPx: decodePositiveInteger(value.rawHeightPx, 'raw height'),
        pageMetadata: decodePreviewPageMetadata(value.pageMetadata),
        outputs,
    };
}

export function decodeScanCleanupRawPreviewEvent(value: unknown): IScanCleanupRawPreviewEvent {
    if (
        !isRecord(value)
        || typeof value.ownerId !== 'string'
        || value.ownerId.trim().length === 0
        || typeof value.documentRevision !== 'string'
        || value.documentRevision.trim().length === 0
        || typeof value.requestId !== 'string'
        || value.requestId.trim().length === 0
    ) throw new Error('invalid scan-cleanup raw preview result');
    const pageNumber = decodePositiveInteger(value.pageNumber, 'raw page number');
    const totalPages = decodePositiveInteger(value.totalPages, 'raw total pages');
    if (pageNumber > totalPages) throw new Error('invalid scan-cleanup raw preview page number');
    return {
        ownerId: value.ownerId,
        documentRevision: value.documentRevision,
        requestId: value.requestId,
        pageNumber,
        totalPages,
        rawImageData: decodePreviewBytes(value.rawImageData, 'raw image'),
        rawWidthPx: decodePositiveInteger(value.rawWidthPx, 'raw width'),
        rawHeightPx: decodePositiveInteger(value.rawHeightPx, 'raw height'),
    };
}

function decodePreviewPageMetadata(value: unknown): IScanCleanupPreviewResult['pageMetadata'] {
    if (
        !isRecord(value)
        || ![
            'single-uncut-page',
            'page-with-offcut',
            'two-page-spread',
        ].includes(String(value.layoutClassification))
        || !(value.cutterXPx === null || typeof value.cutterXPx === 'number' && Number.isFinite(value.cutterXPx))
        || ![
            0,
            90,
            180,
            270,
        ].includes(Number(value.rotationDegrees))
        || typeof value.excluded !== 'boolean'
        || (value.layoutConfidence !== undefined && (
            typeof value.layoutConfidence !== 'number'
            || !Number.isFinite(value.layoutConfidence)
            || value.layoutConfidence < 0
            || value.layoutConfidence > 1
        ))
        || (value.tier1Verdict !== undefined && !isLayoutClassification(value.tier1Verdict))
        || (value.reconciled !== undefined && typeof value.reconciled !== 'boolean')
        || (value.clusterAgreement !== undefined && (
            typeof value.clusterAgreement !== 'number'
            || !Number.isFinite(value.clusterAgreement)
            || value.clusterAgreement < -1
            || value.clusterAgreement > 1
        ))
        || (value.splitAbstained !== undefined && typeof value.splitAbstained !== 'boolean')
        || (value.despeckleFallback !== undefined && typeof value.despeckleFallback !== 'boolean')
        || (value.autoDewarpAttempted !== undefined && typeof value.autoDewarpAttempted !== 'boolean')
        || (value.manualSkew !== undefined && typeof value.manualSkew !== 'boolean')
        || (value.dewarpApplied !== undefined && typeof value.dewarpApplied !== 'boolean')
        || (value.binarizationMode !== undefined
            && value.binarizationMode !== null
            && ![
                'auto',
                'otsu',
                'sauvola',
                'wolf',
            ].includes(String(value.binarizationMode)))
        || (value.recommendedOutputMode !== undefined
            && !isScanCleanupOutputMode(value.recommendedOutputMode))
        || (value.recommendedOutputModeConfidence !== undefined && (
            typeof value.recommendedOutputModeConfidence !== 'number'
            || !Number.isFinite(value.recommendedOutputModeConfidence)
            || value.recommendedOutputModeConfidence < 0
            || value.recommendedOutputModeConfidence > 1
        ))
        || (value.recommendedOutputModeReason !== undefined
            && !isScanCleanupOutputModeRecommendationReason(value.recommendedOutputModeReason))
        || (value.softAlphaForegroundRecommendation !== undefined
            && typeof value.softAlphaForegroundRecommendation !== 'boolean')
        || (value.outputDiagnostics !== undefined && (
            !Array.isArray(value.outputDiagnostics)
            || value.outputDiagnostics.length > 2
            || value.outputDiagnostics.some(output => (
                !isRecord(output)
                || ![
                    'full',
                    'left',
                    'right',
                ].includes(String(output.half))
            ))
        ))
    ) throw new Error('invalid scan-cleanup preview page metadata');
    return {
        layoutClassification: value.layoutClassification as IScanCleanupPreviewResult['pageMetadata']['layoutClassification'],
        ...(value.layoutConfidence === undefined
            ? {}
            : {layoutConfidence: decodeUnitInterval(value.layoutConfidence, 'page layout confidence')}),
        cutterXPx: value.cutterXPx,
        ...(value.splitSeam === undefined ? {} : {splitSeam: decodeSplitSeam(value.splitSeam)}),
        ...(value.splitAbstained === undefined ? {} : {splitAbstained: value.splitAbstained}),
        rotationDegrees: value.rotationDegrees as IScanCleanupPreviewResult['pageMetadata']['rotationDegrees'],
        canvasScope: value.canvasScope === 'document' ? 'document' : value.canvasScope === 'page'
            ? 'page'
            : (() => { throw new Error('invalid scan-cleanup preview canvas scope'); })(),
        excluded: value.excluded,
        blankOutputsSkipped: decodeNonNegativeInteger(value.blankOutputsSkipped, 'blank outputs skipped'),
        tier1Verdict: isLayoutClassification(value.tier1Verdict)
            ? value.tier1Verdict
            : value.layoutClassification as IScanCleanupPreviewResult['pageMetadata']['tier1Verdict'],
        reconciled: value.reconciled === true,
        clusterAgreement: value.clusterAgreement === undefined
            ? 0
            : (() => {
                const agreement = decodeFiniteNumber(value.clusterAgreement, 'cluster agreement');
                if (agreement < -1 || agreement > 1) throw new Error('invalid scan-cleanup cluster agreement');
                return agreement;
            })(),
        ...(value.detectedSkewDegrees === undefined
            ? {}
            : {detectedSkewDegrees: decodeFiniteNumber(value.detectedSkewDegrees, 'page detected skew')}),
        ...(value.skewConfidence === undefined
            ? {}
            : {skewConfidence: decodeNonNegativeFiniteNumber(value.skewConfidence, 'page skew confidence')}),
        ...(value.manualSkew === undefined ? {} : {manualSkew: value.manualSkew}),
        ...(value.binarizationMode === undefined
            ? {}
            : {binarizationMode: value.binarizationMode as NonNullable<
                IScanCleanupPreviewResult['pageMetadata']['binarizationMode']
            > | null}),
        ...(value.binarizationDiagnostics === undefined
            ? {}
            : {binarizationDiagnostics: value.binarizationDiagnostics === null
                ? null
                : decodeBinarizationDiagnostics(value.binarizationDiagnostics)}),
        ...(value.textToneDiagnostics === undefined
            ? {}
            : {textToneDiagnostics: decodeTextToneDiagnostics(value.textToneDiagnostics)}),
        ...(value.despeckleFallback === undefined
            ? {}
            : {despeckleFallback: value.despeckleFallback}),
        ...(value.autoDewarpAttempted === undefined
            ? {}
            : {autoDewarpAttempted: value.autoDewarpAttempted}),
        ...(value.dewarpApplied === undefined
            ? {}
            : {dewarpApplied: value.dewarpApplied}),
        ...(value.dewarpConfidence === undefined
            ? {}
            : {dewarpConfidence: value.dewarpConfidence === null
                ? null
                : decodeUnitInterval(value.dewarpConfidence, 'page dewarp confidence')}),
        ...(value.outputDiagnostics === undefined
            ? {}
            : {outputDiagnostics: value.outputDiagnostics.map((output: unknown) => {
                if (!isRecord(output)) throw new Error('invalid scan-cleanup preview output diagnostics');
                return {
                    half: output.half as NonNullable<
                        IScanCleanupPreviewResult['pageMetadata']['outputDiagnostics']
                    >[number]['half'],
                    ...(output.contentDiagnostics === undefined
                        ? {}
                        : {contentDiagnostics: decodeContentDiagnostics(output.contentDiagnostics)}),
                    ...(output.textToneDiagnostics === undefined
                        ? {}
                        : {textToneDiagnostics: decodeTextToneDiagnostics(
                            output.textToneDiagnostics,
                        )}),
                };
            })}),
        ...(isScanCleanupOutputMode(value.recommendedOutputMode)
            ? {recommendedOutputMode: value.recommendedOutputMode}
            : {}),
        ...(typeof value.recommendedOutputModeConfidence === 'number'
            ? {recommendedOutputModeConfidence: value.recommendedOutputModeConfidence}
            : {}),
        ...(isScanCleanupOutputModeRecommendationReason(value.recommendedOutputModeReason)
            ? {recommendedOutputModeReason: value.recommendedOutputModeReason}
            : {}),
        ...(typeof value.softAlphaForegroundRecommendation === 'boolean'
            ? {softAlphaForegroundRecommendation: value.softAlphaForegroundRecommendation}
            : {}),
    };
}

export function decodeStartResult(value: unknown) {
    if (!isRecord(value) || typeof value.started !== 'boolean' || typeof value.jobId !== 'string') throw new Error('invalid scan-cleanup start result');
    if (value.started) {
        if (typeof value.outputPdfPath !== 'string') throw new Error('successful scan-cleanup start requires outputPdfPath');
        return {
            started: true as const,
            jobId: value.jobId,
            outputPdfPath: value.outputPdfPath,
        };
    }
    if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
        throw new Error('failed scan-cleanup start requires a typed error');
    }
    return {
        started: false as const,
        jobId: value.jobId,
        error: value.error,
        errorCode: value.errorCode,
    };
}

export function decodeDetectionStartResult(value: unknown) {
    if (!isRecord(value) || typeof value.started !== 'boolean' || typeof value.jobId !== 'string') {
        throw new Error('invalid scan-cleanup detection start result');
    }
    if (value.started) {
        return {
            started: true as const,
            jobId: value.jobId,
        };
    }
    if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
        throw new Error('failed scan-cleanup detection start requires a typed error');
    }
    return {
        started: false as const,
        jobId: value.jobId,
        error: value.error,
        errorCode: value.errorCode,
    };
}

function isScanCleanupErrorCode(value: unknown): value is TScanCleanupErrorCode {
    return SCAN_CLEANUP_ERROR_CODES.includes(value as TScanCleanupErrorCode);
}

function decodeNonNegativeInteger(value: unknown, fieldName: string) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`invalid scan-cleanup ${fieldName}`);
    }
    return value;
}

export function decodeScanCleanupJobState(value: unknown): TScanCleanupJobState | null {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || typeof value.jobId !== 'string'
        || typeof value.updatedAtMs !== 'number'
        || !Number.isFinite(value.updatedAtMs)
    ) {
        throw new Error('invalid scan-cleanup job state');
    }
    const base = {
        jobId: value.jobId,
        progress: SCAN_CLEANUP_PROGRESS_SCHEMA.decode(value.progress),
        updatedAtMs: value.updatedAtMs,
    };
    if (value.status === 'queued' || value.status === 'running' || value.status === 'canceling' || value.status === 'handoff' || value.status === 'canceled') {
        return {
            ...base,
            status: value.status,
        };
    }
    if (value.status === 'completed') {
        if (typeof value.outputPdfPath !== 'string' || typeof value.partial !== 'boolean') {
            throw new Error('completed scan-cleanup state requires outputPdfPath and partial flag');
        }
        return {
            ...base,
            status: 'completed',
            outputPdfPath: value.outputPdfPath,
            summary: SCAN_CLEANUP_SUMMARY_SCHEMA.decode(value.summary),
            partial: value.partial,
        };
    }
    if (value.status === 'failed') {
        if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
            throw new Error('failed scan-cleanup state requires a typed error');
        }
        return {
            ...base,
            status: 'failed',
            error: value.error,
            errorCode: value.errorCode,
        };
    }
    throw new Error('invalid scan-cleanup job status');
}

function decodeSplitDiagnostics(
    value: unknown,
): NonNullable<TScanCleanupDetectionJobState['results'][number]['splitDiagnostics']> {
    if (!isRecord(value)) throw new Error('invalid scan-cleanup split diagnostics');
    const candidate = value.foldBand === undefined
        ? {
            ...value,
            foldBand: legacyNativeScanCleanupFoldBandV3(),
        }
        : value;
    const integerKeys = [
        'leftInkPixels',
        'rightInkPixels',
        'independentSpreadCues',
    ] as const;
    const numberKeys = [
        'analysisDpi',
        'deskewAngleDegrees',
        'deskewConfidence',
        'cutterSlope',
        'leftDeskewAngleDegrees',
        'rightDeskewAngleDegrees',
        'leftDeskewConfidence',
        'rightDeskewConfidence',
        'whitespaceX',
        'foldX',
        'decisionX',
        'whitespaceScore',
        'bilateralScore',
        'leftPageScore',
        'rightPageScore',
        'leftContentScore',
        'rightContentScore',
        'leftSurfaceScore',
        'rightSurfaceScore',
        'outerMarginScore',
        'gutterScore',
        'agreementScore',
        'foldScore',
        'gutterDarknessScore',
        'softGutterScore',
        'softGutterCoverage',
        'softGutterContinuity',
        'softGutterMeanDepression',
        'sparseGutterScore',
        'sparseGutterCoverage',
        'sparseGutterContinuity',
        'sparseGutterMeanDepression',
        'aspectRatio',
        'aspectSpreadScore',
        'aspectSingleScore',
        'offcutBoundaryScore',
        'offcutEmptyScore',
        'offcutPopulatedScore',
        'offcutWidthScore',
        'offcutNoTextRowsScore',
        'alternativeProduct',
        'evidenceProduct',
    ] as const;
    const booleanKeys = [
        'whitespaceGatePassed',
        'centralPositionGatePassed',
        'bilateralGatePassed',
        'outerMarginGatePassed',
        'gutterGatePassed',
        'independentGutterGatePassed',
        'aspectSupportGatePassed',
        'evidenceAgreementGatePassed',
        'sparseSpreadRecovered',
        'abstained',
    ] as const;
    const allowed = new Set<string>([
        ...integerKeys,
        ...numberKeys,
        ...booleanKeys,
        'foldBand',
    ]);
    type TSplitDiagnostics = NonNullable<
        TScanCleanupDetectionJobState['results'][number]['splitDiagnostics']
    >;
    const isValid = (
        subject: Record<string, unknown>,
    ): subject is Record<string, unknown> & TSplitDiagnostics =>
        !Object.keys(subject).some(key => !allowed.has(key))
        && integerKeys.every(key => (
            typeof subject[key] === 'number'
            && Number.isSafeInteger(subject[key])
            && subject[key] >= 0
        ))
        && numberKeys.every(key => (
            typeof subject[key] === 'number'
            && Number.isFinite(subject[key])
        ))
        && booleanKeys.every(key => typeof subject[key] === 'boolean')
        && isNativeScanCleanupFoldBandV3(subject.foldBand);
    if (!isValid(candidate)) {
        throw new Error('invalid scan-cleanup split diagnostics');
    }
    return candidate;
}

export function decodeScanCleanupDetectionJobState(value: unknown): TScanCleanupDetectionJobState | null {
    if (value === null) {
        return null;
    }
    if (
        !isRecord(value)
        || typeof value.jobId !== 'string'
        || (value.documentCanvasSignature !== undefined
            && typeof value.documentCanvasSignature !== 'string')
        || typeof value.updatedAtMs !== 'number'
        || !Number.isFinite(value.updatedAtMs)
        || !isRecord(value.progress)
        || !Array.isArray(value.results)
    ) throw new Error('invalid scan-cleanup detection job state');
    const progress = SCAN_CLEANUP_PROGRESS_SCHEMA.decode(value.progress);
    const results = value.results.map(result => {
        if (
            !isRecord(result)
            || ![
                'single-uncut-page',
                'page-with-offcut',
                'two-page-spread',
            ].includes(String(result.classification))
            || (result.revision !== undefined && (
                typeof result.revision !== 'number'
                || !Number.isInteger(result.revision)
                || result.revision < 1
            ))
            || !(result.cutterXPx === null || typeof result.cutterXPx === 'number' && Number.isFinite(result.cutterXPx))
            || (result.tier1Verdict !== undefined && !isLayoutClassification(result.tier1Verdict))
            || (result.reconciled !== undefined && typeof result.reconciled !== 'boolean')
            || (result.clusterAgreement !== undefined && (
                typeof result.clusterAgreement !== 'number'
                || !Number.isFinite(result.clusterAgreement)
                || result.clusterAgreement < -1
                || result.clusterAgreement > 1
            ))
            || (result.textAxis !== undefined && (
                !isRecord(result.textAxis)
                || Object.keys(result.textAxis).some(key => key !== 'sideways' && key !== 'confidence')
                || typeof result.textAxis.sideways !== 'boolean'
                || typeof result.textAxis.confidence !== 'number'
                || !Number.isFinite(result.textAxis.confidence)
                || result.textAxis.confidence < 0
                || result.textAxis.confidence > 1
            ))
            || (result.recommendedOutputMode !== undefined
                && !isScanCleanupOutputMode(result.recommendedOutputMode))
            || (result.recommendedOutputModeConfidence !== undefined && (
                typeof result.recommendedOutputModeConfidence !== 'number'
                || !Number.isFinite(result.recommendedOutputModeConfidence)
                || result.recommendedOutputModeConfidence < 0
                || result.recommendedOutputModeConfidence > 1
            ))
            || (result.recommendedOutputModeReason !== undefined
                && !isScanCleanupOutputModeRecommendationReason(result.recommendedOutputModeReason))
            || (result.softAlphaForegroundRecommendation !== undefined
                && typeof result.softAlphaForegroundRecommendation !== 'boolean')
        ) throw new Error('invalid scan-cleanup detection result');
        const pageNumber = decodePositiveInteger(result.pageNumber, 'detection page number');
        const sourcePageMetadata = result.sourcePageMetadata === undefined
            ? undefined
            : decodeSourcePageMetadata(result.sourcePageMetadata);
        if (
            sourcePageMetadata !== undefined
            && sourcePageMetadata.pageNumber !== result.pageNumber
        ) {
            throw new Error('invalid scan-cleanup detection source page metadata');
        }
        const pagePlanEvidence = result.pagePlanEvidence === undefined
            ? undefined
            : decodeScanCleanupPagePlanEvidence(result.pagePlanEvidence, pageNumber);
        const splitDiagnostics = result.splitDiagnostics === undefined
            ? undefined
            : decodeSplitDiagnostics(result.splitDiagnostics);
        return {
            pageNumber,
            ...(result.revision === undefined ? {} : {revision: result.revision}),
            classification: result.classification as TScanCleanupDetectionJobState['results'][number]['classification'],
            confidence: decodeUnitInterval(result.confidence, 'detection confidence'),
            cutterXPx: result.cutterXPx,
            tier1Verdict: isLayoutClassification(result.tier1Verdict)
                ? result.tier1Verdict
                : result.classification as TScanCleanupDetectionJobState['results'][number]['tier1Verdict'],
            reconciled: result.reconciled === true,
            clusterAgreement: result.clusterAgreement === undefined
                ? 0
                : (() => {
                    const agreement = decodeFiniteNumber(result.clusterAgreement, 'detection cluster agreement');
                    if (agreement < -1 || agreement > 1) throw new Error('invalid scan-cleanup detection cluster agreement');
                    return agreement;
                })(),
            documentPrior: result.documentPrior === null || result.documentPrior === undefined
                ? null
                : decodeDocumentPrior(result.documentPrior),
            ...(isRecord(result.textAxis) ? {textAxis: {
                sideways: result.textAxis.sideways as boolean,
                confidence: result.textAxis.confidence as number,
            }} : {}),
            ...(isScanCleanupOutputMode(result.recommendedOutputMode)
                ? {recommendedOutputMode: result.recommendedOutputMode}
                : {}),
            ...(typeof result.recommendedOutputModeConfidence === 'number'
                ? {recommendedOutputModeConfidence: result.recommendedOutputModeConfidence}
                : {}),
            ...(isScanCleanupOutputModeRecommendationReason(result.recommendedOutputModeReason)
                ? {recommendedOutputModeReason: result.recommendedOutputModeReason}
                : {}),
            ...(typeof result.softAlphaForegroundRecommendation === 'boolean'
                ? {softAlphaForegroundRecommendation: result.softAlphaForegroundRecommendation}
                : {}),
            ...(sourcePageMetadata === undefined ? {} : {sourcePageMetadata}),
            ...(pagePlanEvidence === undefined ? {} : {pagePlanEvidence}),
            ...(splitDiagnostics === undefined ? {} : {splitDiagnostics}),
        };
    });
    if (
        results.length > progress.totalUnits
        || (value.status === 'completed' && results.length !== progress.completedUnits)
    ) throw new Error('invalid scan-cleanup detection result count');
    const base = {
        jobId: value.jobId,
        ...(typeof value.documentCanvasSignature === 'string'
            ? {documentCanvasSignature: value.documentCanvasSignature}
            : {}),
        progress,
        results,
        updatedAtMs: value.updatedAtMs,
    };
    if (value.status === 'queued' || value.status === 'running' || value.status === 'canceling' || value.status === 'completed' || value.status === 'canceled') {
        return {
            ...base,
            status: value.status,
        };
    }
    if (value.status === 'failed') {
        if (typeof value.error !== 'string' || !isScanCleanupErrorCode(value.errorCode)) {
            throw new Error('failed scan-cleanup detection state requires a typed error');
        }
        return {
            ...base,
            status: 'failed',
            error: value.error,
            errorCode: value.errorCode,
        };
    }
    throw new Error('invalid scan-cleanup detection job status');
}
