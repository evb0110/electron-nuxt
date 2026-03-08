import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolveResizeAnchorPage } from '@app/modules/pdf-viewer-runtime/resizeAnchor';

describe('resolveResizeAnchorPage', () => {
    it('prefers the current page over other resize anchor candidates', () => {
        expect(resolveResizeAnchorPage({
            totalPages: 12,
            mostVisiblePage: 5,
            snapshotAnchorPage: 6,
            currentPage: 4,
        })).toBe(4);
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
