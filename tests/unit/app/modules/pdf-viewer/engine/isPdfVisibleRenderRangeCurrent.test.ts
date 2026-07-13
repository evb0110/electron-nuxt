import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isPdfVisibleRenderRangeCurrent,
    resolvePdfProtectedVisibleRange,
} from '@app/modules/pdf-viewer/engine/pdf-visible-render-range-policy/isPdfVisibleRenderRangeCurrent';

describe('isPdfVisibleRenderRangeCurrent', () => {
    it('accepts a pending navigation target before the committed viewport moves', () => {
        expect(isPdfVisibleRenderRangeCurrent({
            range: {
                start: 7,
                end: 7,
            },
            visibleRange: {
                start: 1,
                end: 1,
            },
            navigationTargetPage: 7,
            viewMode: 'single',
            totalPages: 120,
        })).toBe(true);
    });

    it('rejects the old committed viewport while another target owns rendering', () => {
        expect(isPdfVisibleRenderRangeCurrent({
            range: {
                start: 1,
                end: 1,
            },
            visibleRange: {
                start: 1,
                end: 1,
            },
            navigationTargetPage: 21,
            viewMode: 'single',
            totalPages: 120,
        })).toBe(false);
    });

    it('accepts either page in the pending target spread', () => {
        expect(isPdfVisibleRenderRangeCurrent({
            range: {
                start: 9,
                end: 9,
            },
            visibleRange: {
                start: 1,
                end: 1,
            },
            navigationTargetPage: 10,
            viewMode: 'facing',
            totalPages: 120,
        })).toBe(true);
    });

    it('protects the pending target instead of the stale committed viewport', () => {
        expect(resolvePdfProtectedVisibleRange({
            visibleRange: {
                start: 1,
                end: 1,
            },
            navigationTargetPage: 21,
            viewMode: 'single',
            totalPages: 120,
        })).toEqual({
            start: 21,
            end: 21,
        });
    });
});
