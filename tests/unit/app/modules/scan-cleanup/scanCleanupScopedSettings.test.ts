import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    createScanCleanupPageOverride,
    getScanCleanupPageOverride,
} from '@contracts/scanCleanupPageOverrides';
import {resolveScanCleanupApplyScope} from '@app/modules/scan-cleanup/runtime/resolveScanCleanupApplyScope';
import {
    resolveScanCleanupMixedValue,
    updateScanCleanupPageOverrides,
} from '@app/modules/scan-cleanup/runtime/scanCleanupSelectionOverrides';

describe('scan cleanup apply scopes', () => {
    it('resolves all pages and from-here at the first and last page', () => {
        const selection = new Set([
            2,
            4,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 1,
            pageCount: 6,
            selectedPages: selection,
        }, 'all')]).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 1,
            pageCount: 6,
            selectedPages: selection,
        }, 'from-here')]).toEqual([
            1,
            2,
            3,
            4,
            5,
            6,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 6,
            pageCount: 6,
            selectedPages: selection,
        }, 'from-here')]).toEqual([6]);
    });

    it('keeps only valid selected pages in natural order', () => {
        expect([...resolveScanCleanupApplyScope({
            leader: 3,
            pageCount: 5,
            selectedPages: new Set([
                5,
                0,
                3,
                8,
                1,
            ]),
        }, 'selected')]).toEqual([
            1,
            3,
            5,
        ]);
    });

    it('uses the first, last, odd, and even leader parity for every-other-page scope', () => {
        const selectedPages = new Set<number>();
        expect([...resolveScanCleanupApplyScope({
            leader: 1,
            pageCount: 6,
            selectedPages,
        }, 'every-other')]).toEqual([
            1,
            3,
            5,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 3,
            pageCount: 6,
            selectedPages,
        }, 'every-other')]).toEqual([
            1,
            3,
            5,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 4,
            pageCount: 6,
            selectedPages,
        }, 'every-other')]).toEqual([
            2,
            4,
            6,
        ]);
        expect([...resolveScanCleanupApplyScope({
            leader: 6,
            pageCount: 6,
            selectedPages,
        }, 'every-other')]).toEqual([
            2,
            4,
            6,
        ]);
    });
});

describe('scan cleanup selection override state', () => {
    it('detects uniform, scalar-mixed, and nested mixed values', () => {
        expect(resolveScanCleanupMixedValue([
            90,
            90,
        ])).toEqual({
            empty: false,
            mixed: false,
            value: 90,
        });
        expect(resolveScanCleanupMixedValue([
            0,
            90,
        ]).mixed).toBe(true);
        expect(resolveScanCleanupMixedValue([
            {left: {
                x: 1,
                y: 2,
            }},
            {left: {
                y: 2,
                x: 1,
            }},
        ]).mixed).toBe(false);
        expect(resolveScanCleanupMixedValue([
            {left: {
                x: 1,
                y: 2,
            }},
            {left: {
                x: 2,
                y: 2,
            }},
        ]).mixed).toBe(true);
        expect(resolveScanCleanupMixedValue([])).toEqual({
            empty: true,
            mixed: false,
            value: undefined,
        });
    });

    it('writes selection edits into the row-control store without touching document defaults', () => {
        const settings = {
            layoutMode: 'force-single' as const,
            outputMode: 'color' as const,
            pageAlignment: 'top-left' as const,
            pageOverrides: {'2': createScanCleanupPageOverride({rotation: 90})},
        };
        const documentDefaults = {
            layoutMode: settings.layoutMode,
            outputMode: settings.outputMode,
            pageAlignment: settings.pageAlignment,
        };

        updateScanCleanupPageOverrides(settings.pageOverrides, new Set([
            1,
            2,
        ]), current => ({
            ...current,
            layoutOverride: 'spread',
            excluded: true,
        }));

        expect(getScanCleanupPageOverride(settings.pageOverrides, 1)).toMatchObject({
            layoutOverride: 'spread',
            excluded: true,
            rotation: 0,
        });
        expect(getScanCleanupPageOverride(settings.pageOverrides, 2)).toMatchObject({
            layoutOverride: 'spread',
            excluded: true,
            rotation: 90,
        });
        expect({
            layoutMode: settings.layoutMode,
            outputMode: settings.outputMode,
            pageAlignment: settings.pageAlignment,
        }).toEqual(documentDefaults);
    });

    it('copies the leader override unchanged to a computed scope', () => {
        const overrides = {'2': createScanCleanupPageOverride({
            rotation: 180,
            layoutOverride: 'keep-right',
            manualSplitX: 420,
            placementOverrides: {right: 'bottom-right'},
        })};
        const leader = getScanCleanupPageOverride(overrides, 2);
        const targetPages = resolveScanCleanupApplyScope({
            leader: 2,
            pageCount: 5,
            selectedPages: new Set([2]),
        }, 'every-other');
        updateScanCleanupPageOverrides(overrides, targetPages, () => leader);

        expect([...targetPages]).toEqual([
            2,
            4,
        ]);
        expect(getScanCleanupPageOverride(overrides, 4)).toEqual(leader);
        expect(getScanCleanupPageOverride(overrides, 1)).toEqual(createScanCleanupPageOverride());
    });
});
