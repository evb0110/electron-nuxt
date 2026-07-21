import {
    describe,
    expect,
    it,
} from 'vitest';
import {reactive} from 'vue';
import {
    DEFAULT_SCAN_CLEANUP_PREFERENCES,
    dismissScanCleanupFirstRunGuidance,
    loadScanCleanupDocumentOverrides,
    loadScanCleanupPreferences,
    resetScanCleanupDocumentOverrides,
    saveScanCleanupDocumentOverrides,
    saveScanCleanupPreferences,
    toPlainScanCleanupOptions,
    type IScanCleanupPreferenceStorage,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferences';

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
            marginsMm: 9,
            runOcrAfterCleanup: true,
        }, storage);
        expect(loadScanCleanupPreferences(storage)).toMatchObject({
            readingOrder: 'rtl',
            marginsMm: 9,
            runOcrAfterCleanup: true,
        });
    });

    it('isolates per-document overrides and removes them on reset', () => {
        const storage = memoryStorage();
        saveScanCleanupDocumentOverrides('document-a', {'2': {
            rotation: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplitX: 480,
        }}, storage);
        expect(loadScanCleanupDocumentOverrides('document-a', storage)['2']).toMatchObject({rotation: 90});
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
            rotation: 90 as const,
            layoutOverride: 'spread' as const,
            excluded: false,
            manualSplitX: 480,
        };
        const overrides = reactive({'2': pageOverride});

        expect(() => saveScanCleanupDocumentOverrides('document-a', overrides, storage)).not.toThrow();
        expect(loadScanCleanupDocumentOverrides('document-a', storage)).toEqual({'2': {
            rotation: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplitX: 480,
        }});
    });

    it('converts reactive cleanup options into structured-clone-safe data', () => {
        const options = reactive({
            ...DEFAULT_SCAN_CLEANUP_PREFERENCES,
            pageOverrides: {'2': {
                rotation: 90 as const,
                layoutOverride: 'spread' as const,
                excluded: false,
                manualSplitX: 480,
            }},
        });

        const plainOptions = toPlainScanCleanupOptions(options);

        expect(() => structuredClone(plainOptions)).not.toThrow();
        expect(plainOptions.pageOverrides['2']).toEqual({
            rotation: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplitX: 480,
        });
    });

    it('falls back safely from malformed persisted values', () => {
        const storage: IScanCleanupPreferenceStorage = {
            get: () => '{bad json',
            set: () => undefined,
        };
        expect(loadScanCleanupPreferences(storage)).toEqual(DEFAULT_SCAN_CLEANUP_PREFERENCES);
    });
});
