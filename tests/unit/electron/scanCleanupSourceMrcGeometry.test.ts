import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    sourceMrcForegroundPdfMatrix,
    type IRenderedCleanupOutputPage,
} from '@scan-cleanup-core/assembleCompactScanCleanupPages';

function output(overrides: Partial<IRenderedCleanupOutputPage['metadata']> = {}) {
    return {
        sourcePageNumber: 1,
        path: '/cleaned.png',
        dpi: 300,
        resolvedOutputMode: 'mixed' as const,
        metadata: {
            inputWidthPx: 1_000,
            inputHeightPx: 1_000,
            outputWidthPx: 1_000,
            outputHeightPx: 1_000,
            intrinsicRasterWidthPx: 1_100,
            intrinsicRasterHeightPx: 1_000,
            matchedCanvasContentWidthPx: 1_100,
            matchedCanvasContentHeightPx: 1_000,
            canvasWidthPx: 1_000,
            canvasHeightPx: 1_000,
            placementOffsetXPx: 0,
            placementOffsetYPx: 0,
            matchedCanvasIntrinsicOverflowLeftPx: 80,
            matchedCanvasIntrinsicOverflowTopPx: 20,
            forwardTransform: {matrix: [
                [
                    1,
                    0,
                    0,
                ],
                [
                    0,
                    1,
                    0,
                ],
                [
                    0,
                    0,
                    1,
                ],
            ]},
            rotationDegrees: 0,
            dewarpMapping: null,
            ...overrides,
        },
    } as IRenderedCleanupOutputPage;
}

describe('scan-cleanup source MRC geometry', () => {
    it('subtracts clipped intrinsic overflow before placing a preserved foreground', () => {
        const matrix = sourceMrcForegroundPdfMatrix(
            output(),
            {
                backgroundDpi: 100,
                backgroundPath: '/background.ppm',
                foregroundDpi: 300,
                foregroundHeight: 1_000,
                foregroundPath: '/foreground.jp2',
                foregroundWidth: 1_000,
                selectionMaskDecode: 'default',
                selectionMaskPath: '/selection.jb2e',
            },
            100,
            100,
        );

        expect(matrix).toEqual([
            100,
            -0,
            -0,
            100,
            -8,
            2,
        ]);
    });
});
