// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {BrowserLogger} from '@app/utils/browserLogger';
import {createDefaultScanCleanupSettingsFile} from '@contracts/scanCleanupSettings';
import {
    getScanCleanupPreferencesStore,
    resetScanCleanupPreferencesStore,
    saveScanCleanupDocumentPreferencesInStore,
    whenScanCleanupPreferencesReady,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';

const capability = vi.hoisted(() => ({value: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
}}));

vi.mock('@app/utils/platform', () => ({isDesktopPlatformActive: () => true}));
vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));

describe('scan cleanup renderer preference store', () => {
    beforeEach(() => {
        resetScanCleanupPreferencesStore();
        vi.clearAllMocks();
        capability.value.getSettings.mockResolvedValue(createDefaultScanCleanupSettingsFile());
        capability.value.updateSettings.mockResolvedValue(createDefaultScanCleanupSettingsFile());
    });

    afterEach(() => {
        resetScanCleanupPreferencesStore();
    });

    it('persists a document patch under the normalized authoritative source hash', async () => {
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();

        saveScanCleanupDocumentPreferencesInStore(
            'A'.repeat(64),
            '/documents/book.pdf',
            {outputMode: 'grayscale'},
        );

        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledWith({document: {
            sourceSha256: 'a'.repeat(64),
            legacyDocumentKey: '/documents/book.pdf',
            patch: {outputMode: 'grayscale'},
        }}));
    });

    it('warns when a desktop document patch has no authoritative source hash', async () => {
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const warning = vi.spyOn(BrowserLogger, 'warn');

        saveScanCleanupDocumentPreferencesInStore(null, '/documents/book.pdf', {outputMode: 'color'});
        await Promise.resolve();

        expect(capability.value.updateSettings).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalledWith(
            'scan-cleanup',
            expect.stringContaining('persist'),
            expect.any(Function),
        );
        warning.mockRestore();
    });
});
