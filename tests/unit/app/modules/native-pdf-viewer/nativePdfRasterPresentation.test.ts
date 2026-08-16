import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createNativePdfRasterIdentity,
    isTrustedNativePdfRasterWidthCeiling,
    nativePdfRasterIdentityCovers,
    nativePdfRasterOutputCoversRequest,
    resolveNativePdfRasterTargetWidth,
    shouldInvalidateNativePdfRaster,
    shouldPresentNativePdfPageSkeleton,
} from '@app/modules/native-pdf-viewer/runtime/nativePdfRasterPresentation';

describe('native PDF raster presentation', () => {
    it('canonicalizes targets at a learned raster ceiling without raising smaller requests', () => {
        expect(resolveNativePdfRasterTargetWidth(3_598, 2_008)).toBe(2_008);
        expect(resolveNativePdfRasterTargetWidth(1_600, 2_008)).toBe(1_600);
        expect(resolveNativePdfRasterTargetWidth(3_598, undefined)).toBe(3_598);
        expect(resolveNativePdfRasterTargetWidth(6_000, 4_096)).toBe(4_096);
        expect(nativePdfRasterOutputCoversRequest(4_096, 6_000, 4_096)).toBe(true);
        expect(nativePdfRasterOutputCoversRequest(4_095, 6_000, 4_096)).toBe(false);
        expect(nativePdfRasterOutputCoversRequest(640, 1_200, 4_096)).toBe(false);
        expect(nativePdfRasterOutputCoversRequest(640, 1_200, null)).toBe(false);
        expect(nativePdfRasterOutputCoversRequest(640, 1_200, 0)).toBe(false);
        expect(nativePdfRasterOutputCoversRequest(640, 1_200, Number.NaN)).toBe(false);
        expect(isTrustedNativePdfRasterWidthCeiling(undefined)).toBe(true);
        expect(isTrustedNativePdfRasterWidthCeiling(null)).toBe(false);
        expect(isTrustedNativePdfRasterWidthCeiling(4_096)).toBe(true);
        expect(isTrustedNativePdfRasterWidthCeiling(2_008)).toBe(false);

        const firstZoom = createNativePdfRasterIdentity({
            generation: 2,
            pageNumber: 1,
            pageWidth: 481.92,
            pageHeight: 765.36,
            targetWidthPx: resolveNativePdfRasterTargetWidth(3_598, 2_008),
        });
        expect(firstZoom.targetWidthPx).toBe(2_008);
    });

    it('treats target pixel width as part of the canonical raster identity', () => {
        const committed = createNativePdfRasterIdentity({
            generation: 7,
            pageNumber: 2,
            pageWidth: 612,
            pageHeight: 792,
            targetWidthPx: 1_224,
        });
        const zoomedTarget = createNativePdfRasterIdentity({
            ...committed,
            targetWidthPx: 1_836,
        });

        expect(shouldInvalidateNativePdfRaster({
            status: 'loaded',
            hasObjectUrl: true,
            requestedIdentity: committed,
            committedIdentity: committed,
            targetIdentity: zoomedTarget,
        })).toBe(true);
    });

    it('keeps a wider raster when the stabilized viewport needs fewer pixels', () => {
        const requestedBeforeScrollbar = createNativePdfRasterIdentity({
            generation: 8,
            pageNumber: 1,
            pageWidth: 612,
            pageHeight: 972,
            targetWidthPx: 3_658,
        });
        const stabilizedTarget = createNativePdfRasterIdentity({
            ...requestedBeforeScrollbar,
            targetWidthPx: 3_628,
        });

        expect(nativePdfRasterIdentityCovers(requestedBeforeScrollbar, stabilizedTarget)).toBe(true);
        expect(nativePdfRasterIdentityCovers(stabilizedTarget, requestedBeforeScrollbar)).toBe(false);
        expect(shouldInvalidateNativePdfRaster({
            status: 'loading',
            hasObjectUrl: false,
            requestedIdentity: requestedBeforeScrollbar,
            committedIdentity: null,
            targetIdentity: stabilizedTarget,
        })).toBe(false);
        expect(shouldInvalidateNativePdfRaster({
            status: 'loaded',
            hasObjectUrl: true,
            requestedIdentity: requestedBeforeScrollbar,
            committedIdentity: requestedBeforeScrollbar,
            targetIdentity: stabilizedTarget,
        })).toBe(false);
    });

    it('invalidates an in-flight render when fit geometry changes its target', () => {
        const requested = createNativePdfRasterIdentity({
            generation: 3,
            pageNumber: 1,
            pageWidth: 800,
            pageHeight: 1_200,
            targetWidthPx: 900,
        });
        const resizedTarget = createNativePdfRasterIdentity({
            ...requested,
            targetWidthPx: 1_100,
        });

        expect(shouldInvalidateNativePdfRaster({
            status: 'loading',
            hasObjectUrl: false,
            requestedIdentity: requested,
            committedIdentity: null,
            targetIdentity: resizedTarget,
        })).toBe(true);
        expect(shouldInvalidateNativePdfRaster({
            status: 'loading',
            hasObjectUrl: false,
            requestedIdentity: resizedTarget,
            committedIdentity: null,
            targetIdentity: resizedTarget,
        })).toBe(false);
    });

    it('keeps every pending resident page skeleton-covered on a ready surface', () => {
        expect(shouldPresentNativePdfPageSkeleton({
            surfaceReady: true,
            visualCommitted: false,
        })).toBe(true);
        expect(shouldPresentNativePdfPageSkeleton({
            surfaceReady: true,
            visualCommitted: true,
        })).toBe(false);
        expect(shouldPresentNativePdfPageSkeleton({
            surfaceReady: false,
            visualCommitted: false,
        })).toBe(false);
        expect(shouldPresentNativePdfPageSkeleton({
            residentVisualInvalidated: true,
            surfaceReady: false,
            visualCommitted: false,
        })).toBe(true);
        expect(shouldPresentNativePdfPageSkeleton({
            openingSurfaceVisible: true,
            residentVisualInvalidated: true,
            surfaceReady: false,
            visualCommitted: false,
        })).toBe(false);
    });
});
