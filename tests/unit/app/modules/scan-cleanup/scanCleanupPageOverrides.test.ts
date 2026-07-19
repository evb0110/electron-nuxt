import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createScanCleanupPageOverride,
    estimateScanCleanupOutputPages,
    getScanCleanupPageOverride,
    resolveScanCleanupPageLayout,
    setScanCleanupPageOverride,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPageOverrides';

describe('scan cleanup page overrides', () => {
    it('merges sparse page values over stable defaults and removes reset entries', () => {
        const overrides = {};
        expect(getScanCleanupPageOverride(overrides, 3)).toEqual({
            rotation: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplitX: null,
        });
        setScanCleanupPageOverride(overrides, 3, createScanCleanupPageOverride({
            rotation: 90,
            manualSplitX: 412.5,
        }));
        expect(getScanCleanupPageOverride(overrides, 3)).toMatchObject({
            rotation: 90,
            manualSplitX: 412.5,
        });
        setScanCleanupPageOverride(overrides, 3, createScanCleanupPageOverride());
        expect(overrides).toEqual({});
    });

    it('maps authoritative layout overrides onto document defaults', () => {
        expect(resolveScanCleanupPageLayout('auto', 'spread')).toBe('force-two-page');
        expect(resolveScanCleanupPageLayout('force-two-page', 'single')).toBe('force-single');
        expect(resolveScanCleanupPageLayout('auto', 'keep-right')).toBe('keep-right');
        expect(resolveScanCleanupPageLayout('force-single', 'auto')).toBe('force-single');
    });

    it('accounts exactly for exclusions and forced output counts', () => {
        const classifications = new Map([
            [
                1,
                'two-page-spread' as const,
            ],
            [
                4,
                'single-uncut-page' as const,
            ],
        ]);
        const pageOverrides = {
            '2': createScanCleanupPageOverride({excluded: true}),
            '3': createScanCleanupPageOverride({layoutOverride: 'spread'}),
            '4': createScanCleanupPageOverride({layoutOverride: 'keep-left'}),
        };
        expect(estimateScanCleanupOutputPages(4, {
            layoutMode: 'auto',
            pageOverrides,
        }, classifications)).toEqual({
            exact: true,
            outputPages: 5,
        });
    });

    it('marks the estimate approximate when blank pages may be removed', () => {
        expect(estimateScanCleanupOutputPages(2, {
            layoutMode: 'force-single',
            pageOverrides: {},
            skipBlankPages: true,
        }, new Map())).toEqual({
            exact: false,
            outputPages: 2,
        });
    });
});
