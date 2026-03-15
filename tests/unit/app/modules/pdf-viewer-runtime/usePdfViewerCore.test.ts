import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveResizeAnchorPage } from '@app/modules/pdf-viewer-runtime/resizeAnchor';
import { resolveCustomReloadZoomMultiplier } from '@app/modules/pdf-viewer-runtime/reloadZoom';

describe('resolveResizeAnchorPage', () => {
    it('prefers the current page over other resize anchor candidates', () => {
        expect(resolveResizeAnchorPage({
            totalPages: 12,
            mostVisiblePage: 5,
            snapshotAnchorPage: 6,
            currentPage: 4,
        })).toBe(4);
    });

    it('falls back to the viewport when the current page drifts too far away', () => {
        expect(resolveResizeAnchorPage({
            totalPages: 20,
            mostVisiblePage: 9,
            snapshotAnchorPage: 10,
            currentPage: 4,
        })).toBe(9);
    });

    it('falls back to the most visible page when the current page is unavailable', () => {
        expect(resolveResizeAnchorPage({
            totalPages: 12,
            mostVisiblePage: 6,
            snapshotAnchorPage: 7,
            currentPage: Number.NaN,
        })).toBe(6);
    });

    it('falls back to the snapshot anchor page when stronger candidates are unavailable', () => {
        expect(resolveResizeAnchorPage({
            totalPages: 12,
            mostVisiblePage: null,
            snapshotAnchorPage: 6,
            currentPage: Number.NaN,
        })).toBe(6);
    });

    it('falls back to the current page when other anchor candidates are unavailable', () => {
        expect(resolveResizeAnchorPage({
            totalPages: 12,
            mostVisiblePage: null,
            snapshotAnchorPage: null,
            currentPage: 4,
        })).toBe(4);
    });

    it('clamps anchor candidates into the valid page range', () => {
        expect(resolveResizeAnchorPage({
            totalPages: 3,
            mostVisiblePage: 8,
            snapshotAnchorPage: null,
            currentPage: Number.NaN,
        })).toBe(3);
    });
});

describe('resolveCustomReloadZoomMultiplier', () => {
    it('preserves the target display zoom after the fit baseline changes', () => {
        expect(resolveCustomReloadZoomMultiplier({
            currentZoom: 1,
            currentEffectiveScale: 0.47,
            targetDisplayZoom: 1.16,
        })).toBeCloseTo(2.468085, 6);
    });

    it('falls back to the target display zoom when current zoom is unusable', () => {
        expect(resolveCustomReloadZoomMultiplier({
            currentZoom: 0,
            currentEffectiveScale: 0.47,
            targetDisplayZoom: 1.16,
        })).toBe(1.16);
    });

    it('returns null when the target display zoom is invalid', () => {
        expect(resolveCustomReloadZoomMultiplier({
            currentZoom: 1,
            currentEffectiveScale: 0.47,
            targetDisplayZoom: Number.NaN,
        })).toBeNull();
    });
});
