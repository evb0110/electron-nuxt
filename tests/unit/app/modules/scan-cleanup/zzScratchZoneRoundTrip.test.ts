// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest';
import {
    loadScanCleanupDocumentOverrides,
    saveScanCleanupDocumentOverrides,
} from '@app/modules/scan-cleanup/persistence/preferencesRepository';

describe('scratch: manual zone persistence round trip', () => {
    it('keeps manual zones through save and load', () => {
        const store = new Map<string, string>();
        const storage = {
            get: (key: string) => store.get(key) ?? null,
            set: (key: string, value: string) => void store.set(key, value),
        };
        const manualZones = {
            picture: [{
                layer: 'photo' as const,
                polygon: {
                    points: [
                        {xNormalized: 0.1, yNormalized: 0.1},
                        {xNormalized: 0.4, yNormalized: 0.1},
                        {xNormalized: 0.4, yNormalized: 0.4},
                    ],
                    rotationDegrees: 0 as const,
                },
            }],
            fill: [],
        };
        saveScanCleanupDocumentOverrides('/doc.pdf', {'1': {
            rotationDegrees: 0,
            layoutOverride: 'auto',
            excluded: false,
            manualSplit: null,
            manualZones,
        }}, storage);
        const loaded = loadScanCleanupDocumentOverrides('/doc.pdf', storage);
        expect({stored: store.get('evb.scanCleanup.documentOverrides.v1'), loaded}).toBe('REVEAL');
    });
});
