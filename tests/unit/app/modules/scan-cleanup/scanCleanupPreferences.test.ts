import {
    describe,
    expect,
    it,
} from 'vitest';
import {reactive} from 'vue';
import {
    dismissScanCleanupFirstRunGuidance,
    loadScanCleanupDocumentMargins,
    loadScanCleanupDocumentOverrides,
    loadScanCleanupPreferences,
    resetScanCleanupDocumentOverrides,
    saveScanCleanupDocumentOverrides,
    saveScanCleanupDocumentMargins,
    saveScanCleanupPreferences,
    toPlainScanCleanupOptions,
    type IScanCleanupPreferenceStorage,
} from '@app/modules/scan-cleanup/persistence/preferencesRepository';
import {DEFAULT_SCAN_CLEANUP_PREFERENCES} from '@app/modules/scan-cleanup/persistence/preferencesSchema';

function memoryStorage(): IScanCleanupPreferenceStorage {
    const values = new Map<string, string>();
    return {
        get: key => values.get(key) ?? null,
        set: (key, value) => values.set(key, value),
    };
}

describe('scan cleanup preferences', () => {
    it('saves and restores global settings independently of page overrides', () => {
        const storage = memoryStorage();
        saveScanCleanupPreferences({
            ...DEFAULT_SCAN_CLEANUP_PREFERENCES,
            readingOrder: 'rtl',
            marginsMm: {
                leftMm: 6,
                topMm: 7,
                rightMm: 8,
                bottomMm: 9,
            },
            runOcrAfterCleanup: true,
        }, storage);
        expect(loadScanCleanupPreferences(storage)).toMatchObject({
            readingOrder: 'rtl',
            marginsMm: {
                leftMm: 6,
                topMm: 7,
                rightMm: 8,
                bottomMm: 9,
            },
            runOcrAfterCleanup: true,
        });
    });

    it('migrates the legacy scalar preference to four equal margins', () => {
        const storage = memoryStorage();
        const legacyMarginKey = `margin${'Mm'}`;
        storage.set('evb.scanCleanup.settings.v1', JSON.stringify({[legacyMarginKey]: 12}));

        expect(loadScanCleanupPreferences(storage).marginsMm).toEqual({
            leftMm: 12,
            topMm: 12,
            rightMm: 12,
            bottomMm: 12,
        });
    });

    it('clamps each persisted margin independently', () => {
        const storage = memoryStorage();
        saveScanCleanupPreferences({
            ...DEFAULT_SCAN_CLEANUP_PREFERENCES,
            marginsMm: {
                leftMm: -2,
                topMm: 4,
                rightMm: 30,
                bottomMm: 10,
            },
        }, storage);

        expect(loadScanCleanupPreferences(storage).marginsMm).toEqual({
            leftMm: 0,
            topMm: 4,
            rightMm: 25,
            bottomMm: 10,
        });
    });

    it('round-trips four document margin values independently of page overrides', () => {
        const storage = memoryStorage();
        const marginsMm = {
            leftMm: 1,
            topMm: 2,
            rightMm: 3,
            bottomMm: 4,
        };
        saveScanCleanupDocumentMargins('document-a', marginsMm, storage);
        saveScanCleanupDocumentOverrides('document-a', {'2': {
            rotationDegrees: 90,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            marginsMm: {
                leftMm: 8,
                topMm: 7,
                rightMm: 6,
                bottomMm: 5,
            },
        }}, storage);

        expect(loadScanCleanupDocumentMargins('document-a', storage)).toEqual(marginsMm);
        expect(loadScanCleanupDocumentOverrides('document-a', storage)['2']).toMatchObject({
            rotationDegrees: 90,
            marginsMm: {
                leftMm: 8,
                topMm: 7,
                rightMm: 6,
                bottomMm: 5,
            },
        });
        resetScanCleanupDocumentOverrides('document-a', storage);
        expect(loadScanCleanupDocumentOverrides('document-a', storage)).toEqual({});
        expect(loadScanCleanupDocumentMargins('document-a', storage)).toEqual(marginsMm);
    });

    it('isolates per-document overrides and removes them on reset', () => {
        const storage = memoryStorage();
        saveScanCleanupDocumentOverrides('document-a', {'2': {
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: {
                xNormalized: 0.4,
                rotationDegrees: 90,
            },
        }}, storage);
        expect(loadScanCleanupDocumentOverrides('document-a', storage)['2']).toMatchObject({rotationDegrees: 90});
        expect(loadScanCleanupDocumentOverrides('document-b', storage)).toEqual({});
        resetScanCleanupDocumentOverrides('document-a', storage);
        expect(loadScanCleanupDocumentOverrides('document-a', storage)).toEqual({});
    });

    it('persists first-run guidance dismissal with the existing preferences', () => {
        const storage = memoryStorage();

        expect(loadScanCleanupPreferences(storage).firstRunGuidanceDismissed).toBe(false);
        dismissScanCleanupFirstRunGuidance(storage);
        expect(loadScanCleanupPreferences(storage).firstRunGuidanceDismissed).toBe(true);
    });

    it('persists Vue-reactive page overrides as plain JSON data', () => {
        const storage = memoryStorage();
        const pageOverride = {
            rotationDegrees: 90 as const,
            layoutOverride: 'spread' as const,
            excluded: false,
            manualSplit: {
                xNormalized: 0.4,
                rotationDegrees: 90 as const,
            },
        };
        const overrides = reactive({'2': pageOverride});

        expect(() => saveScanCleanupDocumentOverrides('document-a', overrides, storage)).not.toThrow();
        expect(loadScanCleanupDocumentOverrides('document-a', storage)).toEqual({'2': {
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: {
                xNormalized: 0.4,
                rotationDegrees: 90,
            },
        }});
    });

    it('migrates legacy pixel overrides with known 150-DPI raster dimensions', () => {
        const storage = memoryStorage();
        storage.set('evb.scanCleanup.documentOverrides.v1', JSON.stringify({'document-a': {
            updatedAt: 1,
            rasterDimensionsByPage: {'2': {
                width: 1200,
                height: 800,
            }},
            overrides: {'2': {
                rotationDegrees: 90,
                layoutOverride: 'spread',
                excluded: false,
                manualSplit: 320,
                manualContentBoxes: {left: {
                    x: 80,
                    y: 120,
                    width: 400,
                    height: 600,
                }},
            }},
        }}));

        expect(loadScanCleanupDocumentOverrides('document-a', storage)).toEqual({'2': {
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: {
                xNormalized: 0.4,
                rotationDegrees: 90,
            },
            manualContentBoxes: {left: {
                xNormalized: 0.1,
                yNormalized: 0.1,
                widthNormalized: 0.5,
                heightNormalized: 0.5,
                rotationDegrees: 90,
            }},
        }});
    });

    it('drops legacy pixel geometry when its 150-DPI raster dimensions are unavailable', () => {
        const storage = memoryStorage();
        storage.set('evb.scanCleanup.documentOverrides.v1', JSON.stringify({'document-a': {
            updatedAt: 1,
            overrides: {'2': {
                rotationDegrees: 0,
                layoutOverride: 'single',
                excluded: false,
                manualSplit: 480,
                manualContentBoxes: {full: {
                    x: 10,
                    y: 20,
                    width: 300,
                    height: 500,
                }},
            }},
        }}));

        expect(loadScanCleanupDocumentOverrides('document-a', storage)).toEqual({'2': {
            rotationDegrees: 0,
            layoutOverride: 'single',
            excluded: false,
            manualSplit: null,
        }});
    });

    it('converts reactive cleanup options into structured-clone-safe data', () => {
        const options = reactive({
            ...DEFAULT_SCAN_CLEANUP_PREFERENCES,
            pageOverrides: {'2': {
                rotationDegrees: 90 as const,
                layoutOverride: 'spread' as const,
                excluded: false,
                manualSplit: null,
            }},
        });

        const plainOptions = toPlainScanCleanupOptions(options);

        expect(() => structuredClone(plainOptions)).not.toThrow();
        expect(plainOptions.pageOverrides['2']).toEqual({
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: null,
        });
    });

    it('falls back safely from malformed persisted values', () => {
        const storage: IScanCleanupPreferenceStorage = {
            get: () => '{bad json',
            set: () => undefined,
        };
        expect(loadScanCleanupPreferences(storage)).toEqual(DEFAULT_SCAN_CLEANUP_PREFERENCES);
    });

    it('rejects non-finite persisted numeric preferences', () => {
        const storage = memoryStorage();
        storage.set('evb.scanCleanup.settings.v1', '{"thickness":1e400,"marginsMm":{"leftMm":1e400}}');

        expect(loadScanCleanupPreferences(storage)).toMatchObject({
            thickness: DEFAULT_SCAN_CLEANUP_PREFERENCES.thickness,
            marginsMm: DEFAULT_SCAN_CLEANUP_PREFERENCES.marginsMm,
        });
    });

    it('rejects non-finite numeric preferences before persistence', () => {
        const storage = memoryStorage();

        expect(() => saveScanCleanupPreferences({
            ...DEFAULT_SCAN_CLEANUP_PREFERENCES,
            marginsMm: {
                ...DEFAULT_SCAN_CLEANUP_PREFERENCES.marginsMm,
                leftMm: Number.NaN,
            },
        }, storage)).toThrow('finite numeric values');
        expect(storage.get('evb.scanCleanup.settings.v1')).toBeNull();
    });

    it('drops non-finite override geometry instead of serializing JSON nulls', () => {
        const storage = memoryStorage();
        saveScanCleanupDocumentOverrides('document-a', {'1': {
            rotationDegrees: 0,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: {
                xNormalized: Number.POSITIVE_INFINITY,
                rotationDegrees: 0,
            },
        }}, storage);

        expect(loadScanCleanupDocumentOverrides('document-a', storage)['1']?.manualSplit).toBeNull();
    });
});
