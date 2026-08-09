import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createNativePdfRasterIdentity,
    nativePdfRasterIdentityMatches,
    resolveNativePdfRasterTargetWidth,
    shouldInvalidateNativePdfRaster,
    shouldPresentNativePdfPageSkeleton,
} from '@app/modules/native-pdf-viewer/runtime/nativePdfRasterPresentation';

describe('native PDF raster presentation', () => {
    it('canonicalizes targets at a learned raster ceiling without raising smaller requests', () => {
        expect(resolveNativePdfRasterTargetWidth(3_598, 2_008)).toBe(2_008);
        expect(resolveNativePdfRasterTargetWidth(1_600, 2_008)).toBe(1_600);
        expect(resolveNativePdfRasterTargetWidth(3_598, undefined)).toBe(3_598);

        const firstZoom = createNativePdfRasterIdentity({
            generation: 2,
            pageNumber: 1,
            pageWidth: 481.92,
            pageHeight: 765.36,
            targetWidthPx: resolveNativePdfRasterTargetWidth(3_598, 2_008),
        });
        const higherZoom = createNativePdfRasterIdentity({
            ...firstZoom,
            targetWidthPx: resolveNativePdfRasterTargetWidth(4_096, 2_008),
        });
        const lowerZoom = createNativePdfRasterIdentity({
            ...firstZoom,
            targetWidthPx: resolveNativePdfRasterTargetWidth(1_600, 2_008),
        });

        expect(nativePdfRasterIdentityMatches(firstZoom, higherZoom)).toBe(true);
        expect(nativePdfRasterIdentityMatches(firstZoom, lowerZoom)).toBe(false);
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

        expect(nativePdfRasterIdentityMatches(committed, zoomedTarget)).toBe(false);
        expect(nativePdfRasterIdentityMatches(committed, {
            ...committed,
            generation: committed.generation + 1,
        })).toBe(false);
        expect(nativePdfRasterIdentityMatches(committed, {
            ...committed,
            pageWidth: committed.pageHeight,
            pageHeight: committed.pageWidth,
        })).toBe(false);
        expect(shouldInvalidateNativePdfRaster({
            status: 'loaded',
            hasObjectUrl: true,
            requestedIdentity: committed,
            committedIdentity: committed,
            targetIdentity: zoomedTarget,
        })).toBe(true);
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

    it('projects skeleton presentation only from the shared viewport session target', () => {
        const skeleton = {
            kind: 'page' as const,
            generation: 4,
            pageNumber: 9,
            presentation: 'skeleton' as const,
            frameKey: null,
            error: null,
        };

        expect(shouldPresentNativePdfPageSkeleton({
            visual: skeleton,
            pageNumber: 9,
            surfaceReady: true,
            visualCommitted: false,
        })).toBe(true);
        expect(shouldPresentNativePdfPageSkeleton({
            visual: skeleton,
            pageNumber: 8,
            surfaceReady: true,
            visualCommitted: false,
        })).toBe(false);
        expect(shouldPresentNativePdfPageSkeleton({
            visual: {
                ...skeleton,
                presentation: 'cold-shell',
            },
            pageNumber: 9,
            surfaceReady: true,
            visualCommitted: false,
        })).toBe(false);
        expect(shouldPresentNativePdfPageSkeleton({
            visual: skeleton,
            pageNumber: 9,
            surfaceReady: true,
            visualCommitted: true,
        })).toBe(false);
        expect(shouldPresentNativePdfPageSkeleton({
            visual: skeleton,
            pageNumber: 9,
            surfaceReady: false,
            visualCommitted: false,
        })).toBe(false);
        expect(shouldPresentNativePdfPageSkeleton({
            residentVisualInvalidated: true,
            visual: {
                ...skeleton,
                presentation: 'cold-shell',
            },
            pageNumber: 9,
            surfaceReady: false,
            visualCommitted: false,
        })).toBe(true);
    });
});
