// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createApp,
    defineComponent,
    h,
    nextTick,
} from 'vue';
import {BrowserLogger} from '@app/utils/browserLogger';
import {createDefaultScanCleanupSettingsFile} from '@contracts/scanCleanupSettings';
import {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/runtime/discardScanCleanupDocumentState';
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

    it('does not flush a debounced override patch after document discard', async () => {
        const sourceSha256 = 'c'.repeat(64);
        const documentKey = '/documents/discard-after-edit.pdf';
        let settings: ReturnType<typeof useScanCleanupDocumentSettings> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => `${documentKey}\0revision-1`),
                legacyDocumentKey: computed(() => documentKey),
                sourceSha256: computed(() => sourceSha256),
            });
            return () => h('div');
        }}));
        app.mount(host);
        await whenScanCleanupPreferencesReady();
        await nextTick();
        vi.clearAllMocks();
        capability.value.updateSettings.mockResolvedValue(createDefaultScanCleanupSettingsFile());

        settings!.values.pageOverrides = {'1': {
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: null,
        }};
        await nextTick();
        discardScanCleanupDocumentState(documentKey, sourceSha256);
        app.unmount();
        host.remove();

        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalled());
        const documentUpdates = capability.value.updateSettings.mock.calls
            .map(([request]) => request)
            .filter(request => 'document' in request);
        expect(documentUpdates).toEqual([{document: {
            sourceSha256,
            legacyDocumentKey: documentKey,
            patch: {resetOverrides: true},
        }}]);
    });
});
