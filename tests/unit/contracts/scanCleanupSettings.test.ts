import {
    describe,
    expect,
    it,
} from 'vitest';
import {SCAN_CLEANUP_INPUT_MAX_PAGES} from '@contracts/scan-cleanup/inputLimits';
import {
    createDefaultScanCleanupSettingsFile,
    decodeScanCleanupSettingsFile,
    SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES,
} from '@contracts/scanCleanupSettings';

const pageOverride = {
    rotationDegrees: 0,
    layoutOverride: 'auto',
    excluded: false,
    manualSplit: null,
};

function sourceHash(index: number) {
    return index.toString(16).padStart(64, '0');
}

function pageOverrides(count: number) {
    return Object.fromEntries(Array.from({length: count}, (_, index) => [
        String(index + 1),
        pageOverride,
    ]));
}

describe('scan-cleanup settings file decoder', () => {
    it('drops one corrupt document entry while preserving valid siblings', () => {
        const validOverrides = {'1': pageOverride};
        const firstValidHash = 'a'.repeat(64);
        const corruptHash = 'b'.repeat(64);
        const secondValidHash = 'c'.repeat(64);

        const decoded = decodeScanCleanupSettingsFile({
            ...createDefaultScanCleanupSettingsFile(),
            documentOverrides: {
                [firstValidHash]: {
                    overrides: validOverrides,
                    lastUsedAtMs: 10,
                },
                [corruptHash]: {
                    overrides: {'01': pageOverride},
                    lastUsedAtMs: 20,
                },
                [secondValidHash]: {
                    outputMode: 'grayscale',
                    lastUsedAtMs: 30,
                },
            },
        });

        expect(decoded.documentOverrides).toEqual({
            [firstValidHash]: {
                overrides: validOverrides,
                lastUsedAtMs: 10,
            },
            [secondValidHash]: {
                outputMode: 'grayscale',
                lastUsedAtMs: 30,
            },
        });
    });

    it('gives every legal document entry its own page budget', () => {
        const pagesPerDocument = Math.floor(
            SCAN_CLEANUP_INPUT_MAX_PAGES / SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES,
        ) + 1;
        const overrides = pageOverrides(pagesPerDocument);
        const documentOverrides = Object.fromEntries(Array.from(
            {length: SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES},
            (_, index) => [
                sourceHash(index),
                {
                    overrides,
                    lastUsedAtMs: index,
                },
            ],
        ));

        const decoded = decodeScanCleanupSettingsFile({
            ...createDefaultScanCleanupSettingsFile(),
            documentOverrides,
        });

        expect(Object.keys(decoded.documentOverrides))
            .toHaveLength(SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES);
        expect(Object.keys(decoded.documentOverrides[sourceHash(0)]!.overrides!))
            .toHaveLength(pagesPerDocument);
        expect(Object.keys(decoded.documentOverrides[
            sourceHash(SCAN_CLEANUP_DOCUMENT_OVERRIDE_MAX_ENTRIES - 1)
        ]!.overrides!)).toHaveLength(pagesPerDocument);
    });
});
